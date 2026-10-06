/**
 * Catalog files (data/catalog/a1.csv … c1.csv, one per CEFR level, data/topics.csv and data/renames.csv): their format,
 * the rules they must keep, and the digest the seed knows a changed catalog by. Pure: no I/O, so the same code runs in
 * the scripts and in the Workers test runtime.
 */
import { createHash } from "node:crypto";
import { type Rename, parseCsv } from "../../src/content/csv";
import { isTatarText } from "../../src/content/tatar";
import { wordKey } from "../../src/db/repo";
import { LEVELS } from "../../src/levels/scale";
import { isAttested, tokenize, wordForm } from "./forms";

export const CATALOG_HEADER = ["word", "transcription", "pos", "translation", "example_tt", "example_ru", "example_src", "topic", "audio_file_id"] as const;
export const TOPICS_HEADER = ["no", "slug", "title_ru", "title_tt"] as const;
/** Columns of data/renames.csv: a corrected headword. `level` is the number of the level, 1–5, the word stood in when the line was written. */
export const RENAMES_HEADER = ["level", "old_word", "new_word"] as const;
export const POS_CODES: readonly string[] = ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"];
const TOPICS_FILE = "topics.csv";
const RENAMES_FILE = "renames.csv";
/** Topics are numbered 0 (`core`) … 20. */
const LAST_TOPIC = 20;

/** Signs a transcription may hold besides Tatar letters and punctuation. */
const TRANSCRIPTION_EXTRA = "wʼ́";
/** The characters once each, as they are named in a violation. */
const show = (chars: string[]): string => [...new Set(chars)].map((c) => JSON.stringify(c).slice(1, -1)).join("");
/** Characters of a Tatar field that are neither Tatar Cyrillic nor allowed punctuation. */
const foreign = (text: string, extra = ""): string[] => [...text].filter((c) => !isTatarText(c) && !extra.includes(c));

type Row = Record<(typeof CATALOG_HEADER)[number], string>;

/** A line of data/topics.csv. `no` is NaN when the file does not give a whole number. */
export interface Topic { no: number; slug: string; titleRu: string; titleTt: string }

/** The first line of a CSV text, as written. */
const headerLine = (text: string): string => text.split(/\r?\n/, 1)[0]!.trim();

/** The topics of data/topics.csv; none for an empty text. Throws when the header is not `TOPICS_HEADER`. */
export function parseTopics(text: string): Topic[] {
  const header = headerLine(text);
  if (header === "") return [];
  if (header !== TOPICS_HEADER.join(",")) throw new Error(`${TOPICS_FILE}:1 заголовок «${header}», нужен «${TOPICS_HEADER.join(",")}»`);
  return parseCsv(text).map((r) => ({
    no: /^\d+$/.test(r.no!.trim()) ? Number(r.no) : NaN, slug: r.slug!.trim(), titleRu: r.title_ru!.trim(), titleTt: r.title_tt!.trim(),
  }));
}

/** One level file: `level` is the level number 1–5, `header` the column names as the file has them, `rows` its lines in learning order. */
export interface CatalogLevel { level: number; rows: Record<string, string>[]; header: string[] }

/** Reads the text of a level file. */
export function parseCatalogLevel(level: number, text: string): CatalogLevel {
  const header = headerLine(text);
  return { level, header: header === "" ? [] : header.split(",").map((column) => column.trim()), rows: parseCsv(text) };
}

/** Every line of data/renames.csv (`level, old_word, new_word`): a rename holds for the whole catalog, whatever level it names. */
export const catalogRenames = (text: string): Rename[] => parseCsv(text).map((r) => ({ oldWord: r.old_word ?? "", newWord: r.new_word ?? "" }));

export interface CatalogCheck {
  topics: Topic[];
  /** Lower-case word forms the corpus knows, plus the forms approved by hand. */
  attested: Set<string>;
  /** data/catalog/meta.json: coverage of running text by the words up to each level. */
  meta: LevelMeta[];
}

/** One entry of data/catalog/meta.json: the share of running text, in whole percent, that the words up to and including the level cover. */
export interface LevelMeta { level: number; coveragePct: number }

/** The name of the file of a level without `.csv`: a1 … c1; a number that is no level stands as it is. */
const levelName = (level: number): string => LEVELS.find((l) => l.no === level)?.slug ?? String(level);

