import type { InlineKeyboardButton } from "grammy/types";
import { formatInterval } from "../srs/interval";
import { type Lang, type Mem, type Rating, rungOf, stage } from "../srs/ladder";
import { dict } from "../i18n";
import { levelCode } from "../levels/scale";
import { esc } from "../tg/html";

export type Button = InlineKeyboardButton.CallbackButton;
export type Keyboard = Button[][];
export interface Rendered { text: string; keyboard: Keyboard }

import type { CardDraft, Duplicate } from "../content/service";
import type { CardView, Counts, DaySummary, EmptyReason, Feedback, Lead } from "../review/service";
export type { CardView, Counts, DaySummary, EmptyReason, Feedback, Lead };
/** What a preview shows of a card that is not saved yet. */
export type PreviewItem = Pick<CardDraft, "word" | "transcription" | "pos" | "translation" | "exampleTt" | "exampleRu" | "sourceUrl" | "ai">;

export { esc };
const btn = (text: string, data: string, style?: Button["style"]): Button => (style ? { text, callback_data: data, style } : { text, callback_data: data });

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const MINUTE = 60_000;
/** Telegram's limit for the text of one message; it counts the text after the HTML is parsed. */
const TEXT_LIMIT = 4096;
/** The length Telegram counts: a tag is not text, an entity is the one character it stands for. */
const visibleLength = (html: string): number => html.replace(/<[^>]+>/g, "").replace(/&(?:lt|gt|amp|quot);/g, "x").length;
const fits = (text: string) => visibleLength(text) <= TEXT_LIMIT;
/** The text under the largest cap from `least` to `most` that fits one message, or null when even `least` does not. A larger cap never gives a shorter text. */
function largestFit(least: number, most: number, render: (cap: number) => string): string | null {
  let best: string | null = null;
  for (let lo = least, hi = most; lo <= hi;) {
    const cap = (lo + hi) >> 1;
    const text = render(cap);
    if (fits(text)) { best = text; lo = cap + 1; } else hi = cap - 1;
  }
  return best;
}

/**
 * How much of its texts a message with a list shows. Whole by default: a list is shortened only when the message
 * would not fit, see `fitMessage`. The caps are in characters.
 */
export interface Fit { transcriptions: boolean; translation: number; deck: number; host: number; word: number }
const WHOLE: Fit = { transcriptions: true, translation: Infinity, deck: Infinity, host: Infinity, word: Infinity };
/**
 * The shortest the caps get. At these a list of 30 lines (an AI deck), and 19 lines about known words around one
 * whole card, fit one message even when every field is as long as content/llm.ts (MAX) allows.
 */
const LEAST = { translation: 40, deck: 24, host: 40, word: 30 } as const;
/** No text of a message is longer than this (a link is at most 512 characters): the top of the search for a cap. */
const LONGEST = 512;

/** The text, or its beginning and «…» when it is longer than `max` characters. Call it before `esc`, never after. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  // A cut in the middle of a surrogate pair would leave half a character.
  return `${s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}
/** The text, or its beginning, «…» and its end when it is longer than `max`: phrases that differ in their last word stay different. */
function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2), tail = max - 1 - head;
  const end = tail > 0 ? s.slice(-tail).replace(/^[\uDC00-\uDFFF]/, "").trimStart() : "";
  return `${s.slice(0, head).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…${end}`;
}
/**
 * The words of one list in at most `max` characters each. A longer word is cut in the middle; if two different words
 * would then look the same, each of them carries its number in the list, so no two different words are shown alike.
 */
export function shownWords(words: string[], max: number): string[] {
  const cut = words.map((w) => clipMiddle(w, max));
  return cut.map((c, i) => {
    if (!words.some((w, j) => w !== words[i] && cut[j] === c)) return c;
    const tag = ` №${i + 1}`;
    return clipMiddle(words[i]!, max - tag.length) + tag;
  });
}

/**
 * The text of a message that holds a list, shown whole when it fits one Telegram message. Only when it does not,
 * `render` is asked for a shorter one, in this order and no further than needed:
 * the transcriptions of the list lines go; then translations, deck titles and link hosts are cut, the longest first
 * (one cap for all, lowered until the message fits); only then the words, see `shownWords`.
 * The fields of a card shown alone in a preview are never cut; among other lines only the host of its link may be.
 * A card of a review session has its own rule, see `fitCard`.
 */
