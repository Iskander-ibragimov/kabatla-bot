/**
 * Level files of the catalog (data/levels/l01.csv … l20.csv): their format, the rules they must keep, and the
 * coverage figure. Pure: no I/O, so the same code runs in the scripts and in the Workers test runtime.
 */
import { type Rename, parseCsv, toCsv } from "../../src/content/csv";
import { isTatarText } from "../../src/content/tatar";
import { wordKey } from "../../src/db/repo";
import { levelSlug } from "../../src/users/service";
import { verbStems } from "./tatar-verbs";

export const CSV_HEADER = ["word", "transcription", "pos", "translation", "example_tt", "example_ru", "example_src", "audio_file_id"] as const;
export type Row = Record<(typeof CSV_HEADER)[number], string>;
export const POS_CODES: readonly string[] = ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"];
export const LEVEL_SIZE = 100;
export const LEVEL_COUNT = 20;

/** File name of a level inside data/levels: l01.csv … l20.csv, the deck slug plus `.csv`. */
export const levelFile = (n: number): string => `${levelSlug(n)}.csv`;
/** The level a file name stands for, or null: only l01.csv … l20.csv are level files. */
export function levelNumber(name: string): number | null {
  const n = Number(/^l(\d\d)\.csv$/.exec(name)?.[1]);
  return n >= 1 && n <= LEVEL_COUNT ? n : null;
}
export const parseLevel = (text: string): Row[] => parseCsv(text) as Row[];
export const formatLevel = (rows: Row[]): string => toCsv([...CSV_HEADER], rows);

/** The words of a text, lower-cased; a hyphen between letters stays inside the word, digits and punctuation are dropped. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+(?:-\p{L}+)*/gu) ?? [];
}

/** True if the corpus knows the token; a hyphenated token also passes when every part of it does. */
export function isAttested(token: string, attested: ReadonlySet<string>): boolean {
  return attested.has(token) || (token.includes("-") && token.split("-").every((part) => attested.has(part)));
}

/**
 * What a form of the word may begin with. Verbs: the stems of the infinitive. Other words: the first
 * max(3, length − 2) letters, or the whole word when `strict`; a whole word in -к, -п also matches voiced (аяк → аягым).
 */
function stemsOf(word: string, pos: string, strict: boolean): string[] {
  if (pos === "v") return verbStems(word);
  const stem = strict ? word : word.slice(0, Math.max(3, word.length - 2));
  const voiced = stem === word && /[кп]$/.test(word) ? [word.slice(0, -1) + (word.endsWith("к") ? "г" : "б")] : [];
  return [stem, ...voiced];
}

/**
 * The form of `word` found in the example, lower-cased, or null. A word of several words (ярдәм итү, зур рәхмәт)
 * must stand in neighbouring tokens: the first words as they are, the last one as a form.
 * `strict` narrows the match for words other than verbs to tokens that begin with the whole word.
 */
export function wordForm(example: string, word: string, pos: string, strict = false): string | null {
  const parts = tokenize(word);
  const last = parts.pop();
  if (last === undefined) return null;
  const stems = stemsOf(last, pos, strict);
  const tokens = tokenize(example);
  for (let i = 0; i + parts.length < tokens.length; i++) {
    const tail = tokens[i + parts.length]!;
    if (parts.every((part, k) => tokens[i + k] === part) && stems.some((stem) => tail.startsWith(stem))) {
      return tokens.slice(i, i + parts.length + 1).join(" ");
    }
  }
  return null;
}

export interface CheckOptions {
  /** Lower-case word forms the corpus knows, plus the forms approved by hand. */
  attested: ReadonlySet<string>;
  expectLevels: number;
  /** Everyday core words; checked once levels 1–4 exist. */
  core?: readonly string[];
  /** Least number of `phr` rows in levels 1–3; checked once the three exist. */
  minPhrases?: number;
  /** meta.json; when given, every level must have a coverage and it must not fall from level to level. */
  meta?: readonly LevelMeta[];
}

/** One entry of data/levels/meta.json. */
export interface LevelMeta { level: number; coveragePct: number }

