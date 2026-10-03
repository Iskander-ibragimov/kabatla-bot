import type { InlineKeyboardButton } from "grammy/types";
import { type Lang, type Mem, type Rating, memoryDays, stage } from "../srs/fsrs";
import { dict } from "../i18n";
import { esc } from "../tg/html";

export type Button = InlineKeyboardButton.CallbackButton;
export type Keyboard = Button[][];
export interface Rendered { text: string; keyboard: Keyboard }

import type { CardDraft } from "../content/service";
import type { CardView, Counts, DaySummary, Feedback, LevelUp } from "../review/service";
export type { CardView, Counts, DaySummary, Feedback, LevelUp };
/** What a preview shows of a card that is not saved yet. */
export type PreviewItem = Pick<CardDraft, "word" | "transcription" | "pos" | "translation" | "exampleTt" | "exampleRu" | "sourceUrl" | "ai">;

export { esc };
const btn = (text: string, data: string, style?: Button["style"]): Button => (style ? { text, callback_data: data, style } : { text, callback_data: data });

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * How many characters of a text a line of a list shows. A Telegram message holds 4 096 characters, and a list has
 * up to 30 lines (an AI deck) or 20 (own words, with the lines about duplicates and untranslated words around it).
 * With these numbers such a message fits even when every field is as long as content/llm.ts (MAX) allows.
 * A single card is shown whole.
 */
export const SHOWN = { word: 30, transcription: 30, translation: 40, deck: 24, host: 40 } as const;