export function fitMessage(render: (fit: Fit) => string): string {
  /** The message under the largest cap from `least` up that fits, or null when even `least` does not. */
  const largest = (least: number, fit: (cap: number) => Fit): string | null => largestFit(least, LONGEST, (cap) => render(fit(cap)));
  const whole = render(WHOLE);
  if (fits(whole)) return whole;
  const bare: Fit = { ...WHOLE, transcriptions: false };
  const withoutTranscriptions = render(bare);
  if (fits(withoutTranscriptions)) return withoutTranscriptions;
  const texts = (cap: number): Fit => ({ ...bare, translation: Math.max(cap, LEAST.translation), host: Math.max(cap, LEAST.host), deck: cap });
  const shortest = texts(LEAST.deck);
  return largest(LEAST.deck, texts) ?? largest(LEAST.word, (cap) => ({ ...shortest, word: cap })) ?? render({ ...shortest, word: LEAST.word });
}

/** «[transcription] · <i>part of speech</i>» for the card and the previews; either part may be missing, "" when both are. */
function wordMeta(n: { transcription: string | null; pos: string }, lang: Lang): string {
  return [n.transcription ? `[${esc(n.transcription)}]` : "", n.pos ? `<i>${esc(dict(lang).posName(n.pos))}</i>` : ""].filter(Boolean).join(" · ");
}

/** The line under a card: the stage of the word, its rung of the ladder once it stands on one, and which review this is. */
export function progressLine(m: Mem, lang: Lang): string {
  const t = dict(lang);
  const st = { new: t.stageNew, learning: t.stageLearning, known: t.stageKnown, learned: t.stageLearned }[stage(m)];
  const parts = [st];
  const rung = rungOf(m);
  if (rung >= 1) parts.push(t.rung(rung));
  if (m.reps) parts.push(t.reviewNo(m.reps + 1));
  return parts.join(" · ");
}

/**
 * How much of a card in a review session is shown. Whole by default; the caps (in characters) are lowered only for a
 * card that would not fit one message, see `fitCard`. `example`: 0 leaves the example out. `extras`: the line with the
 * transcription and the part of speech is shown and the host of the link is whole.
 */
interface CardFit { example: number; translation: number; extras: boolean; word: number }
const WHOLE_CARD: CardFit = { example: Infinity, translation: Infinity, extras: true, word: Infinity };

/**
 * The text of a card, always short enough for one Telegram message. The fields are limited where they are typed or
 * generated, but a note stored before the limits existed, or an imported one, may be longer than a message, and a card
 * that cannot be sent would block the learner's queue for good. A card that fits is shown whole. Otherwise, in this
 * order and no further than needed: the example is shortened, down to nothing; then the translation, to no less than
 * LEAST.translation characters; then the transcription line goes. The word is never shortened while anything else
 * can be: only a word that alone is longer than a message is cut, in the middle.
 */
function fitCard(render: (fit: CardFit) => string): string {
  const whole = render(WHOLE_CARD);
  if (fits(whole)) return whole;
  const bare: CardFit = { ...WHOLE_CARD, example: 0 };
  const least: CardFit = { ...bare, translation: LEAST.translation, extras: false };
  return largestFit(0, TEXT_LIMIT, (cap) => render({ ...WHOLE_CARD, example: cap }))
    ?? largestFit(LEAST.translation, TEXT_LIMIT, (cap) => render({ ...bare, translation: cap }))
    ?? largestFit(LEAST.translation, TEXT_LIMIT, (cap) => render({ ...least, translation: cap }))
    ?? largestFit(LEAST.word, TEXT_LIMIT, (cap) => render({ ...least, word: cap }))
    ?? render({ ...least, word: LEAST.word });
}

/** The text of a hint, see tutorial/hints.ts: what to do with a card, or the update notice. */
export function renderLead(l: Lead, lang: Lang): string {
  const t = dict(lang);
  return l.kind === "front" ? t.hintFront : t.updateNotice;
}

