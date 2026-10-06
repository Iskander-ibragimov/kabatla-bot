/**
 * Catalog files (data/catalog/a1.csv … c1.csv, one per CEFR level, data/topics.csv and data/renames.csv): their format,
 * the rules they must keep, and the digest the seed knows a changed catalog by. Pure: no I/O, so the same code runs in
 * the scripts and in the Workers test runtime.
 */
import { createHash } from "node:crypto";
import { type Rename, parseCsv } from "../../src/content/csv";
import { isTatarText } from "../../src/content/tatar";
import { transcribe } from "../../src/content/transcribe";
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
const META_FILE = "meta.json";
/** Topics are numbered 0 (`core`) … 20. */
const LAST_TOPIC = 20;

/** Signs a transcription may hold besides Tatar letters and punctuation. */
const TRANSCRIPTION_EXTRA = "wʼ́";
/** The stress mark of a transcription, COMBINING ACUTE ACCENT. */
const STRESS = /\u0301/g;
/** Sentence-final signs (and the spaces around them) are not part of the transcription notation. */
const FINAL_SIGNS = /[\s.!?…]+$/u;

/**
 * The transcription the catalog expects for a headword: the one the bot computes for a learner's own word
 * (`transcribe`), and for a phrase card (`pos` is `phr`) without its sentence-final sign: «Хәлләр ничек?» → хәллә́р ни́чек.
 */
export function computedTranscription(word: string, pos: string): string {
  const computed = transcribe(word.trim());
  return pos === "phr" ? computed.replace(FINAL_SIGNS, "") : computed;
}

/**
 * True if a transcription is the computed one or differs from it only in where the stress stands. The rule puts the
 * stress on the last syllable, and the author moves it where the rule is wrong (ба́рлык, ке́регез, тата́рча — the
 * guide, rule 10), so the marks may stand elsewhere; their number must be the same: none dropped, none set twice.
 */
const sameButStress = (given: string, computed: string): boolean =>
  given.replace(STRESS, "") === computed.replace(STRESS, "") && (given.match(STRESS)?.length ?? 0) === (computed.match(STRESS)?.length ?? 0);

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
  /** data/catalog/meta.json as it was read: coverage of running text by the words up to each level. Its shape is checked here (`checkMeta`). */
  meta: unknown;
}

/** One entry of data/catalog/meta.json: the share of running text, in whole percent, that the words up to and including the level cover. */
export interface LevelMeta { level: number; coveragePct: number }

/** The name of the file of a level without `.csv`: a1 … c1; a number that is no level stands as it is. */
const levelName = (level: number): string => LEVELS.find((l) => l.no === level)?.slug ?? String(level);

/** The number of the level a file name without `.csv` stands for: a1 → 1 … c1 → 5. Throws on anything else. */
export function levelBySlug(slug: string): number {
  const level = LEVELS.find((l) => l.slug === slug);
  if (!level) throw new Error(`уровня «${slug}» нет: уровни ${LEVELS.map((l) => l.slug).join(", ")}`);
  return level.no;
}

/** Word key → the name of the level file the word stands in (a1 … c1), for every row of the catalog with a word. */
export function catalogKeys(levels: readonly CatalogLevel[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const { level, rows } of levels) {
    for (const row of rows) {
      const key = wordKey(row.word ?? "");
      if (key !== "" && !keys.has(key)) keys.set(key, levelName(level));
    }
  }
  return keys;
}

const isLevelNo = (value: unknown): value is number => typeof value === "number" && LEVELS.some((l) => l.no === value);
const isPercent = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
/** A value of meta.json as it is named in a violation: a text in quotes, anything else as JSON writes it. */
const shown = (value: unknown): string => (typeof value === "number" ? String(value) : JSON.stringify(value) ?? "undefined");

/**
 * What is wrong with the shape of data/catalog/meta.json, as `meta.json: запись 2: …` (the entries are counted from
 * 1): it must be a list of `{"level": 1–5, "coveragePct": a whole number 0–100}` with every level once. The seed
 * writes the percent into SQL as it is, so a text there would break the load of the catalog after the migrations.
 */
