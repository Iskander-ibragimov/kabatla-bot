/**
 * The word-by-word breakdown of a catalog example (spec 2026-10-12 §B): how an example is cut into words, how a word is
 * compared, which lines stand for the card's own word, and how the stored breakdown is read back. Shared by the
 * validator (scripts/lib/gloss.ts), the seed (`catalogToSql`) and the card (src/bot/views.ts), so all three cut an
 * example the same way as the interim checker the authors used (`check_gloss.py`: `tokens`, `key`, `PUNCT`, `TT`).
 * Pure: no imports.
 */

/** The longest gloss, in characters. */
export const GLOSS_MAX = 40;

/** Signs stripped at the edges of a word of an example; exactly `PUNCT` of the interim checker. */
export const GLOSS_EDGE = ".,!?;:«»\"()…—–-'“”„[]";

/** A word of a breakdown (`form`, `lemma`): Tatar Cyrillic letters and digits, parts joined by single hyphens; `TT` of the checker. */
export const TATAR_WORD = /^[0-9а-яёәөүҗңһА-ЯЁӘӨҮҖҢҺ]+(?:-[0-9а-яёәөүҗңһА-ЯЁӘӨҮҖҢҺ]+)*$/;

/** One line of the breakdown of an example: the word as the example has it, its initial form, its translation there. */
export interface GlossLine { form: string; lemma: string; gloss: string }

/** A line as `notes.example_gloss` stores it; `level` is the catalog level (A1 … C1) of the lemma, null for the card's own word or a lemma outside the catalog. */
export type GlossEntry = [form: string, lemma: string, gloss: string, level: string | null];

/** A text without the edge signs at either end (Python `str.strip(PUNCT)`). */
function stripEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && GLOSS_EDGE.includes(text[start]!)) start++;
  while (end > start && GLOSS_EDGE.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

/**
 * The words of an example, in order (spec B1): split on whitespace, each stripped of the edge signs, the empty ones
 * dropped. So a lone «—» disappears, while `5-че` and `әкрен-әкрен` stay one word.
 */
export function exampleWords(example: string): string[] {
  return example.split(/\s+/).map(stripEdges).filter((word) => word !== "");
}

/** The key two words are compared by: NFC, trimmed, without the edge signs, lower case, ё as е. */
export function glossKey(word: string): string {
  return stripEdges(word.normalize("NFC").trim()).toLowerCase().replaceAll("ё", "е");
}

/**
 * Which lines of a breakdown stand for the card's own word (spec B2): those whose lemma or form has the key of the
 * card's word or of its first word (a phrase card is found by its first word). These lines are shown bold.
 */
export function cardWordLines(word: string, lines: readonly Pick<GlossLine, "form" | "lemma">[]): boolean[] {
  const keys = new Set([glossKey(word), glossKey(word.trim().split(/\s+/)[0] ?? "")]);
  return lines.map((l) => keys.has(glossKey(l.lemma)) || keys.has(glossKey(l.form)));
}

const isEntry = (x: unknown): x is GlossEntry =>
  Array.isArray(x) && x.length === 4 && x.slice(0, 3).every((s) => typeof s === "string") && (x[3] === null || typeof x[3] === "string");

/** The breakdown `notes.example_gloss` stores; null when there is none or the value is not a non-empty list of entries. */
export function parseGloss(json: string | null): GlossEntry[] | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return Array.isArray(value) && value.length > 0 && value.every(isEntry) ? value : null;
}