/** `lead` is what stands before the card in the same message, a hint; it counts toward the length. */
function cardText(v: CardView, c: Counts, lang: Lang, lead: string, fit: CardFit): string {
  const word = esc(clipMiddle(v.word, fit.word));
  const translation = esc(clip(v.translation, fit.translation));
  const transcription = fit.extras ? v.transcription : null;
  const lines: string[] = [`🔵 ${c.n} · 🔴 ${c.l} · 🟢 ${c.r}`];
  if (lead) lines.unshift(lead, "");
  if (v.direction === "tt_ru") {
    const meta = fit.extras ? wordMeta(v, lang) : "";
    lines.push(`<b>${word}</b>`);
    if (meta) lines.push(meta);
    lines.push(`<tg-spoiler><b>${translation}</b></tg-spoiler>`);
  } else {
    lines.push(`<b>${translation}</b>`);
    lines.push(`<tg-spoiler><b>${word}</b>${transcription ? ` [${esc(transcription)}]` : ""}</tg-spoiler>`);
  }
  let text = lines.join("\n");
  if (fit.example > 0 && (v.exampleTt || v.exampleRu)) {
    text += `<blockquote><tg-spoiler><i>${esc(clip(v.exampleTt, fit.example))}</i>\n${esc(clip(v.exampleRu, fit.example))}</tg-spoiler></blockquote>`;
  } else text += "\n";
  text += progressLine(v.mem, lang);
  if (v.sourceUrl) text += `\n🔗 <a href="${esc(v.sourceUrl)}">${esc(clip(hostOf(v.sourceUrl), fit.extras ? Infinity : LEAST.host))}</a>`;
  return text;
}

/**
 * The two rows of the grade buttons, «Хорошо · 10 минут»: of a card, and of the practice card, which shows what a real
 * one shows. `intervals`: what each button gives, in words; `data`: the callback data of a button. `tried`: the
 * buttons the practice card marks as pressed — «Хорошо ✅ 10 минут», the mark in place of the dot, so the label is no
 * longer than it was; a real card marks none.
 */
export function gradeRows(intervals: Record<Rating, string>, data: (r: Rating) => string, lang: Lang, tried: (r: Rating) => boolean = () => false): Keyboard {
  const t = dict(lang);
  const grade = (r: Rating, name: string, style?: Button["style"]) => btn(`${name} ${tried(r) ? "✅" : "·"} ${intervals[r]}`, data(r), style);
  return [[grade(1, t.again, "danger"), grade(2, t.hard)], [grade(3, t.good, "success"), grade(4, t.easy, "primary")]];
}

export function renderCard(v: CardView, c: Counts, intervals: Record<Rating, string>, canUndo: boolean, lang: Lang, lead = ""): Rendered {
  const t = dict(lang);
  const text = fitCard((fit) => cardText(v, c, lang, lead, fit));

  const keyboard = gradeRows(intervals, (r) => `g:${v.cardId}:${v.reps}:${r}`, lang);
  const extra: Button[] = [];
  if (v.hasAudio) extra.push(btn(t.speak, `v:${v.noteId}`));
  if (canUndo) extra.push(btn(t.undo, "u"));
  extra.push(btn("⚑", `r:${v.noteId}`));
  keyboard.push(extra);
  return { text, keyboard };
}

/**
 * The screen that ends a session. `empty`: why no new word came although the day allows more; it is said in the last
 * line, with the button that mends it above the other two, when there is something to mend. `lead`: a hint, which
 * stands above everything else.
 */
export function renderDone(s: DaySummary, lang: Lang, empty: EmptyReason | null, lead = ""): Rendered {
  const t = dict(lang);
  const lines: string[] = lead ? [lead, ""] : [];
  lines.push(t.doneTitle, t.doneToday(s.reviewsToday, s.learnedToday));
  // The interval in the same words as on a grade button, in the form after «через»; never less than a minute, which the sentence has no form for.
  if (s.nextLearningInMs != null) lines.push("", t.doneNextLearning(formatInterval(Math.max(s.nextLearningInMs, MINUTE), lang, "after")));
  if (s.postponedToday > 0) lines.push("", t.donePostponed(s.postponedToday));
  if (s.streak > 0) lines.push(t.streak(s.streak));
  const keyboard: Keyboard = [[btn(t.addWords, "help:add"), btn(t.decksBtn, "levels")]];
  if (empty) {
    const [why, fix] = empty.kind === "pickTopic" ? [empty.chosen ? t.emptyTopic : t.emptyNoTopic, btn(t.fixTopicBtn, "fix:topic")]
      : empty.kind === "allPos" ? [t.emptyPos, btn(t.fixPosBtn, "fix:pos")]
      : empty.kind === "addLevel" ? [t.emptyLevels, btn(t.fixLevelBtn(levelCode(empty.level)), `fix:lv:${empty.level}`)]
      : [t.emptyAllDone, null];
    lines.push("", why);
    if (fix) keyboard.unshift([fix]);
  }
  return { text: lines.join("\n"), keyboard };
}