export function checkMeta(meta: unknown): string[] {
  if (!Array.isArray(meta)) return [`${META_FILE}: нужен список вида [{"level":1,"coveragePct":45}]`];
  const errors: string[] = [];
  /** Level → the entry that names it first. */
  const seen = new Map<number, number>();
  meta.forEach((entry: unknown, i) => {
    const at = `${META_FILE}: запись ${i + 1}:`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) { errors.push(`${at} нужен объект с level и coveragePct`); return; }
    const { level, coveragePct } = entry as Record<string, unknown>;
    if (!isLevelNo(level)) errors.push(`${at} level «${shown(level)}»: нужен уровень от 1 до ${LEVELS.length}`);
    else if (seen.has(level)) errors.push(`${at} уровень ${level} уже есть в записи ${seen.get(level)}`);
    else seen.set(level, i + 1);
    if (!isPercent(coveragePct)) errors.push(`${at} coveragePct «${shown(coveragePct)}»: нужно целое число от 0 до 100`);
  });
  return errors;
}

/** The entries of meta.json that `checkMeta` has nothing against: a level 1–5 named for the first time with a whole percent. */
export function validMeta(meta: unknown): LevelMeta[] {
  const out: LevelMeta[] = [];
  for (const entry of Array.isArray(meta) ? (meta as unknown[]) : []) {
    const { level, coveragePct } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (isLevelNo(level) && isPercent(coveragePct) && !out.some((m) => m.level === level)) out.push({ level, coveragePct });
  }
  return out;
}

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

      /** The word and the transcription are written with the right letters: only then are the two compared. */
      let letters = true;
      for (const field of ["word", "example_tt", "transcription"] as const) {
        const bad = foreign(row[field], field === "transcription" ? TRANSCRIPTION_EXTRA : "");
        if (bad.length) errors.push(`${at} ${field}: чужие буквы или знаки «${show(bad)}»`);
        if (bad.length && field !== "example_tt") letters = false;
      }
      if (row.transcription.trim() === "") errors.push(`${at} пустая транскрипция`);
      else if (letters) {
        const computed = computedTranscription(word, row.pos);
        if (!sameButStress(row.transcription, computed)) {
          errors.push(`${at} transcription «${row.transcription}»: по правилу «${computed}» (от правила может отличаться только место ударения)`);
        }
      }
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

  errors.push(...checkMeta(o.meta));
  // A level that meta.json names with a wrong percent has its line above: it is not said to have no coverage as well.
  const named = new Set((Array.isArray(o.meta) ? (o.meta as unknown[]) : []).map((entry) => (entry as { level?: unknown } | null)?.level));
  for (const { level } of levels) {
    if (!named.has(level)) errors.push(`${levelName(level)}: нет покрытия в ${META_FILE}`);
  }
  errors.push(...coverageDrops(validMeta(o.meta)));
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

/** What `vanishedHeadwords` found. */
export interface Vanished {
  /** The headwords that are neither in the level files nor an old word of data/renames.csv: each once, as given, in the order given. */
  missing: string[];
  /** The lines of data/renames.csv that rename a second old word to the new word of an earlier line, as `renames.csv:4 …`. */
  merged: string[];
}

/**
 * A headword must not vanish: the seed never deletes a note, so a row that leaves the files — or a corrected word
 * without its line in data/renames.csv — leaves its card in the database, outside the files, for good. `before` are
 * the headwords that were there (the level files of an earlier commit, or the catalog notes of the database); each
 * must stand in the level files, in any level, or be an `old_word` of data/renames.csv. Two old words renamed to one
 * new word are refused as well: the seed renames a note only while no note has the new key, so the second card would
 * stay behind. Words are compared by their keys, like notes.
 */
export function vanishedHeadwords(before: Iterable<string>, levels: CatalogLevel[], renames: string): Vanished {
  const present = new Set(levels.flatMap((l) => l.rows.map((row) => wordKey(row.word ?? ""))));
  const merged: string[] = [];
  /** New word key → the old word that became it and the line that says so. */
  const sources = new Map<string, { oldWord: string; oldKey: string; line: number }>();
  parseCsv(renames).forEach((r, i) => {
    const [oldWord, newWord] = [(r.old_word ?? "").trim(), (r.new_word ?? "").trim()];
    const [oldKey, newKey] = [wordKey(oldWord), wordKey(newWord)];
    if (oldKey === "" || newKey === "" || oldKey === newKey) return;
    present.add(oldKey);
    const first = sources.get(newKey);
    if (!first) sources.set(newKey, { oldWord, oldKey, line: i + 2 });
    else if (first.oldKey !== oldKey) {
      merged.push(`${RENAMES_FILE}:${i + 2} новое слово «${newWord}» уже получено из «${first.oldWord}» в строке ${first.line}: две карточки стали бы одной`);
    }
  });
  const missing = new Map<string, string>();
  for (const given of before) {
    const key = wordKey(given);
    if (key !== "" && !present.has(key) && !missing.has(key)) missing.set(key, given.trim());
  }
  return { missing: [...missing.values()], merged };
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
