/**
 * Turns the level files into the catalog seed: data/levels/l01.csv … + meta.json + data/renames.csv → seed/catalog.sql.
 *   npx tsx scripts/csv-to-sql.ts
 * The deploy loads the file with `wrangler d1 execute --file` on every push; loading an unchanged catalog writes no rows
 * (see `csvToSql`). Without level files the seed is empty.
 */
import { csvToSql } from "../src/content/csv";
import { dict } from "../src/i18n";
import { levelSlug } from "../src/users/service";
import { FILES, levelNumbers, readLevel, readMeta, readRenames, writeText } from "./lib/files";
import { renamesOf } from "./lib/levels";

const coverage = new Map(readMeta().map((m) => [m.level, m.coveragePct]));
const renames = readRenames();
let words = 0;
const sql = levelNumbers().map((n) => {
  const rows = readLevel(n);
  words += rows.length;
  return csvToSql({ slug: levelSlug(n), titleRu: dict("ru").levelTitle(n), titleTt: dict("tt").levelTitle(n), levelNo: n, coveragePct: coverage.get(n) ?? null }, rows, renamesOf(renames, n));
}).join("");
writeText(FILES.seed, sql);
console.log(`${FILES.seed}: уровней ${levelNumbers().length}, слов ${words}, выражений ${sql.split("\n").length - 1}`);
