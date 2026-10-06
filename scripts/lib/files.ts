/**
 * Files of the dictionary scripts: where they live and how they are read and written.
 * Node only (node:fs): the tests run in the Workers runtime and never import this module.
 * Paths are relative to the repository root, where the scripts are run from.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { GUIDED_RULE_VERSION } from "../../src/levels/order";
import { LEVELS } from "../../src/levels/scale";
import { type CatalogLevel, type Topic, catalogDigest, parseCatalogLevel, parseTopics } from "./catalog";

/** The catalog by CEFR level: a1.csv … c1.csv and meta.json. */
export const CATALOG_DIR = "data/catalog";
/** The texts of the KFU specifications (branch `kfu-specs`) and what is built from them. Not in git: the lists are another party's work. */
export const KFU_DIR = "data/work/kfu";
export const FILES = {
  /** Example word forms the corpus knows; written by `build-wordlist attest`. */
  attested: "data/attested.txt",
  /** Word forms approved by hand (names), one per line. */
  attestedExtra: "data/attested-extra.txt",
  /** Topics of the catalog: `no, slug, title_ru, title_tt`. */
  topics: "data/topics.csv",
  /** Coverage of running text by the words up to each CEFR level. */
  catalogMeta: `${CATALOG_DIR}/meta.json`,
  /** Corrected headwords: `level, old_word, new_word` (see `checkRenames` and `catalogRenames`). */
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
  /** The KFU word lists by level and topic, and all their entries once with the kind, the frequency and the catalog (`kfu-lists`). */
  kfuLists: `${KFU_DIR}/lists.json`,
  kfuPool: `${KFU_DIR}/pool.tsv`,
} as const;

/** Where `candidates --level` writes the next words of a level: data/work/candidates-a1.tsv … candidates-c1.tsv. */
export const levelCandidatesPath = (slug: string): string => `data/work/candidates-${slug}.tsv`;

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

/** Paths of the level files of a catalog folder that exist, A1 first. */
const catalogPaths = (dir = CATALOG_DIR): { level: number; path: string }[] =>
  LEVELS.map((l) => ({ level: l.no, path: `${dir}/${l.slug}.csv` })).filter((f) => existsSync(f.path));

/** The level files of the catalog that exist (data/catalog/a1.csv … c1.csv), A1 first; none when the catalog is not there yet. */
export function readCatalog(dir = CATALOG_DIR): CatalogLevel[] {
  return catalogPaths(dir).map((f) => parseCatalogLevel(f.level, readFileSync(f.path, "utf8")));
}

/** CSV files of data/catalog that are not a level (a3.csv, A1.csv): the seed would skip them without a word. */
export function strayCatalogFiles(dir = CATALOG_DIR): string[] {
  const levelFiles = new Set(LEVELS.map((l) => `${l.slug}.csv`));
  return (existsSync(dir) ? readdirSync(dir) : []).filter((name) => /\.csv$/i.test(name) && !levelFiles.has(name)).sort();
}

export const readTopics = (): Topic[] => parseTopics(readText(FILES.topics, "темы каталога: no,slug,title_ru,title_tt"));

/**
 * data/catalog/meta.json as it is written — coverage by CEFR level; an empty list when there is no such file yet.
 * What it holds is for `checkMeta` to judge and for `validMeta` to read. Throws, naming the file, when it is not JSON.
 */
export function readCatalogMeta(path: string = FILES.catalogMeta): unknown {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new Error(`meta.json: не JSON (${(e as Error).message})`);
  }
}

/** The texts of the KFU specifications A1–C1 that keep the layout of the pages (`s_A1.layout.txt` …), lowest level first. */
export function readKfuTexts(dir = KFU_DIR): { level: string; text: string }[] {
  return LEVELS.map((l) => ({ level: l.slug, text: readText(`${dir}/s_${l.code}.layout.txt`, "тексты спецификаций КФУ лежат в ветке kfu-specs") }));
}

/**
 * The digest of the catalog as it stands on disk: the level files that exist, the topics file and the version of the
 * guided-order rule (`catalogDigest`). The seed stores it and raises the catalog version when it differs from the
 * stored one (see `catalogToSql`).
 */
export function catalogHash(): string {
  return catalogDigest([...catalogPaths().map((f) => f.path), FILES.topics].map((path) => ({ path, bytes: readFileSync(path) })), GUIDED_RULE_VERSION);
}

/** The word forms the examples of the catalog may use: data/attested.txt plus the forms approved by hand, lower-cased. */
export function readAttested(): Set<string> {
  return new Set([...readLines(FILES.attested), ...readLines(FILES.attestedExtra)].map((form) => form.toLowerCase()));
}

/** Every word form of the corpus (count ≥ 3), lower-cased. */
export function readWordforms(): Set<string> {
  if (!existsSync(FILES.wordforms)) throw new Error(`нет файла ${FILES.wordforms} — распакуйте ветку sources в data/work/sources/`);
  return new Set(new TextDecoder().decode(gunzipSync(readFileSync(FILES.wordforms))).toLowerCase().split("\n").filter((form) => form !== ""));
}
