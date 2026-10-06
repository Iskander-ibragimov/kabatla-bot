/**
 * Turns the catalog files into the catalog seed:
 * data/catalog/a1.csv … c1.csv + meta.json + data/topics.csv + data/renames.csv → seed/catalog.sql.
 *   npx tsx scripts/csv-to-sql.ts
 * The deploy loads the file with `wrangler d1 execute --file` on every push; loading an unchanged catalog writes no rows
 * (see `catalogToSql`). Without catalog files the seed is empty.
 */
import { type SeedLevel, catalogToSql } from "../src/content/csv";
import { LEVELS } from "../src/levels/scale";
import { catalogRenames, validMeta } from "./lib/catalog";
import { FILES, catalogHash, readCatalog, readCatalogMeta, readRenames, readTopics, writeText } from "./lib/files";

const catalog = readCatalog();
if (catalog.length === 0) {
  writeText(FILES.seed, "");
  console.log("каталога нет");
} else {
  // The check of the catalog has refused a meta.json of another shape before this runs; an entry it would refuse is not loaded.
  const coverage = new Map(validMeta(readCatalogMeta()).map((m) => [m.level, m.coveragePct]));
  const levels = catalog.map(({ level, rows }): SeedLevel => {
    const { slug, code } = LEVELS.find((l) => l.no === level)!;
    return { level, slug, titleRu: code, titleTt: code, coveragePct: coverage.get(level) ?? null, rows };
  });
  const sql = catalogToSql(levels, readTopics(), catalogRenames(readRenames()), catalogHash());
  writeText(FILES.seed, sql);
  const cards = levels.reduce((sum, l) => sum + l.rows.length, 0);
  console.log(`${FILES.seed}: уровней ${levels.length}, карточек ${cards}, выражений ${sql.split("\n").length - 1}`);
}
