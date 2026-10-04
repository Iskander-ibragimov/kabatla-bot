import { type NoteInput, type NoteRow, type Repo, type User, wordKey } from "../db/repo";
import { DAILY_LIMITS, consume, refund } from "../entitlements/service";
import { type Entity, type WordLink, parseWordsAndLinks } from "./links";
import { DECK_SYSTEM, type LlmClient, LlmUnavailable, MAX, WORDS_SYSTEM, type WordCard, completeCards } from "./llm";
import { hasTatarLetters } from "./tatar";
import { transcribe } from "./transcribe";

/** A card before it is saved. `ai` is true while its translation is the model's and nobody has replaced it. */
export interface CardDraft {
  word: string; transcription: string | null; pos: string; translation: string; exampleTt: string; exampleRu: string;
  exampleSrc: string; audioFileId: string | null; sourceUrl: string | null; ai: boolean;
}
export interface Duplicate { word: string; deckTitle: string; linkAdded: boolean }
export type AddResult =
  | { kind: "ask-words"; url: string }
  | { kind: "empty" }
  | { kind: "too-long"; max: number }
  /** Today's limit of messages with words is reached: nothing was looked up, asked or stored. */
  | { kind: "limit"; max: number }
  | { kind: "duplicates-only"; duplicates: Duplicate[] }
  | { kind: "preview"; previewId: number; items: CardDraft[]; duplicates: Duplicate[]; manual: string[] }
  /** `at`: when the bot began to wait for the translation; it names this wait in the ✖️ button of the request. */
  | { kind: "manual"; word: string; others: string[]; duplicates: Duplicate[]; at: number };
export type EditResult = { kind: "edited"; previewId: number; items: CardDraft[] } | { kind: "too-long" } | { kind: "gone" };
export type GenResult = { kind: "limit" } | { kind: "failed" } | { kind: "preview"; previewId: number; topic: string; items: CardDraft[] };

interface Deps { llm: LlmClient }
/** What `users.pending_edit` holds while the bot waits for a typed translation; `at` is when the wait began. */
interface PendingManual { word: string; url: string | null; at: number }
interface PendingPreviewEdit { previewId: number; at: number }
interface Pending { manual?: PendingManual; preview?: PendingPreviewEdit }

/** What a learner may type, in characters: a line with a word or phrase, and a translation given by hand. The same limits as for the model's fields. */
export const MAX_TYPED = { line: MAX.word, translation: MAX.translation } as const;

/** A translation typed by hand, put on one line; null when it is longer than MAX_TYPED.translation. */
export function typedTranslation(text: string): string | null {
  const translation = text.replace(/\s+/g, " ").trim();
  return translation.length <= MAX_TYPED.translation ? translation : null;
}
/** For the methods that store a typed translation: the callers check the length first and ask for a shorter text. */
function storedTranslation(text: string): string {
  const translation = typedTranslation(text);
  if (translation === null) throw new Error(`translation too long: over ${MAX_TYPED.translation} characters`);
  return translation;
}

/** The fewest cards an AI deck may have. */
const MIN_DECK_CARDS = 5;
const PENDING_URL_MS = 10 * 60_000;
/**
 * How long the bot waits for a translation it asked for (the model is down, or ✏️ was pressed on a preview).
 * After that the next text is a message with words like any other: a learner who comes back later types a new word,
 * not the translation of the old one.
 */
const PENDING_EDIT_MS = 10 * 60_000;
/** A preview can be confirmed for this long; the tick deletes the older ones. */
export const PREVIEW_TTL_MS = 24 * 3_600_000;

/** Combining grave and acute accents: stress marks that come along with a copied word. `transcribe` puts its own. */
const STRESS_MARKS = /[\u0300\u0301]/g;

/** The user's lines without stress marks; a line that is left empty or repeats an earlier one is dropped. */
function cleanLines(items: WordLink[]): WordLink[] {
  const seen = new Set<string>();
  const out: WordLink[] = [];
  for (const it of items) {
    const word = it.word.replace(STRESS_MARKS, "").trim();
    const key = wordKey(word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ word, url: it.url });
  }
  return out;
}