/** The levels whose coverage is lower than that of the level before, as `l03: покрытие 39% …`; `name` gives the file name of a level. */
export function coverageDrops(meta: readonly LevelMeta[], name: (level: number) => string = levelSlug): string[] {
  const byLevel = [...meta].sort((a, b) => a.level - b.level);
  return byLevel.flatMap((m, i) => {
    const before = byLevel[i - 1];
    return before && m.coveragePct < before.coveragePct
      ? [`${name(m.level)}: покрытие ${m.coveragePct}% меньше, чем у ${name(before.level)} (${before.coveragePct}%)`]
      : [];
  });
}

/** Signs a transcription may hold besides Tatar letters and punctuation. */
export const TRANSCRIPTION_EXTRA = "wʼ́";
/** The characters once each, as they are named in a violation. */
export const show = (chars: string[]): string => [...new Set(chars)].map((c) => JSON.stringify(c).slice(1, -1)).join("");
/** Characters of a Tatar field that are neither Tatar Cyrillic nor allowed punctuation. */
export const foreign = (text: string, extra = ""): string[] => [...text].filter((c) => !isTatarText(c) && !extra.includes(c));

/**
 * Checks the level files; `levels[0]` is level 1. Returns the violations as `l01:5 <what is wrong>`, where the
 * number is the line of the file (the header is line 1), or `l01: …` for a rule about the level as a whole.
 */
export function checkLevels(levels: Row[][], opts: CheckOptions): string[] {
  const errors: string[] = [];
  if (levels.length !== opts.expectLevels) errors.push(`уровней ${levels.length}, нужно ${opts.expectLevels}`);

  /** Word key → where the word stands. */
  const seen = new Map<string, { level: number; at: string }>();
  levels.forEach((rows, i) => {
    const level = i + 1;
    const name = levelSlug(level);
    if (rows.length !== LEVEL_SIZE) errors.push(`${name}:1 строк ${rows.length}, нужно ${LEVEL_SIZE}`);
    const header = rows[0] ? Object.keys(rows[0]).join(",") : CSV_HEADER.join(",");
    if (header !== CSV_HEADER.join(",")) {
      errors.push(`${name}:1 заголовок «${header}», нужен «${CSV_HEADER.join(",")}»`);
      return;
    }
    rows.forEach((row, j) => {
      const at = `${name}:${j + 2}`;
      const word = row.word.trim();
      if (word === "") { errors.push(`${at} пустое слово`); return; }
      const key = wordKey(word);
      const first = seen.get(key);
      if (first) errors.push(`${at} дубль слова «${word}»: уже есть в ${first.at}`);
      else seen.set(key, { level, at });

      for (const field of ["word", "example_tt", "transcription"] as const) {
        const bad = foreign(row[field], field === "transcription" ? TRANSCRIPTION_EXTRA : "");
        if (bad.length) errors.push(`${at} ${field}: чужие буквы или знаки «${show(bad)}»`);
      }
      if (!POS_CODES.includes(row.pos)) errors.push(`${at} часть речи «${row.pos}» не из списка ${POS_CODES.join(", ")}`);
      if (row.translation.trim() === "") errors.push(`${at} пустой перевод`);

      if (row.example_tt.trim() === "") {
        if (row.pos !== "phr") errors.push(`${at} нет примера`);
        else if (row.example_ru.trim() !== "" || row.example_src.trim() !== "") errors.push(`${at} example_ru или example_src без примера`);
        return;
      }
      if (row.example_ru.trim() === "") errors.push(`${at} пустой example_ru`);
      if (!/^(own|tatoeba:\d+)$/.test(row.example_src)) errors.push(`${at} example_src «${row.example_src}»: нужно own или tatoeba:<число>`);
      for (const token of new Set(tokenize(row.example_tt))) {
        if (!isAttested(token, opts.attested)) errors.push(`${at} example_tt: слова «${token}» нет в списке словоформ`);
      }
      if (wordForm(row.example_tt, word, row.pos) === null) errors.push(`${at} в примере нет формы слова «${word}»`);
    });
  });

  if (opts.core && levels.length >= 4) {
    for (const word of opts.core) {
      const found = seen.get(wordKey(word));
      if (!found || found.level > 4) errors.push(`слова ядра «${word}» нет в уровнях 1–4${found ? ` (стоит в ${levelSlug(found.level)})` : ""}`);
    }
  }
  if (opts.minPhrases !== undefined && levels.length >= 3) {
    const phrases = levels.slice(0, 3).flat().filter((row) => row.pos === "phr").length;
    if (phrases < opts.minPhrases) errors.push(`фраз в уровнях 1–3: ${phrases}, нужно не меньше ${opts.minPhrases}`);
  }
  if (opts.meta) {
    const meta = opts.meta;
    levels.forEach((_, i) => {
      if (!meta.some((m) => m.level === i + 1)) errors.push(`${levelSlug(i + 1)}: нет покрытия в meta.json`);
    });
    errors.push(...coverageDrops(meta));
  }
  return errors;
}

