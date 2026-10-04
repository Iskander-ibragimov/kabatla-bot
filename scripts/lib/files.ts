/**
 * Files of the dictionary scripts: where they live and how they are read and written.
 * Node only (node:fs): the tests run in the Workers runtime and never import this module.
 * Paths are relative to the repository root, where the scripts are run from.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { type LevelMeta, type Row, formatLevel, levelFile, levelNumber, parseLevel } from "./levels";

export const LEVELS_DIR = "data/levels";
export const FILES = {
  /** The authored list, in learning order. */
  wordlist: "data/wordlist.csv",
  /** Everyday core: `word, pos, group`. */
  core: "data/core.csv",
  /** Example word forms the corpus knows; written by `build-wordlist cut`. */
  attested: "data/attested.txt",
  /** Word forms approved by hand (names), one per line. */
  attestedExtra: "data/attested-extra.txt",
  meta: `${LEVELS_DIR}/meta.json`,
  /** Corrected headwords: `level, old_word, new_word` (see `checkRenames`). */
  renames: "data/renames.csv",
  seed: "seed/catalog.sql",
  // Not in git (data/work/): the sources and what is built from them.
  lemmas: "data/work/sources/lemmas.tsv",
  wordforms: "data/work/sources/wordforms.txt.gz",
  tatoeba: "data/work/sources/tatoeba.tsv",
  dix: "data/work/tat-rus.dix",
  candidates: "data/work/candidates.tsv",
  cognates: "data/work/cognates.json",
  /** Verb rows of the corpus that `candidates` dropped: `count, stem, infinitive, reason`. */
  droppedVerbs: "data/work/dropped-verbs.tsv",
  review: "data/work/review.tsv",
} as const;

export function readText(path: string, hint = ""): string {
  if (!existsSync(path)) throw new Error(`нет файла ${path}${hint ? ` — ${hint}` : ""}`);
  return readFileSync(path, "utf8");
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The text of data/renames.csv; empty when there is no such file. */
export const readRenames = (): string => (existsSync(FILES.renames) ? readFileSync(FILES.renames, "utf8") : "");

/** Non-empty lines of a file, trimmed; an absent file has none. */
export function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

const levelPath = (n: number): string => `${LEVELS_DIR}/${levelFile(n)}`;

const levelsDir = (): string[] => (existsSync(LEVELS_DIR) ? readdirSync(LEVELS_DIR) : []);

/** Numbers of the level files on disk (l01.csv … l20.csv), ascending. */
export function levelNumbers(): number[] {
  return levelsDir().map(levelNumber).filter((n) => n !== null).sort((a, b) => a - b);
}

/** Files that look like a level but are not one of l01.csv … l20.csv (l00.csv, l21.csv, l5.csv). */
export function strayLevelFiles(): string[] {
  return levelsDir().filter((name) => /^l\d+\.csv$/i.test(name) && levelNumber(name) === null).sort();
}

export const readLevel = (n: number): Row[] => parseLevel(readText(levelPath(n)));
export const writeLevel = (n: number, rows: Row[]): void => writeText(levelPath(n), formatLevel(rows));

/** Coverage of the levels as `build-wordlist cut` computed it; empty when there is no meta.json yet. */
export function readMeta(): LevelMeta[] {
  return existsSync(FILES.meta) ? (JSON.parse(readFileSync(FILES.meta, "utf8")) as LevelMeta[]) : [];
}

export function writeMeta(meta: LevelMeta[]): void {
  writeText(FILES.meta, `[\n${meta.map((m) => `  ${JSON.stringify(m)}`).join(",\n")}\n]\n`);
}

/** The word forms the level examples may use: data/attested.txt plus the forms approved by hand, lower-cased. */
export function readAttested(): Set<string> {
  return new Set([...readLines(FILES.attested), ...readLines(FILES.attestedExtra)].map((form) => form.toLowerCase()));
}

/** Every word form of the corpus (count ≥ 3), lower-cased. */
export function readWordforms(): Set<string> {
  if (!existsSync(FILES.wordforms)) throw new Error(`нет файла ${FILES.wordforms} — распакуйте ветку sources в data/work/sources/`);
  return new Set(new TextDecoder().decode(gunzipSync(readFileSync(FILES.wordforms))).toLowerCase().split("\n").filter((form) => form !== ""));
}
