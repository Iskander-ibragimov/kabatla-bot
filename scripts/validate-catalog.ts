/**
 * Checks the catalog files data/catalog/a1.csv … c1.csv, data/topics.csv and data/renames.csv against the rules of the
 * catalog (scripts/lib/catalog.ts), and the breakdowns of the examples data/gloss/a1.tsv … c1.tsv against the examples
 * (scripts/lib/gloss.ts; a level without its file has no breakdown and is not checked). Runs in CI and in the deploy,
 * before the catalog is loaded.
 *   npx tsx scripts/validate-catalog.ts                  (the same: pnpm validate)
 *   npx tsx scripts/validate-catalog.ts --base <git-ref> the same, and no headword of the level files of that commit may be gone
 *   npx tsx scripts/validate-catalog.ts --db-keys <file> only: no headword of the file (one per line: the catalog notes of the database) may be gone
 * Exit code 1 and one line per violation (`a1:5 <что не так>`, the number is the line of the file) when a rule is broken.
 * Without catalog files there is nothing to check.
 *
 * A headword is gone when it stands in no level file and is no `old_word` of data/renames.csv (`vanishedHeadwords`):
 * its card would stay in the database outside the files. `--base` is for the author, before a commit
 * (`--base origin/master`); `--db-keys` is for the deploy, which stops before the migrations when the live catalog has a
 * headword the files lost. With `--db-keys` nothing else is checked but the renames that would make two cards one
 * (the plain check refuses them too). Its last line is `missing=N merged=M` (`headwordsSummary`): the deploy reads the
 * result from it. Exit code: 0 — nothing is gone, 1 — a headword is gone or two cards would merge, 2 — the file
 * cannot be read or the options are wrong.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "./lib/args";
import { type CatalogLevel, checkCatalog, checkRenames, headwordsSummary, mergedRenames, parseCatalogLevel, vanishedHeadwords } from "./lib/catalog";
import { CATALOG_DIR, GLOSS_DIR, readAttested, readCatalog, readCatalogMeta, readGloss, readRenames, readText, readTopics, strayCatalogFiles, strayGlossFiles } from "./lib/files";
import { checkGloss } from "./lib/gloss";
import { LEVELS } from "../src/levels/scale";

/** The most headwords named when the database has some the files lack. */
const SHOWN = 20;

/** Runs git and gives what it prints, or null when it fails; git's own complaint is not shown. */
function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** The level files as a commit has them; a level file that is not there is skipped. Throws when the reference names no commit. */
function catalogAt(ref: string): CatalogLevel[] {
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`) === null) throw new Error(`--base: в репозитории нет коммита «${ref}»`);
  return LEVELS.flatMap((l) => {
    const text = git("show", `${ref}:${CATALOG_DIR}/${l.slug}.csv`);
    return text === null ? [] : [parseCatalogLevel(l.no, text)];
  });
}

/** `--db-keys`: compares the headwords of the database with the files, names those that are gone, and ends with the line the deploy reads. */
function checkDatabaseWords(path: string): number {
  let words: string[];
  try {
    words = readText(path).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const renames = readRenames();
  const missing = vanishedHeadwords(words, readCatalog(), renames);
  const merged = mergedRenames(renames);
  console.log(`слов каталога в базе: ${words.length}, из них нет в файлах: ${missing.length}`);
  for (const word of missing.slice(0, SHOWN)) console.log(`  ${word}`);
  if (missing.length > SHOWN) console.log(`  … и ещё ${missing.length - SHOWN}`);
  if (missing.length) console.log("верните строку в файл уровня или запишите исправленное слово в data/renames.csv (level,old_word,new_word)");
  for (const line of merged) console.log(line);
  console.log(headwordsSummary(missing.length, merged.length));
  return missing.length || merged.length ? 1 : 0;
}

function main(): number {
  const { words, values } = parseArgs(process.argv.slice(2), { values: ["base", "db-keys"] });
  if (words.length || (values.base !== undefined && values["db-keys"] !== undefined)) {
    throw new Error("запуск: npx tsx scripts/validate-catalog.ts [--base <git-ref> | --db-keys <файл>]");
  }
  if (values["db-keys"] !== undefined) return checkDatabaseWords(values["db-keys"]);

  // A file such as a3.csv or A1.csv is not a level: the seed would skip it without a word.
  const errors = strayCatalogFiles().map((name) => `${CATALOG_DIR}/${name}: не уровень — уровни только a1.csv, a2.csv, b1.csv, b2.csv, c1.csv`);
  const levels = readCatalog();

  if (levels.length === 0 && errors.length === 0 && values.base === undefined) {
    console.log("каталога нет");
    return 0;
  }

  try {
    errors.push(...checkCatalog(levels, { topics: readTopics(), attested: readAttested(), meta: readCatalogMeta() }));
  } catch (e) {
    // The topics file is absent or has another header, or meta.json is not JSON: nothing can be checked against it.
    errors.push((e as Error).message);
  }
  // Corrected headwords (data/renames.csv): the new word must stand in the catalog and the old one must be gone from it.
  errors.push(...checkRenames(readRenames(), levels));
  // The breakdowns of the examples: a file such as a3.tsv is read by nothing, and each level file must match its examples.
  errors.push(
    ...strayGlossFiles().map((name) => `${GLOSS_DIR}/${name}: не уровень — уровни только a1.tsv, a2.tsv, b1.tsv, b2.tsv, c1.tsv`),
    ...checkGloss(levels, readGloss()),
  );

  if (values.base !== undefined) {
    const before = catalogAt(values.base).flatMap((l) => l.rows.map((row) => row.word ?? ""));
    const missing = vanishedHeadwords(before, levels, readRenames());
    errors.push(...missing.map((word) => `слово «${word}» было в каталоге (${values.base}), а теперь его нет ни в файлах уровней, ни среди old_word в renames.csv`));
    console.log(`слов каталога в ${values.base}: ${before.length}, из них пропало: ${missing.length}`);
  }

  if (errors.length) {
    for (const error of errors) console.error(error);
    console.error(`нарушений: ${errors.length}`);
    return 1;
  }
  console.log(`уровней: ${levels.length}, карточек: ${levels.reduce((sum, l) => sum + l.rows.length, 0)}, нарушений нет`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
}