/** Columns of data/renames.csv: a corrected headword of a level. `level` is the level number, 1…20. */
export const RENAMES_HEADER = ["level", "old_word", "new_word"] as const;
const RENAMES_FILE = "renames.csv";

/** The renames of one level, from the text of data/renames.csv; none when the file is absent or empty. */
export function renamesOf(text: string, level: number): Rename[] {
  return parseCsv(text).filter((r) => Number(r.level) === level).map((r) => ({ oldWord: r.old_word ?? "", newWord: r.new_word ?? "" }));
}

/**
 * Checks data/renames.csv against the level files; `levels[0]` is level 1. A line says: in this level the word that
 * was stored as `old_word` is now `new_word`. So the level must exist, its file must hold the new word and must no
 * longer hold the old one; an old word is renamed once per level. Words are compared by their keys, like notes:
 * a change of case or of the punctuation at the edges is not a rename, the seed updates such a word in place.
 * Returns the violations as `renames.csv:2 <what is wrong>`, the number being the line of the file.
 */
export function checkRenames(text: string, levels: Row[][]): string[] {
  const header = text.split(/\r?\n/, 1)[0]!.trim();
  if (header === "") return [];
  if (header !== RENAMES_HEADER.join(",")) return [`${RENAMES_FILE}:1 заголовок «${header}», нужен «${RENAMES_HEADER.join(",")}»`];
  const errors: string[] = [];
  const keys = levels.map((rows) => new Set(rows.map((row) => wordKey(row.word))));
  /** `level:old key` → the line that renames it. */
  const renamed = new Map<string, number>();
  parseCsv(text).forEach((r, i) => {
    const at = `${RENAMES_FILE}:${i + 2}`;
    const level = Number(r.level);
    const inLevel = /^\d+$/.test((r.level ?? "").trim()) ? keys[level - 1] : undefined;
    if (!inLevel) { errors.push(`${at} уровня «${r.level ?? ""}» нет: есть уровни 1–${levels.length}`); return; }
    const [oldWord, newWord] = [(r.old_word ?? "").trim(), (r.new_word ?? "").trim()];
    if (wordKey(oldWord) === "") { errors.push(`${at} пустое old_word`); return; }
    if (wordKey(newWord) === "") { errors.push(`${at} пустое new_word`); return; }
    const first = renamed.get(`${level}:${wordKey(oldWord)}`);
    if (first !== undefined) { errors.push(`${at} старое слово «${oldWord}» уже переименовано в строке ${first}`); return; }
    renamed.set(`${level}:${wordKey(oldWord)}`, i + 2);
    if (!inLevel.has(wordKey(newWord))) errors.push(`${at} нового слова «${newWord}» нет в ${levelSlug(level)}`);
    if (inLevel.has(wordKey(oldWord))) errors.push(`${at} старое слово «${oldWord}» всё ещё стоит в ${levelSlug(level)}`);
  });
  return errors;
}

/**
 * Cumulative coverage of running text by level, whole percent. Level N covers the corpus occurrences of the words
 * of levels 1…N plus those of the removed Russian look-alikes that are at least as frequent as the rarest corpus
 * word of levels 1…N (a learner knows them anyway). Core words (`origin: "core"`) and words without a count do not
 * set that threshold: they stand in the early levels for their use, not for their frequency. The threshold only
 * goes down from level to level, so the coverage never falls.
 */
export function coverage(levels: { count: number; origin?: string }[][], cognates: { count: number }[], total: number): number[] {
  let learned = 0;
  let rarest = Infinity;
  return levels.map((rows) => {
    for (const row of rows) {
      learned += row.count;
      if (row.origin !== "core" && row.count > 0) rarest = Math.min(rarest, row.count);
    }
    const known = cognates.reduce((sum, c) => (c.count >= rarest ? sum + c.count : sum), 0);
    return Math.round(((learned + known) / total) * 100);
  });
}
