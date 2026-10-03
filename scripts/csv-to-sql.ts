/**
 * Turns the level files into the catalog seed: data/levels/l01.csv … + meta.json → seed/catalog.sql.
 *   npx tsx scripts/csv-to-sql.ts
 * The deploy loads the file with `wrangler d1 execute --file` on every push; loading an unchanged catalog writes no rows
 * (see `csvToSql`). Without level files the seed is empty.
 */
import { csvToSql } from "../src/content/csv";
import { dict } from "../src/i18n";
import { levelSlug } from "../src/users/service";
import { FILES, levelNumbers, readLevel, readMeta, writeText } from "./lib/files";

const coverage = new Map(readMeta().map((m) => [m.level, m.coveragePct]));
let words = 0;
const sql = levelNumbers().map((n) => {
  const rows = readLevel(n);
  words += rows.length;
  return csvToSql({ slug: levelSlug(n), titleRu: dict("ru").levelTitle(n), titleTt: dict("tt").levelTitle(n), levelNo: n, coveragePct: coverage.get(n) ?? null }, rows);
}).join("");
writeText(FILES.seed, sql);
console.log(`${FILES.seed}: уровней ${levelNumbers().length}, слов ${words}, выражений ${sql.split("\n").length - 1}`);