/** A reviewed card of the catalog, copied whole, voice included; the link is the user's. */
const catalogDraft = (n: NoteRow, url: string | null): CardDraft => ({
  word: n.word, transcription: n.transcription, pos: n.pos, translation: n.translation, exampleTt: n.exampleTt, exampleRu: n.exampleRu,
  exampleSrc: n.exampleSrc, audioFileId: n.audioFileId, sourceUrl: url, ai: false,
});
/** A card of the model for `word`; the transcription is built by the rules, never taken from the model. */
const aiDraft = (c: WordCard, word: string, url: string | null): CardDraft => ({
  word, transcription: transcribe(word), pos: c.pos, translation: c.translation, exampleTt: c.exampleTt, exampleRu: c.exampleRu,
  exampleSrc: "ai", audioFileId: null, sourceUrl: url, ai: true,
});
const toNote = (d: CardDraft): NoteInput => ({
  word: d.word, transcription: d.transcription, pos: d.pos, translation: d.translation, exampleTt: d.exampleTt, exampleRu: d.exampleRu,
  exampleSrc: d.exampleSrc, audioFileId: d.audioFileId, sourceUrl: d.sourceUrl,
});

export class ContentService {
  private readonly deadlineMs: number;
  constructor(private readonly repo: Repo, private readonly deps: Deps, private readonly now: number, opts: { deadlineMs?: number } = {}) {
    this.deadlineMs = opts.deadlineMs ?? 25_000;
  }

