/**
 * Checks the level files data/levels/l01.csv … and data/renames.csv against the rules of the catalog (scripts/lib/levels.ts). Runs in CI.
 *   npx tsx scripts/validate-levels.ts          the levels that exist; none is fine
 *   npx tsx scripts/validate-levels.ts --full   all 20 levels are required
 * Exit code 1 and one line per violation (`l01:5 <что не так>`, the number is the line of the file) when a rule is broken.
 */
import { existsSync } from "node:fs";
import { parseCsv } from "../src/content/csv";
import { PLACEMENT } from "../src/users/placement";
import { FILES, LEVELS_DIR, levelNumbers, readAttested, readLevel, readMeta, readRenames, readText, strayLevelFiles } from "./lib/files";
import { LEVEL_COUNT, checkLevels, checkRenames, levelFile } from "./lib/levels";

const MIN_PHRASES = 55;
const full = process.argv.includes("--full");
const numbers = levelNumbers();
// A file such as l00.csv or l21.csv is not a level: the seed would skip it without a word.
const errors = strayLevelFiles().map((name) => `${LEVELS_DIR}/${name}: не уровень — уровни только l01.csv … l${LEVEL_COUNT}.csv`);

if (numbers.length === 0 && errors.length === 0 && !full) {
  console.log("уровней нет");
  process.exit(0);
}

// The files must be l01 … lNN without a gap: a level is the position of its file.
const missing = numbers.length ? Array.from({ length: numbers.at(-1)! }, (_, i) => i + 1).filter((n) => !numbers.includes(n)) : [];
if (missing.length) errors.push(`нет файлов ${missing.map(levelFile).join(", ")}: уровни идут подряд с l01`);
else {
  const core = existsSync(FILES.core) ? parseCsv(readText(FILES.core)).map((row) => row.word ?? "").filter((word) => word.trim() !== "") : undefined;
  const levels = numbers.map(readLevel);
  errors.push(...checkLevels(levels, {
    attested: readAttested(), placement: PLACEMENT, expectLevels: full ? LEVEL_COUNT : numbers.length, core, minPhrases: MIN_PHRASES, meta: readMeta(),
  }));
  // Corrected headwords (data/renames.csv): each must name a level that exists, its new word and no longer its old one.
  errors.push(...checkRenames(readRenames(), levels));
}

if (errors.length) {
  for (const error of errors) console.error(error);
  console.error(`нарушений: ${errors.length}`);
  process.exit(1);
}
console.log(`уровней: ${numbers.length}, нарушений нет`);
