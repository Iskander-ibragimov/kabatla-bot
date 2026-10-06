/**
 * Reads the word lists of the KFU specifications A1–C1 («Лексический минимум», spec §3.6) and joins them into a pool
 * of entries the catalog is filled from. Run from the repository root:
 *   npx tsx scripts/kfu-lists.ts
 * Reads data/work/kfu/s_A1.layout.txt … s_C1.layout.txt (branch `kfu-specs`), the corpus lists in data/work/sources/
 * (branch `sources`) and the catalog. Writes, both under data/work/, which git ignores:
 *   data/work/kfu/lists.json   `order` (how the entries of a topic are ordered) and, by level: the topics as printed,
 *                              with their entries; the topics of the specification that have no heading over the
 *                              words; the lines that were joined into one entry and the entries that were moved
 *   data/work/kfu/pool.tsv     every entry once, with the lowest level it stands at: entry, level, kfu_topic (the
 *                              heading), topic (of the catalog), kind (word | phrase | name | combination), lemma,
 *                              found (of a word: lemma | form | none — how the corpus knows it), rank (place in the
 *                              frequency list of the corpus, look-alikes of Russian counted), in_catalog (the level
 *                              file that already holds it), words (of a combination, the ones the corpus has)
 * It prints every join and move it made, so that the author can check them against the files.
 * The lists are the work of KFU without a declared licence: neither file is committed, and the bot never shows them.
 */
import { catalogKeys } from "./lib/catalog";
import { FILES, SOURCES_HINT, readCatalog, readKfuTexts, readText, readTopics, readWordforms, writeText } from "./lib/files";
import { KFU_TOPICS, kfuTopicSlug, parseKfuLists } from "./lib/kfu";
import { buildPool, entryKey, formatPool } from "./lib/kfu-pool";
import { finiteVerbForms, parseLemmas, rankMap, rankWords } from "./lib/wordlist";

/** What `order` of lists.json says. */
const ORDER = "printed: a numbered list by its numbers; a list without numbers page by page, the left column and then the right one";

function main(): void {
  const levels = parseKfuLists(readKfuTexts());
  // Every topic of every specification must have its catalog topic, also one without a list of its own: a new or
  // renamed topic stops here, by name, before anything is written.
  const slugs = new Set(readTopics().map((t) => t.slug));
  for (const { level, topics, missing } of levels) {
    for (const name of [...topics.map((t) => t.name), ...missing]) {
      const slug = kfuTopicSlug(level, name);
      if (!slugs.has(slug)) throw new Error(`тема КФУ «${name}» уровня ${level} сопоставлена теме «${slug}», которой нет в ${FILES.topics}`);
    }
    const unknown = Object.keys(KFU_TOPICS[level] ?? {}).filter((name) => !topics.some((t) => t.name === name) && !missing.includes(name));
    if (unknown.length) throw new Error(`в спецификации ${level} нет тем из KFU_TOPICS: ${unknown.join(", ")}`);
  }

  const lemmas = parseLemmas(readText(FILES.lemmas, SOURCES_HINT));
  const forms = readWordforms();
  const pool = buildPool(levels, { ranks: rankMap(rankWords(lemmas, forms)), finite: finiteVerbForms(lemmas, forms), catalog: catalogKeys(readCatalog()) });

  const lists = Object.fromEntries(levels.map(({ level, topics, missing, joins, moves }) => [level, {
    topics: topics.map((t) => ({ topic: t.heading, name: t.name, slug: kfuTopicSlug(level, t.name), entries: t.entries })), missing, joins, moves,
  }]));
  writeText(FILES.kfuLists, `${JSON.stringify({ order: ORDER, ...lists }, null, 1)}\n`);
  writeText(FILES.kfuPool, formatPool(pool));

  for (const { level, topics, missing, joins, moves } of levels) {
    const entries = topics.flatMap((t) => t.entries);
    console.log(`${level}: тем с заголовком ${topics.length}, записей ${entries.length}, без повторов ${new Set(entries.map(entryKey)).size}, новых для пула ${pool.filter((p) => p.level === level).length}`);
    for (const name of missing) console.log(`${level}: у темы «${name}» нет заголовка над словами: её слова стоят под предыдущим заголовком`);
    for (const join of joins) console.log(`${level}: склеено в одну запись (${join.rule}, «${join.topic}»): ${join.parts.map((part) => `«${part}»`).join(" + ")}`);
    for (const move of moves) console.log(`${level}: запись «${move.entry}» перенесена из «${move.from}» в «${move.to}»`);
  }
  const kinds = ["word", "phrase", "name", "combination"].map((kind) => `${kind} ${pool.filter((p) => p.kind === kind).length}`).join(", ");
  const words = pool.filter((p) => p.kind === "word");
  const found = (how: string) => words.filter((p) => p.found === how).length;
  console.log(`в пуле: ${pool.length} (${kinds})`);
  console.log(`отдельные слова: в частотном списке ${found("lemma")}, форма глагола из списка ${found("form")}, не найдено ${found("none")} (всего ${words.length}); уже в каталоге: ${pool.filter((p) => p.inCatalog !== "").length}`);
  console.log(`сочетаний со словами из частотного списка: ${pool.filter((p) => p.kind === "combination" && p.words.length > 0).length} из ${pool.filter((p) => p.kind === "combination").length}`);
  console.log(`${FILES.kfuLists}, ${FILES.kfuPool}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
