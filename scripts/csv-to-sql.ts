/**
 * Turns the catalog files into the catalog seed:
 * data/catalog/a1.csv … c1.csv + meta.json + data/topics.csv + data/renames.csv + data/gloss/a1.tsv … c1.tsv → seed/catalog.sql.
 *   npx tsx scripts/csv-to-sql.ts
 * The deploy loads the file with `wrangler d1 execute --file` on every push; loading an unchanged catalog writes no rows
 * (see `catalogToSql`). Without catalog files the seed is empty.
 */
import { type SeedLevel, catalogToSql } from "../src/content/csv";
import { LEVELS } from "../src/levels/scale";
import { catalogRenames, validMeta } from "./lib/catalog";
import { FILES, catalogHash, readCatalog, readCatalogMeta, readGloss, readRenames, readTopics, writeText } from "./lib/files";
import { glossByWord } from "./lib/gloss";

const catalog = readCatalog();
if (catalog.length === 0) {
  writeText(FILES.seed, "");
  console.log("каталога нет");
} else {
  // The check of the catalog has refused a meta.json of another shape before this runs; an entry it would refuse is not loaded.
  const coverage = new Map(validMeta(readCatalogMeta()).map((m) => [m.level, m.coveragePct]));
  // The breakdowns of the examples, checked by «pnpm validate» before this runs; a level without its file has none.
  const gloss = new Map(readGloss().map((g) => [g.level, glossByWord(g)]));
  const levels = catalog.map(({ level, rows }): SeedLevel => {
    const { slug, code } = LEVELS.find((l) => l.no === level)!;
    return { level, slug, titleRu: code, titleTt: code, coveragePct: coverage.get(level) ?? null, rows, gloss: gloss.get(level) };
  });
  const sql = catalogToSql(levels, readTopics(), catalogRenames(readRenames()), catalogHash());
  writeText(FILES.seed, sql);
  const cards = levels.reduce((sum, l) => sum + l.rows.length, 0);
  const glossed = levels.filter((l) => l.gloss !== undefined).length;
  console.log(`${FILES.seed}: уровней ${levels.length}, с разбором примеров ${glossed}, карточек ${cards}, выражений ${sql.split("\n").length - 1}`);
}