/** The levels whose coverage is lower than that of the level before, as `b1: покрытие 39% меньше, чем у a2 (41%)`. */
export function coverageDrops(meta: readonly LevelMeta[]): string[] {
  const byLevel = [...meta].sort((a, b) => a.level - b.level);
  return byLevel.flatMap((m, i) => {
    const before = byLevel[i - 1];
    return before && m.coveragePct < before.coveragePct
      ? [`${levelName(m.level)}: покрытие ${m.coveragePct}% меньше, чем у ${levelName(before.level)} (${before.coveragePct}%)`]
      : [];
  });
}

/**
 * Checks the catalog files and the topics. Returns the violations, one per line: `a1:5 <what is wrong>` — the file of
 * the level and the line in it (the header is line 1) — `a1: …` for a rule about the level as a whole, and
 * `topics.csv:3 …` for a topic. Words and Tatoeba sentences are compared across all the levels.
 */
export function checkCatalog(levels: CatalogLevel[], o: CatalogCheck): string[] {
  const errors: string[] = [];

  /** Topic number and slug → the line that has it. */
  const numbers = new Map<number, string>();
  const slugs = new Map<string, string>();
  o.topics.forEach((t, i) => {
    const at = `${TOPICS_FILE}:${i + 2}`;
    if (!Number.isInteger(t.no) || t.no < 0 || t.no > LAST_TOPIC) errors.push(`${at} номер темы «${t.no}»: нужен от 0 до ${LAST_TOPIC}`);
    else if (numbers.has(t.no)) errors.push(`${at} номер темы ${t.no} уже есть в ${numbers.get(t.no)}`);
    else numbers.set(t.no, at);
    if (t.slug.trim() === "" || t.titleRu.trim() === "" || t.titleTt.trim() === "") errors.push(`${at} пустой код или название темы`);
    if (t.slug.trim() === "") return;
    if (slugs.has(t.slug)) errors.push(`${at} код темы «${t.slug}» уже есть в ${slugs.get(t.slug)}`);
    else slugs.set(t.slug, at);
  });

  /** Word key and Tatoeba sentence number → where it stands. */
  const words = new Map<string, string>();
  const sentences = new Map<number, string>();
  for (const { level, header, rows } of levels) {
    const scale = LEVELS.find((l) => l.no === level);
    if (!scale) { errors.push(`уровня ${level} нет: уровни 1–${LEVELS.length}`); continue; }
    const name = scale.slug;
    if (header.join(",") !== CATALOG_HEADER.join(",")) {
      errors.push(`${name}:1 заголовок «${header.join(",")}», нужен «${CATALOG_HEADER.join(",")}»`);
      continue;
    }
    // The line named is the first one over the size.
    if (rows.length > scale.size) errors.push(`${name}:${scale.size + 2} строк ${rows.length}, в уровне ${scale.code} не больше ${scale.size}`);

    (rows as Row[]).forEach((row, j) => {
      const at = `${name}:${j + 2}`;
      const word = row.word.trim();
      const key = wordKey(word);
      if (key === "") { errors.push(`${at} пустое слово`); return; }
      const first = words.get(key);
      if (first) errors.push(`${at} дубль слова «${word}»: уже есть в ${first}`);
      else words.set(key, at);

      for (const field of ["word", "example_tt", "transcription"] as const) {
        const bad = foreign(row[field], field === "transcription" ? TRANSCRIPTION_EXTRA : "");
        if (bad.length) errors.push(`${at} ${field}: чужие буквы или знаки «${show(bad)}»`);
      }
      if (row.transcription.trim() === "") errors.push(`${at} пустая транскрипция`);
      if (!POS_CODES.includes(row.pos)) errors.push(`${at} часть речи «${row.pos}» не из списка ${POS_CODES.join(", ")}`);
      if (row.translation.trim() === "") errors.push(`${at} пустой перевод`);
      if (!slugs.has(row.topic)) errors.push(`${at} темы «${row.topic}» нет в ${TOPICS_FILE}`);

      // Every card has an example, a phrase too.
      if (row.example_tt.trim() === "") { errors.push(`${at} нет примера`); return; }
      if (row.example_ru.trim() === "") errors.push(`${at} пустой example_ru`);
      const src = /^(?:own|tatoeba:(\d+))$/.exec(row.example_src);
      if (!src) errors.push(`${at} example_src «${row.example_src}»: нужно own или tatoeba:<число>`);
      else if (src[1] !== undefined) {
        const sentence = Number(src[1]);
        const used = sentences.get(sentence);
        if (used) errors.push(`${at} предложение tatoeba:${sentence} уже стоит в ${used}`);
        else sentences.set(sentence, at);
      }
      for (const token of new Set(tokenize(row.example_tt))) {
        if (!isAttested(token, o.attested)) errors.push(`${at} example_tt: слова «${token}» нет в списке словоформ`);
      }
      // The example of a phrase may be an exchange that answers it, so only a word must stand in its example.
      if (row.pos !== "phr" && wordForm(row.example_tt, word, row.pos) === null) errors.push(`${at} в примере нет формы слова «${word}»`);
    });
  }

  for (const { level } of levels) {
    if (!o.meta.some((m) => m.level === level)) errors.push(`${levelName(level)}: нет покрытия в meta.json`);
  }
  errors.push(...coverageDrops(o.meta));
  return errors;
}

