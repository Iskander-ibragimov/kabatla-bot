/**
 * The breakdown files data/gloss/a1.tsv … c1.tsv (spec 2026-10-12 §B1–B2): their format and the rules they keep against
 * the examples of the catalog. One line per word of an example: `word, n, form, lemma, gloss`, tab-separated. The rules
 * are those of the interim checker the authors used (`check_gloss.py`); the example is cut into words and the card's
 * word is found by the same functions the seed and the card use (src/content/gloss.ts). Pure: no I/O.
 */
import { GLOSS_MAX, type GlossLine, TATAR_WORD, cardWordLines, exampleWords } from "../../src/content/gloss";
import { LEVELS } from "../../src/levels/scale";
import type { CatalogLevel } from "./catalog";

export const GLOSS_HEADER = ["word", "n", "form", "lemma", "gloss"] as const;

/** A non-empty line of a breakdown file: `line` is its number in the file (the header is line 1). */
export interface GlossFileLine { line: number; fields: string[] }
/** One breakdown file: `level` is the level number 1–5, `header` its first line as written. */
export interface GlossLevel { level: number; header: string; lines: GlossFileLine[] }

/** Reads the text of a breakdown file: lines split on `\n` without a trailing `\r`, the empty ones skipped. */
export function parseGlossLevel(level: number, text: string): GlossLevel {
  const all = text.split("\n").map((line) => line.replace(/\r$/, ""));
  return {
    level,
    header: all[0] ?? "",
    lines: all.slice(1).flatMap((line, i) => (line === "" ? [] : [{ line: i + 2, fields: line.split("\t") }])),
  };
}

/** The lines of five fields, grouped by the exact word of the card, in file order. */
function linesByWord(g: GlossLevel): Map<string, GlossFileLine[]> {
  const byWord = new Map<string, GlossFileLine[]>();
  for (const l of g.lines) {
    if (l.fields.length !== GLOSS_HEADER.length) continue;
    const word = l.fields[0]!;
    byWord.set(word, [...(byWord.get(word) ?? []), l]);
  }
  return byWord;
}

const toLine = (l: GlossFileLine): GlossLine => ({ form: l.fields[2]!, lemma: l.fields[3]!, gloss: l.fields[4]! });

/** The breakdown of each card of a file: the exact `word` of the card → its lines in file order (lines of five fields only). */
export function glossByWord(g: GlossLevel): Map<string, GlossLine[]> {
  return new Map([...linesByWord(g)].map(([word, lines]) => [word, lines.map(toLine)]));
}

const slugOf = (level: number): string => LEVELS.find((l) => l.no === level)?.slug ?? String(level);
/** Tabs of a header as `\t`, so a violation shows them. */
const showTabs = (text: string): string => text.replaceAll("\t", "\\t");

/** What is wrong with one line of a card: empty, too long, an arrow in the gloss, spaces at the edges, letters that are not Tatar. */
function lineErrors(at: string, l: GlossLine): string[] {
  const errors: string[] = [];
  if (l.lemma.trim() === "") errors.push(`${at}: пустая lemma`);
  if (l.gloss.trim() === "") errors.push(`${at}: пустой gloss`);
  if ([...l.gloss].length > GLOSS_MAX) errors.push(`${at}: gloss длиннее ${GLOSS_MAX}`);
  // The card shows a line as «form → lemma — gloss»: an arrow in the gloss would read as a second lemma.
  if (l.gloss.includes("→")) errors.push(`${at}: «→» в gloss`);
  if (l.lemma !== l.lemma.trim() || l.gloss !== l.gloss.trim()) errors.push(`${at}: пробелы по краям`);
  for (const word of [l.form, l.lemma]) if (word.trim() !== "" && !TATAR_WORD.test(word)) errors.push(`${at}: «${word}» не татарскими буквами`);
  return errors;
}

/**
 * Checks the breakdown files against the catalog (spec B2). Only the levels that have a file are checked: a level
 * without one has no breakdown. Returns the violations, one per line: `gloss/a1.tsv:57 …` for a line of the file,
 * `a1:12 разбор: …` for a card (the line of the catalog file, the header is line 1) and `a1:12 разбор, строка 57: …`
 * for one line of a card's breakdown.
 */
export function checkGloss(levels: CatalogLevel[], gloss: GlossLevel[]): string[] {
  const errors: string[] = [];
  for (const g of gloss) {
    const slug = slugOf(g.level);
    const file = `gloss/${slug}.tsv`;
    const catalog = levels.find((l) => l.level === g.level);
    if (!catalog) {
      errors.push(`${file}: нет файла уровня ${slug}.csv`);
      continue;
    }
    const header = GLOSS_HEADER.join("\t");
    if (g.header !== header) errors.push(`${file}:1 заголовок «${showTabs(g.header)}», нужен «${showTabs(header)}»`);

    const words = new Set(catalog.rows.map((row) => row.word ?? ""));
    for (const l of g.lines) {
      if (l.fields.length !== GLOSS_HEADER.length) errors.push(`${file}:${l.line} разбор: полей ${l.fields.length}, нужно ${GLOSS_HEADER.length}`);
      else if (!words.has(l.fields[0]!)) errors.push(`${file}:${l.line} разбор: слова «${l.fields[0]}» нет в ${slug}.csv`);
    }

    const byWord = linesByWord(g);
    catalog.rows.forEach((row, i) => {
      const at = `${slug}:${i + 2} разбор`;
      const word = row.word ?? "";
      const tokens = exampleWords(row.example_tt ?? "");
      const lines = byWord.get(word) ?? [];
      if (tokens.length === 0 && lines.length === 0) return;
      if (lines.length === 0) {
        errors.push(`${at}: нет строк`);
        return;
      }
      if (lines.some((l, k) => l.fields[1] !== String(k + 1))) errors.push(`${at}: n не 1…${lines.length}`);
      const forms = lines.map((l) => l.fields[2]!);
      if (forms.join("\n") !== tokens.join("\n")) errors.push(`${at}: формы «${forms.join(" ")}» не совпадают со словами примера «${tokens.join(" ")}»`);
      const parsed = lines.map(toLine);
      if (!cardWordLines(word, parsed).some(Boolean)) errors.push(`${at}: слово карточки «${word}» не стоит ни в lemma, ни в form`);
      lines.forEach((l, k) => errors.push(...lineErrors(`${at}, строка ${l.line}`, parsed[k]!)));
    });
  }
  return errors;
}