/** The text, or its beginning and «…» when it is longer than `max` characters. Call it before `esc`, never after. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  // A cut in the middle of a surrogate pair would leave half a character.
  return `${s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}

/** Human interval for the done screen: "10 мин", "11 дн.", "1,2 мес.". */
export function formatLong(ms: number, lang: Lang): string {
  const t = dict(lang);
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} ${t.unitMin}`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `${h} ${t.unitHour}`;
  const d = Math.round(ms / 86_400_000);
  if (d < 30) return `${d} ${t.unitDay}`;
  return `${(Math.round(d / 3) / 10).toString().replace(".", t.decimal)} ${t.unitMonth}`;
}

/** «[transcription] · <i>part of speech</i>» for the card and the previews; either part may be missing, "" when both are. */
function wordMeta(n: { transcription: string | null; pos: string }, lang: Lang): string {
  return [n.transcription ? `[${esc(n.transcription)}]` : "", n.pos ? `<i>${esc(dict(lang).posName(n.pos))}</i>` : ""].filter(Boolean).join(" · ");
}

export function progressLine(m: Mem, lang: Lang): string {
  const t = dict(lang);
  const st = { new: t.stageNew, learning: t.stageLearning, known: t.stageKnown, learned: t.stageLearned }[stage(m)];
  const parts = [st];
  const d = memoryDays(m);
  if (d) parts.push(t.memory(d));
  if (m.reps) parts.push(t.reviewNo(m.reps + 1));
  return parts.join(" · ");
}

export function renderCard(v: CardView, c: Counts, intervals: Record<Rating, string>, canUndo: boolean, lang: Lang): Rendered {
  const t = dict(lang);
  const lines: string[] = [`🔵 ${c.n} · 🔴 ${c.l} · 🟢 ${c.r}`];
  if (v.direction === "tt_ru") {
    const meta = wordMeta(v, lang);
    lines.push(`<b>${esc(v.word)}</b>`);
    if (meta) lines.push(meta);
    lines.push(`<tg-spoiler><b>${esc(v.translation)}</b></tg-spoiler>`);
  } else {
    lines.push(`<b>${esc(v.translation)}</b>`);
    lines.push(`<tg-spoiler><b>${esc(v.word)}</b>${v.transcription ? ` [${esc(v.transcription)}]` : ""}</tg-spoiler>`);
  }
  let text = lines.join("\n");
  if (v.exampleTt || v.exampleRu) text += `<blockquote><tg-spoiler><i>${esc(v.exampleTt)}</i>\n${esc(v.exampleRu)}</tg-spoiler></blockquote>`;
  else text += "\n";
  text += progressLine(v.mem, lang);
  if (v.sourceUrl) text += `\n🔗 <a href="${esc(v.sourceUrl)}">${esc(hostOf(v.sourceUrl))}</a>`;

  const g = (r: Rating) => `g:${v.cardId}:${v.reps}:${r}`;
  const keyboard: Keyboard = [
    [btn(`${t.again} ${intervals[1]}`, g(1), "danger"), btn(`${t.hard} ${intervals[2]}`, g(2))],
    [btn(`${t.good} ${intervals[3]}`, g(3), "success"), btn(`${t.easy} ${intervals[4]}`, g(4), "primary")],
  ];
  const extra: Button[] = [];
  if (v.hasAudio) extra.push(btn(t.speak, `v:${v.noteId}`));
  if (canUndo) extra.push(btn(t.undo, "u"));
  extra.push(btn("⚑", `r:${v.noteId}`));
  keyboard.push(extra);
  return { text, keyboard };
}

export function renderDone(s: DaySummary, lang: Lang): Rendered {
  const t = dict(lang);
  const lines: string[] = [];
  lines.push(t.doneTitle, t.doneToday(s.reviewsToday, s.learnedToday), t.doneTotals(s.totals.learned, s.totals.known, s.totals.learning, s.totals.new));
  if (s.nextLearningInMs != null) lines.push("", t.doneNextLearning(formatLong(s.nextLearningInMs, lang)));
  if (s.streak > 0) lines.push(t.streak(s.streak));
  return { text: lines.join("\n"), keyboard: [[btn(t.addWords, "help:add"), btn(t.decksBtn, "levels")]] };
}

/** The line that opens the first card (or the done screen) after a level was opened or the last level was finished. */
export function renderLevelUp(l: LevelUp, lang: Lang): string {
  const t = dict(lang);
  return l.to == null ? t.levelsDone(l.coveragePct) : t.levelUp(l.from, l.to, l.coveragePct);
}

/** The preview of own words before they are added. It ends with the AI note when a translation in it is the model's. */
export function renderAddPreview(items: PreviewItem[], previewId: number, lang: Lang): Rendered {
  const t = dict(lang);
  const ai = items.some((i) => i.ai);
  if (items.length === 1) {
    const i = items[0]!;
    let text = `<b>${esc(i.word)}</b>`;
    const meta = wordMeta(i, lang);
    if (meta) text += `\n${meta}`;
    text += `\n\n<b>${esc(i.translation)}</b>`;
    if (i.exampleTt || i.exampleRu) text += `<blockquote><i>${esc(i.exampleTt)}</i>\n${esc(i.exampleRu)}</blockquote>`;
    if (i.sourceUrl) text += `\n🔗 ${esc(clip(hostOf(i.sourceUrl), SHOWN.host))}`;
    if (ai) text += `\n${t.aiNote}`;
    return { text, keyboard: [[btn(t.add, `add:ok:${previewId}`, "primary"), btn(t.edit, `add:edit:${previewId}`), btn(t.cancel, `add:no:${previewId}`)]] };
  }
  const lines = [t.foundN(items.length), ...items.map((i) => `${previewLine(i, lang)}${i.sourceUrl ? " 🔗" : ""}`)];
  if (ai) lines.push("", t.aiNote);
  return { text: lines.join("\n"), keyboard: [[btn(t.addAll(items.length), `add:ok:${previewId}`, "primary"), btn(t.cancel, `add:no:${previewId}`)]] };
}

/** One word of a list preview: «• <b>word</b> [transcription] · <i>part of speech</i> — translation», long texts cut to SHOWN. */
export function previewLine(i: Pick<PreviewItem, "word" | "transcription" | "pos" | "translation">, lang: Lang): string {
  const meta = wordMeta({ transcription: i.transcription && clip(i.transcription, SHOWN.transcription), pos: i.pos }, lang);
  return `• <b>${esc(clip(i.word, SHOWN.word))}</b>${meta ? ` ${meta}` : ""} — ${esc(clip(i.translation, SHOWN.translation))}`;
}
