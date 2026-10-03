import { type NoteInput, type NoteRow, type Repo, type User, wordKey } from "../db/repo";
import { consume, refund } from "../entitlements/service";
import { type Entity, type WordLink, parseWordsAndLinks } from "./links";
import { DECK_SYSTEM, type LlmClient, LlmUnavailable, WORDS_SYSTEM, type WordCard, completeCards } from "./llm";
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
  | { kind: "duplicates-only"; duplicates: Duplicate[] }
  | { kind: "preview"; previewId: number; items: CardDraft[]; duplicates: Duplicate[]; manual: string[] }
  | { kind: "manual"; word: string; others: string[]; duplicates: Duplicate[] };
export type GenResult = { kind: "limit" } | { kind: "failed" } | { kind: "preview"; previewId: number; topic: string; items: CardDraft[] };

interface Deps { llm: LlmClient }
interface PendingManual { word: string; url: string | null }
interface PendingPreviewEdit { previewId: number }

const PENDING_URL_MS = 10 * 60_000;
const PREVIEW_TTL_MS = 24 * 3_600_000;

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
   */
  async prepareAdd(user: User, text: string, entities: Entity[]): Promise<AddResult> {
    const parsed = parseWordsAndLinks(text, entities);
    const lines = cleanLines(parsed.items);
    if (!lines.length) {
      if (!parsed.orphanUrl) return { kind: "empty" };
      await this.repo.updateUser(user.id, { pendingUrl: parsed.orphanUrl, pendingUrlAt: this.now });
      return { kind: "ask-words", url: parsed.orphanUrl };
    }
    if (user.pendingUrl && user.pendingUrlAt != null) {
      if (this.now - user.pendingUrlAt <= PENDING_URL_MS && lines.every((l) => !l.url)) for (const l of lines) l.url = user.pendingUrl;
      await this.repo.updateUser(user.id, { pendingUrl: null, pendingUrlAt: null });
    }

    const known = await this.repo.findNotesForUser(user.id, lines.map((l) => l.word));
    const notKnown = lines.filter((l) => !known.has(wordKey(l.word)));
    const catalog = await this.repo.findCatalogNotes(notKnown.map((l) => l.word));
    const forAi = notKnown.filter((l) => !catalog.has(wordKey(l.word)));
    const cards = await this.askCards(forAi.map((l) => l.word));

    /** By the key of a line: the model's card for it and the word the line stands for. A line typed with Tatar letters keeps the user's spelling. */
    const answers = new Map<string, { card: WordCard; word: string }>();
    for (const l of forAi) {
      const card = cards.get(wordKey(l.word));
      if (card) answers.set(wordKey(l.word), { card, word: hasTatarLetters(l.word) ? l.word : card.word });
    }
    const changed = [...answers].filter(([typed, a]) => wordKey(a.word) !== typed).map(([, a]) => a.word);
    if (changed.length) {
      for (const [key, hit] of await this.repo.findNotesForUser(user.id, changed)) known.set(key, hit);
      for (const [key, hit] of await this.repo.findCatalogNotes(changed)) catalog.set(key, hit);
    }

    const duplicates: Duplicate[] = [];
    const drafts: CardDraft[] = [];
    const manual: PendingManual[] = [];
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
      await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ manual: first }) });
      return { kind: "manual", word: first.word, others: manual.slice(1).map((m) => m.word), duplicates };
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

  /** Saves a card from a translation the user typed after AI was unavailable. */
  async completeManual(user: User, translation: string): Promise<string | null> {
    const pending = user.pendingEdit ? (JSON.parse(user.pendingEdit) as { manual?: PendingManual }) : null;
    if (!pending?.manual) return null;
    const m = pending.manual;
    const deckId = await this.repo.customDeck(user.id, this.now);
    await this.repo.insertNotes(deckId, [{ word: m.word, transcription: transcribe(m.word), pos: "", translation: translation.trim(), exampleTt: "", exampleRu: "", sourceUrl: m.url }]);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return m.word;
  }

  async startEdit(user: User, previewId: number): Promise<CardDraft[] | null> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) return null;
    const edit: PendingPreviewEdit = { previewId };
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ preview: edit }) });
    return items;
  }

  /** Applies a typed translation to the preview being edited; returns the updated items and preview id. */
  async editPreviewTranslation(user: User, translation: string): Promise<{ previewId: number; items: CardDraft[] }> {
    const pending = user.pendingEdit ? (JSON.parse(user.pendingEdit) as { preview?: PendingPreviewEdit }) : null;
    if (!pending?.preview) throw new Error("no preview in edit");
    const id = pending.preview.previewId;
    const items = await this.repo.getPreview<CardDraft[]>(user.id, id, "add", this.now - PREVIEW_TTL_MS);
    if (!items?.length) throw new Error("preview expired");
    const edited = items[0]!;
    edited.translation = translation.trim();
    edited.ai = false; // the translation is the user's now, there is nothing of the model's left to check
    await this.repo.updatePreview(id, items);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return { previewId: id, items };
  }

  pendingKind(user: User): "manual" | "preview" | null {
    if (!user.pendingEdit) return null;
    const p = JSON.parse(user.pendingEdit) as { manual?: unknown; preview?: unknown };
    return p.manual ? "manual" : p.preview ? "preview" : null;
  }

  async confirmAdd(user: User, previewId: number): Promise<{ words: string[] }> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) throw new Error("preview not found");
    const deckId = await this.repo.customDeck(user.id, this.now);
    await this.repo.insertNotes(deckId, items.map(toNote));
    await this.repo.deletePreview(user.id, previewId);
    return { words: items.map((i) => i.word) };
  }

  async cancel(user: User, previewId: number): Promise<void> { await this.repo.deletePreview(user.id, previewId); }

  async generateDeck(user: User, topic: string, n: number): Promise<GenResult> {
    const count = Math.min(30, Math.max(10, Math.round(n) || 20));
    if (!(await consume(this.repo, user, "gen", this.now))) return { kind: "limit" };
    try {
      const cards = await completeCards(this.deps.llm, DECK_SYSTEM, `Topic: ${topic}\nNumber of cards: ${count}`, Date.now() + this.deadlineMs);
      const seen = new Set<string>();
      const items: CardDraft[] = cards
        .filter((c) => { const k = wordKey(c.word); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, count)
        .map((c) => aiDraft(c, c.word, null));
      if (!items.length) { await refund(this.repo, user, "gen", this.now); return { kind: "failed" }; }
      const previewId = await this.repo.insertPreview(user.id, "gen", { topic, items }, this.now);
      return { kind: "preview", previewId, topic, items };
    } catch (e) {
      await refund(this.repo, user, "gen", this.now);
      if (e instanceof LlmUnavailable) return { kind: "failed" };
      throw e;
    }
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