/** The text of the preview of own words. One card is shown whole, with everything it has; several are a list. */
function addPreviewText(items: PreviewItem[], lang: Lang, fit: Fit): string {
  const t = dict(lang);
  const ai = items.some((i) => i.ai);
  if (items.length === 1) {
    const i = items[0]!;
    let text = `<b>${esc(i.word)}</b>`;
    const meta = wordMeta(i, lang);
    if (meta) text += `\n${meta}`;
    text += `\n\n<b>${esc(i.translation)}</b>`;
    if (i.exampleTt || i.exampleRu) text += `<blockquote><i>${esc(i.exampleTt)}</i>\n${esc(i.exampleRu)}</blockquote>`;
    if (i.sourceUrl) text += `\n🔗 ${esc(clip(hostOf(i.sourceUrl), fit.host))}`;
    if (ai) text += `\n${t.aiNote}`;
    return text;
  }
  const lines = [t.foundN(items.length), ...previewLines(items, lang, fit).map((line, k) => `${line}${items[k]!.sourceUrl ? " 🔗" : ""}`)];
  if (ai) lines.push("", t.aiNote);
  return lines.join("\n");
}

/** The preview of own words before they are added. It ends with the AI note when a translation in it is the model's. */
export function renderAddPreview(items: PreviewItem[], previewId: number, lang: Lang): Rendered {
  const t = dict(lang);
  const text = fitMessage((fit) => addPreviewText(items, lang, fit));
  if (items.length === 1) return { text, keyboard: [[btn(t.add, `add:ok:${previewId}`, "primary"), btn(t.edit, `add:edit:${previewId}`), btn(t.cancel, `add:no:${previewId}`)]] };
  return { text, keyboard: [[btn(t.addAll(items.length), `add:ok:${previewId}`, "primary"), btn(t.cancel, `add:no:${previewId}`)]] };
}

/** What the answer to a message with words is made of: the results of `prepareAdd` that name words. */
export type AddReply =
  | { kind: "duplicates-only"; duplicates: Duplicate[] }
  | { kind: "preview"; items: PreviewItem[]; duplicates: Duplicate[]; manual: string[] }
  | { kind: "manual"; word: string; others: string[]; duplicates: Duplicate[] };

/**
 * The answer to a message with words: the lines about the words already being learned, then the preview or the request
 * for a translation by hand, then the words left untranslated. It is fitted as one message: everything whole when it fits.
 */
export function addReplyText(res: AddReply, lang: Lang): string {
  const t = dict(lang);
  return fitMessage((fit) => {
    const known = shownWords(res.duplicates.map((d) => d.word), fit.word);
    const dups = res.duplicates.map((d, i) => t.dupLine(esc(known[i]!), esc(clip(d.deckTitle, fit.deck)), d.linkAdded));
    if (res.kind === "duplicates-only") return dups.join("\n");
    const left = res.kind === "manual" ? res.others : res.manual;
    const body = res.kind === "manual" ? t.manualAsk(esc(res.word)) : addPreviewText(res.items, lang, fit);
    return (dups.length ? dups.join("\n") + "\n\n" : "") + body + (left.length ? "\n\n" + t.notTranslated(shownWords(left, fit.word).map(esc).join(", ")) : "");
  });
}

/** The words of a list preview, one line each: «• <b>word</b> [transcription] · <i>part of speech</i> — translation». */
export function previewLines(items: Pick<PreviewItem, "word" | "transcription" | "pos" | "translation">[], lang: Lang, fit: Fit): string[] {
  const words = shownWords(items.map((i) => i.word), fit.word);
  return items.map((i, k) => {
    const meta = wordMeta({ transcription: fit.transcriptions ? i.transcription : null, pos: i.pos }, lang);
    return `• <b>${esc(words[k]!)}</b>${meta ? ` ${meta}` : ""} — ${esc(clip(i.translation, fit.translation))}`;
  });
}
