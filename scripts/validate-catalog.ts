/**
 * Checks the catalog files data/catalog/a1.csv … c1.csv and data/topics.csv against the rules of the catalog
 * (scripts/lib/catalog.ts).
 *   npx tsx scripts/validate-catalog.ts
 * Exit code 1 and one line per violation (`a1:5 <что не так>`, the number is the line of the file) when a rule is broken.
 * Without catalog files there is nothing to check.
 */
import { checkCatalog } from "./lib/catalog";
import { CATALOG_DIR, readAttested, readCatalog, readCatalogMeta, readTopics, strayCatalogFiles } from "./lib/files";

// A file such as a3.csv or A1.csv is not a level: the seed would skip it without a word.
const errors = strayCatalogFiles().map((name) => `${CATALOG_DIR}/${name}: не уровень — уровни только a1.csv, a2.csv, b1.csv, b2.csv, c1.csv`);
const levels = readCatalog();

if (levels.length === 0 && errors.length === 0) {
  console.log("каталога нет");
  process.exit(0);
}

try {
  errors.push(...checkCatalog(levels, { topics: readTopics(), attested: readAttested(), meta: readCatalogMeta() }));
} catch (e) {
  // The topics file is absent or has another header: nothing can be checked against it.
  errors.push((e as Error).message);
}

if (errors.length) {
  for (const error of errors) console.error(error);
  console.error(`нарушений: ${errors.length}`);
  process.exit(1);
}
console.log(`уровней: ${levels.length}, карточек: ${levels.reduce((sum, l) => sum + l.rows.length, 0)}, нарушений нет`);
