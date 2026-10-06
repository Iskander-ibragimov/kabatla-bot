/**
 * Recomputes data/catalog/meta.json: for every level that has a file, the share of running text, in whole percent,
 * covered by the words of the catalog up to that level (`coverage` in scripts/lib/coverage.ts says how it is counted).
 * Run from the repository root after cards are added to a level or moved between levels:
 *   npx tsx scripts/coverage.ts            writes the file
 *   npx tsx scripts/coverage.ts --check    writes nothing; exit code 1 when the file differs from what is computed
 * Reads the catalog, the corpus lists in data/work/sources/ (branch `sources`) and data/work/cognates.json, which
 * `build-wordlist candidates` writes. The sources are not in git, so this is run by the author, not in CI.
 */
import { parseArgs } from "./lib/args";
import { type LevelMeta, checkMeta, validMeta } from "./lib/catalog";
import { coverage, formatMeta, lemmaCounts } from "./lib/coverage";
import { FILES, readCatalog, readCatalogMeta, readText, readWordforms, writeText } from "./lib/files";
import { type Cognate, parseLemmas, rankWords } from "./lib/wordlist";

const SOURCES_HINT = "распакуйте ветку sources в data/work/sources/";
const show = (meta: readonly LevelMeta[]): string => meta.map((m) => `уровень ${m.level} — ${m.coveragePct}%`).join(", ") || "—";

function main(): number {
  const { words, flags } = parseArgs(process.argv.slice(2), { flags: ["check"] });
  if (words.length) throw new Error("запуск: npx tsx scripts/coverage.ts [--check]");
  const catalog = readCatalog();
  if (catalog.length === 0) throw new Error("каталога нет: нет файлов data/catalog/a1.csv … c1.csv");
  const lemmas = parseLemmas(readText(FILES.lemmas, SOURCES_HINT));
  const { cognates } = JSON.parse(readText(FILES.cognates, "его пишет build-wordlist.ts candidates")) as { cognates: Cognate[] };
  const computed = coverage(catalog.map((l) => ({ level: l.level, words: l.rows.map((row) => row.word ?? "") })), {
    counts: lemmaCounts(lemmas), ranks: new Map(rankWords(lemmas, readWordforms()).map((w) => [w.word, w.rank])), cognates,
    total: lemmas.reduce((sum, l) => sum + l.count, 0),
  });
  const stored = readCatalogMeta();
  const same = checkMeta(stored).length === 0 && formatMeta(validMeta(stored)) === formatMeta(computed);
  console.log(`покрытие по каталогу: ${show(computed)}`);
  if (same) { console.log(`${FILES.catalogMeta}: совпадает`); return 0; }
  console.log(`в ${FILES.catalogMeta} сейчас: ${show(validMeta(stored))}`);
  if (flags.has("check")) { console.log(`${FILES.catalogMeta} отличается от расчёта; чтобы записать: npx tsx scripts/coverage.ts`); return 1; }
  writeText(FILES.catalogMeta, formatMeta(computed));
  console.log(`${FILES.catalogMeta}: записано`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
