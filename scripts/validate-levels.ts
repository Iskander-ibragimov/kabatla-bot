/**
 * Checks the level files data/levels/l01.csv … against the rules of the catalog (scripts/lib/levels.ts). Runs in CI.
 *   npx tsx scripts/validate-levels.ts          the levels that exist; none is fine
 *   npx tsx scripts/validate-levels.ts --full   all 20 levels are required
 * Exit code 1 and one line per violation (`l01:5 <что не так>`, the number is the line of the file) when a rule is broken.
 */
import { existsSync } from "node:fs";
import { parseCsv } from "../src/content/csv";
import { PLACEMENT } from "../src/users/placement";
import { FILES, levelNumbers, readAttested, readLevel, readText } from "./lib/files";
import { LEVEL_COUNT, checkLevels, levelFile } from "./lib/levels";

const MIN_PHRASES = 55;
const full = process.argv.includes("--full");
const numbers = levelNumbers();

if (numbers.length === 0 && !full) {
  console.log("уровней нет");
  process.exit(0);
}

const errors: string[] = [];
// The files must be l01 … lNN without a gap: a level is the position of its file.
const missing = numbers.length ? Array.from({ length: numbers.at(-1)! }, (_, i) => i + 1).filter((n) => !numbers.includes(n)) : [];
if (missing.length) errors.push(`нет файлов ${missing.map(levelFile).join(", ")}: уровни идут подряд с l01`);
else {
  const core = existsSync(FILES.core) ? parseCsv(readText(FILES.core)).map((row) => row.word ?? "").filter((word) => word.trim() !== "") : undefined;
  errors.push(...checkLevels(numbers.map(readLevel), {
    attested: readAttested(), placement: PLACEMENT, expectLevels: full ? LEVEL_COUNT : numbers.length, core, minPhrases: MIN_PHRASES,
  }));
}

if (errors.length) {
  for (const error of errors) console.error(error);
  console.error(`нарушений: ${errors.length}`);
  process.exit(1);
}
console.log(`уровней: ${numbers.length}, нарушений нет`);