  /**
   * Turns a message with words and links into a preview. Each line is looked for, in this order:
   * among the words the user already learns (a duplicate), in the catalog (a ready card, copied from a level that is not
   * open yet), and only then the model is asked, once for all the remaining lines. The model may restore the spelling or
   * give the Tatar word for a Russian line, so both lookups are repeated for the words it returned.
   * A message with a line of more than MAX_TYPED.line characters is answered with `too-long`, and one over the
   * daily limit of messages with words (DAILY_LIMITS.add) with `limit`.
   */
  async prepareAdd(user: User, text: string, entities: Entity[]): Promise<AddResult> {
    const parsed = parseWordsAndLinks(text, entities);
    const lines = cleanLines(parsed.items);
    if (!lines.length && !parsed.orphanUrl) return { kind: "empty" };
    // A longer line is not a word or a phrase. Nothing is looked up or stored, so a remembered link waits for the next message.
    if (lines.some((l) => l.word.length > MAX_TYPED.line)) return { kind: "too-long", max: MAX_TYPED.line };
    // From here on the message costs lookups, a request to the model and writes, so it is counted against the daily
    // limit. The same write forgets a wait for a translation that has ended and takes or forgets the remembered link.
    const patch: Partial<User> = user.pendingEdit && !this.pending(user) ? { pendingEdit: null } : {};
    if (!lines.length) Object.assign(patch, { pendingUrl: parsed.orphanUrl, pendingUrlAt: this.now });
    else if (user.pendingUrl && user.pendingUrlAt != null) {
      if (this.now - user.pendingUrlAt <= PENDING_URL_MS && lines.every((l) => !l.url)) for (const l of lines) l.url = user.pendingUrl;
      Object.assign(patch, { pendingUrl: null, pendingUrlAt: null });
    }
    if (!(await consume(this.repo, user, "add", this.now, patch))) return { kind: "limit", max: DAILY_LIMITS.add };
    if (!lines.length) return { kind: "ask-words", url: parsed.orphanUrl! };

    const known = await this.repo.findNotesForUser(user.id, lines.map((l) => l.word));
    const notKnown = lines.filter((l) => !known.has(wordKey(l.word)));
    const catalog = await this.repo.findCatalogNotes(notKnown.map((l) => l.word));
    const forAi = notKnown.filter((l) => !catalog.has(wordKey(l.word)));
    const cards = await this.askCards(forAi.map((l) => l.word));

    /**
     * By the key of a line: the model's card for it and the word the line stands for. That is the model's word (restored
     * spelling, dictionary form), unless the line was typed with Tatar letters and the model returned a word without them:
     * then the model lost the letters, and the user's spelling stays.
     */
    const answers = new Map<string, { card: WordCard; word: string }>();
    for (const l of forAi) {
      const card = cards.get(wordKey(l.word));
      if (card) answers.set(wordKey(l.word), { card, word: hasTatarLetters(l.word) && !hasTatarLetters(card.word) ? l.word : card.word });
    }
    const changed = [...answers].filter(([typed, a]) => wordKey(a.word) !== typed).map(([, a]) => a.word);
    if (changed.length) {
      for (const [key, hit] of await this.repo.findNotesForUser(user.id, changed)) known.set(key, hit);
      for (const [key, hit] of await this.repo.findCatalogNotes(changed)) catalog.set(key, hit);
    }

    const duplicates: Duplicate[] = [];
    const drafts: CardDraft[] = [];
    const manual: Omit<PendingManual, "at">[] = [];
    const links: D1PreparedStatement[] = [];
    /** Two lines may lead to one word («эни» and «мама» → «әни»): it is answered once. */
    const seen = new Set<string>();
    const repeated = (key: string) => { if (seen.has(key)) return true; seen.add(key); return false; };
    for (const l of lines) {
      const answer = answers.get(wordKey(l.word));
      const word = answer?.word ?? l.word;
      const key = wordKey(word);
      const own = known.get(key);
      const ready = catalog.get(key);
      const draft = ready ? catalogDraft(ready, l.url) : answer ? aiDraft(answer.card, word, l.url) : null;
      if (!own && !draft) manual.push({ word: l.word, url: l.url });
      else if (repeated(key)) continue;
      else if (own) {
        // A link goes only on a note of the user's own deck. A level note is shared: there the link is dropped and not announced.
        const linkAdded = !!l.url && own.owned && !own.sourceUrl;
        if (linkAdded) links.push(this.repo.setNoteSourceUrlStmt(user.id, own.id, l.url!));
        duplicates.push({ word, deckTitle: user.lang === "ru" ? own.deckTitleRu : own.deckTitleTt, linkAdded });
      } else if (draft) drafts.push(draft);
    }
    if (links.length) await this.repo.batch(links);

    if (!drafts.length) {
      const first = manual[0];
      if (!first) return { kind: "duplicates-only", duplicates };
      const wait: Pending = { manual: { ...first, at: this.now } };
      await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify(wait) });
      return { kind: "manual", word: first.word, others: manual.slice(1).map((m) => m.word), duplicates, at: this.now };
    }
    const previewId = await this.repo.insertPreview(user.id, "add", drafts, this.now);
    return { kind: "preview", previewId, items: drafts, duplicates, manual: manual.map((m) => m.word) };
  }

  /** One request for all the lines: the cards by the key of the line each one echoes. A model that is down gives no cards. */
  private async askCards(lines: string[]): Promise<Map<string, WordCard>> {
    const byInput = new Map<string, WordCard>();
    if (!lines.length) return byInput;
    try {
      for (const c of await completeCards(this.deps.llm, WORDS_SYSTEM, `Lines:\n${lines.join("\n")}`, Date.now() + this.deadlineMs)) {
        const key = wordKey(c.input);
        if (!byInput.has(key)) byInput.set(key, c);
      }
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) throw e;
    }
    return byInput;
  }

  /** What the bot is waiting for from this user, or null: a wait ends PENDING_EDIT_MS after it began; a state without a time is older than that. */
  private pending(user: User): Pending | null {
    if (!user.pendingEdit) return null;
    const p = JSON.parse(user.pendingEdit) as Pending;
    const at = p.manual?.at ?? p.preview?.at;
    return typeof at === "number" && this.now - at <= PENDING_EDIT_MS ? p : null;
  }

  /** Saves a card from a translation the user typed after AI was unavailable; null when the bot is not waiting for one. Throws on a translation that `typedTranslation` refuses. */
  async completeManual(user: User, text: string): Promise<string | null> {
    const pending = this.pending(user);
    if (!pending?.manual) return null;
    const translation = storedTranslation(text);
    const m = pending.manual;
    const deckId = await this.repo.customDeck(user.id, this.now);
    await this.repo.insertNotes(deckId, [{ word: m.word, transcription: transcribe(m.word), pos: "", translation, exampleTt: "", exampleRu: "", sourceUrl: m.url }]);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return m.word;
  }

  async startEdit(user: User, previewId: number): Promise<CardDraft[] | null> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) return null;
    const wait: Pending = { preview: { previewId, at: this.now } };
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify(wait) });
    return items;
  }

  /**
   * Applies a typed translation to the preview being edited.
   * `gone`: the preview no longer exists (added, cancelled, expired); the state that pointed to it is dropped, and the
   * caller treats the text as an ordinary message. `too-long`: `typedTranslation` refuses the text; the bot keeps waiting.
   */
  async editPreviewTranslation(user: User, text: string): Promise<EditResult> {
    const pending = this.pending(user);
    if (!pending?.preview) return { kind: "gone" };
    const id = pending.preview.previewId;
    const items = await this.repo.getPreview<CardDraft[]>(user.id, id, "add", this.now - PREVIEW_TTL_MS);
    if (!items?.length) {
      await this.repo.updateUser(user.id, { pendingEdit: null });
      return { kind: "gone" };
    }
    const translation = typedTranslation(text);
    if (translation === null) return { kind: "too-long" };
    const edited = items[0]!;
    edited.translation = translation;
    edited.ai = false; // the translation is the user's now, there is nothing of the model's left to check
    await this.repo.updatePreview(id, items);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return { kind: "edited", previewId: id, items };
  }

  /** What the next text of the user is: the translation asked for by hand, the translation of the preview in edit, or (null) a message with words. */
  pendingKind(user: User): "manual" | "preview" | null {
    const p = this.pending(user);
    return p?.manual ? "manual" : p?.preview ? "preview" : null;
  }

  /** ✖️ under the request for a translation: ends the wait that began at `at`. False when the bot is not waiting for that translation any more. */
  async cancelManual(user: User, at: number): Promise<boolean> {
    if (this.pending(user)?.manual?.at !== at) return false;
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return true;
  }

  /** Saves the words of a preview and deletes it; if the user was editing it, the bot stops waiting for its translation. */
  async confirmAdd(user: User, previewId: number): Promise<{ words: string[] }> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) throw new Error("preview not found");
    const deckId = await this.repo.customDeck(user.id, this.now);
    await this.repo.insertNotes(deckId, items.map(toNote));
    await this.repo.deletePreview(user.id, previewId);
    return { words: items.map((i) => i.word) };
  }

  /** Drops a preview; if the user was editing it, the bot stops waiting for its translation (see `Repo.deletePreview`). */
  async cancel(user: User, previewId: number): Promise<void> { await this.repo.deletePreview(user.id, previewId); }

  /**
   * An AI deck on a topic. A word the catalog has (in any level, open or not) or the user already has is left out: a
   * card of the model in a deck of the user's own would stand in for the reviewed card of the level for good.
   * The lookup is two D1 calls. With fewer than MIN_DECK_CARDS words left there is no deck: the result is `failed`
   * and the daily unit is given back, as when the model is down.
   */
  async generateDeck(user: User, topic: string, n: number): Promise<GenResult> {
    const count = Math.min(30, Math.max(10, Math.round(n) || 20));
    if (!(await consume(this.repo, user, "gen", this.now))) return { kind: "limit" };
    try {
      const cards = await completeCards(this.deps.llm, DECK_SYSTEM, `Topic: ${topic}\nNumber of cards: ${count}`, Date.now() + this.deadlineMs);
      const seen = new Set<string>();
      const unique = cards.filter((c) => { const k = wordKey(c.word); if (seen.has(k)) return false; seen.add(k); return true; });
      const words = unique.map((c) => c.word);
      const [mine, catalog] = await Promise.all([this.repo.findNotesForUser(user.id, words), this.repo.findCatalogNotes(words)]);
      const items: CardDraft[] = unique
        .filter((c) => !mine.has(wordKey(c.word)) && !catalog.has(wordKey(c.word)))
        .slice(0, count)
        .map((c) => aiDraft(c, c.word, null));
      if (items.length >= MIN_DECK_CARDS) {
        const previewId = await this.repo.insertPreview(user.id, "gen", { topic, items }, this.now);
        return { kind: "preview", previewId, topic, items };
      }
    } catch (e) {
      await refund(this.repo, user, "gen", this.now);
      if (e instanceof LlmUnavailable) return { kind: "failed" };
      throw e;
    }
    await refund(this.repo, user, "gen", this.now);
    return { kind: "failed" };
  }

  async confirmDeck(user: User, previewId: number): Promise<{ deckId: number; title: string; count: number }> {
    const p = await this.repo.getPreview<{ topic: string; items: CardDraft[] }>(user.id, previewId, "gen", this.now - PREVIEW_TTL_MS);
    if (!p) throw new Error("preview not found");
    const title = `🤖 ${p.topic}`;
    const deckId = await this.repo.insertDeck({ slug: null, kind: "ai", titleRu: title, titleTt: title, levelNo: null, coveragePct: null, ownerId: user.id });
    await this.repo.insertNotes(deckId, p.items.map(toNote));
    await this.repo.subscribe(user.id, deckId, this.now);
    await this.repo.deletePreview(user.id, previewId);
    return { deckId, title, count: p.items.length };
  }
}
