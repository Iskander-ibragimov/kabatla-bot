/**
 * Reads the word lists of the KFU specifications A1–C1 («Лексический минимум», spec §3.6) and joins them into a pool
 * of entries the catalog is filled from. Run from the repository root:
 *   npx tsx scripts/kfu-lists.ts
 * Reads data/work/kfu/s_A1.layout.txt … s_C1.layout.txt (branch `kfu-specs`), the corpus lists in data/work/sources/
 * (branch `sources`) and the catalog. Writes, both under data/work/, which git ignores:
 *   data/work/kfu/lists.json   by level: the topics as printed, with their entries in the order of the file, and the
 *                              topics of the specification that have no heading over the words
 *   data/work/kfu/pool.tsv     every entry once, with the lowest level it stands at: entry, level, kfu_topic (the
 *                              heading), topic (of the catalog), kind (word | phrase | name | combination), lemma,
 *                              rank (place in the frequency list, for a word the corpus has), in_catalog (the level
 *                              file that already holds it), words (of a combination, the ones the corpus has)
 * The lists are the work of KFU without a declared licence: neither file is committed, and the bot never shows them.
 */
import { catalogKeys } from "./lib/catalog";
import { FILES, readCatalog, readKfuTexts, readText, readTopics, readWordforms, writeText } from "./lib/files";
import { type KfuLevel, KFU_TOPICS, buildPool, entryKey, formatPool, kfuTopicSlug, parseKfuLevel } from "./lib/kfu";
import { parseLemmas, rankWords } from "./lib/wordlist";

const SOURCES_HINT = "распакуйте ветку sources в data/work/sources/";

function main(): void {
  const levels = readKfuTexts().map(({ level, text }): KfuLevel & { level: string } => ({ level, ...parseKfuLevel(text) }));
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

  const ranked = rankWords(parseLemmas(readText(FILES.lemmas, SOURCES_HINT)), readWordforms());
  const pool = buildPool(levels, { ranks: new Map(ranked.map((w) => [w.word, w.rank])), catalog: catalogKeys(readCatalog()) });

  const lists = Object.fromEntries(levels.map(({ level, topics, missing }) => [level, {
    topics: topics.map((t) => ({ topic: t.heading, name: t.name, slug: kfuTopicSlug(level, t.name), entries: t.entries })), missing,
  }]));
  writeText(FILES.kfuLists, `${JSON.stringify(lists, null, 1)}\n`);
  writeText(FILES.kfuPool, formatPool(pool));

  for (const { level, topics, missing } of levels) {
    const entries = topics.flatMap((t) => t.entries);
    console.log(`${level}: тем с заголовком ${topics.length}, записей ${entries.length}, без повторов ${new Set(entries.map(entryKey)).size}, новых для пула ${pool.filter((p) => p.level === level).length}`);
    for (const name of missing) console.log(`${level}: у темы «${name}» нет заголовка над словами: её слова стоят под предыдущим заголовком`);
  }
  const kinds = ["word", "phrase", "name", "combination"].map((kind) => `${kind} ${pool.filter((p) => p.kind === kind).length}`).join(", ");
  const words = pool.filter((p) => p.kind === "word");
  console.log(`в пуле: ${pool.length} (${kinds})`);
  console.log(`отдельных слов с местом в частотном списке: ${words.filter((p) => p.rank !== null).length} из ${words.length}; уже в каталоге: ${pool.filter((p) => p.inCatalog !== "").length}`);
  console.log(`${FILES.kfuLists}, ${FILES.kfuPool}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