/**
 * Checks data/renames.csv against the level files. A line says: the catalog word that was stored as `old_word` is now
 * `new_word`. The seed applies it to the whole catalog, whatever level the line names (`catalogRenames`), so the words
 * are looked for in every level file: the new word must stand in the catalog and the old one must no longer; an old
 * word is renamed once. `level` must be the number of a level, 1–5, that has a file. Words are compared by their keys,
 * like notes: a change of case or of the punctuation at the edges is not a rename, the seed updates such a word in place.
 * Returns the violations as `renames.csv:2 <what is wrong>`, the number being the line of the file. An empty text
 * (no file) and a file with the header only have none.
 */
export function checkRenames(text: string, levels: CatalogLevel[]): string[] {
  const header = headerLine(text);
  if (header === "") return [];
  if (header !== RENAMES_HEADER.join(",")) return [`${RENAMES_FILE}:1 заголовок «${header}», нужен «${RENAMES_HEADER.join(",")}»`];
  const errors: string[] = [];
  /** Word key → where the word stands in the level files. */
  const words = new Map<string, string>();
  for (const { level, rows } of levels) {
    rows.forEach((row, j) => {
      const key = wordKey(row.word ?? "");
      if (key !== "" && !words.has(key)) words.set(key, `${levelName(level)}:${j + 2}`);
    });
  }
  /** Old word key → the line that renames it. */
  const renamed = new Map<string, number>();
  parseCsv(text).forEach((r, i) => {
    const at = `${RENAMES_FILE}:${i + 2}`;
    const given = (r.level ?? "").trim();
    const scale = /^\d+$/.test(given) ? LEVELS.find((l) => l.no === Number(given)) : undefined;
    if (!scale) { errors.push(`${at} уровня «${given}» нет: уровни 1–${LEVELS.length}`); return; }
    if (!levels.some((l) => l.level === scale.no)) { errors.push(`${at} файла уровня ${scale.no} (${scale.slug}.csv) нет`); return; }
    const [oldWord, newWord] = [(r.old_word ?? "").trim(), (r.new_word ?? "").trim()];
    const [oldKey, newKey] = [wordKey(oldWord), wordKey(newWord)];
    if (oldKey === "") { errors.push(`${at} пустое old_word`); return; }
    if (newKey === "") { errors.push(`${at} пустое new_word`); return; }
    const first = renamed.get(oldKey);
    if (first !== undefined) { errors.push(`${at} старое слово «${oldWord}» уже переименовано в строке ${first}`); return; }
    renamed.set(oldKey, i + 2);
    if (!words.has(newKey)) errors.push(`${at} нового слова «${newWord}» нет в каталоге`);
    const still = words.get(oldKey);
    if (still !== undefined) errors.push(`${at} старое слово «${oldWord}» всё ещё стоит в ${still}`);
  });
  return errors;
}

/**
 * sha256, in hex, of what the catalog in the database is made from: the version of the rule that orders the words of a
 * level in the guided order (`GUIDED_RULE_VERSION`), and every file by its path and content, in the order given. The
 * seed stores it and raises the catalog version when it differs from the stored one (`catalogToSql`): the version
 * moves when a file changes, and also when the files are the same but a new rule places their words differently.
 */
export function catalogDigest(files: { path: string; bytes: Uint8Array }[], ruleVersion: number): string {
  const hash = createHash("sha256").update(`guided rule ${ruleVersion}\n`);
  // The length before the bytes keeps the files apart: the same bytes cut into files at another place give another digest.
  for (const { path, bytes } of files) hash.update(`${path} ${bytes.length}\n`).update(bytes);
  return hash.digest("hex");
}
