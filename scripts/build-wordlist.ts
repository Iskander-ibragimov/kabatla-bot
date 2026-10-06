/**
 * Helps to fill the catalog. Run from the repository root:
 *   npx tsx scripts/build-wordlist.ts candidates          corpus lemmas → data/work/candidates.tsv, cognates.json, dropped-verbs.tsv
 *   npx tsx scripts/build-wordlist.ts candidates --level <a1…c1>   the next words for the level that the catalog lacks → data/work/candidates-<level>.tsv
 *   npx tsx scripts/build-wordlist.ts examples <слово> [pos] [--min N]   Tatoeba pairs with a form of the word
 *   npx tsx scripts/build-wordlist.ts transcribe <слово|фраза> [pos]     the transcription the catalog expects for the headword
 *   npx tsx scripts/build-wordlist.ts attest              examples of data/catalog/*.csv → data/attested.txt
 * The sources (branch `sources`) are expected in data/work/sources/, the Apertium dictionary in data/work/tat-rus.dix,
 * the texts of the KFU specifications (branch `kfu-specs`) in data/work/kfu/.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "./lib/args";
import { POS_CODES, catalogKeys, computedTranscription, levelBySlug } from "./lib/catalog";
import { FILES, levelCandidatesPath, readCatalog, readKfuTexts, readLines, readText, readWordforms, writeText } from "./lib/files";
import { buildPool, parseKfuLevel } from "./lib/kfu";
import { type CandidateSource, formatLevelCandidates, levelCandidates } from "./lib/level-candidates";
import {
  type Cognate, attestedForms, buildCandidates, exampleCounter, findExamples, formatCandidates, formatDroppedVerbs, lookupPos, parseDix, parseLemmas, parseTatoeba,
  rankWords, verbInfinitives,
} from "./lib/wordlist";

const USAGE = "подкоманды: candidates [--level a1…c1] | examples <слово> [pos] [--min N] | transcribe <слово|фраза> [pos] | attest";
const CANDIDATE_LIMIT = 3500;
const SOURCES_HINT = "распакуйте ветку sources в data/work/sources/";
const DIX_HINT = "скачайте apertium-tat-rus.tat-rus.dix в data/work/tat-rus.dix";

/** data/work/cognates.json: the corpus total and the words set aside as known to a Russian speaker. */
interface CognatesFile { total: number; cognates: (Cognate & { by?: string })[] }

const readCognates = (): CognatesFile | null => (existsSync(FILES.cognates) ? (JSON.parse(readText(FILES.cognates)) as CognatesFile) : null);
const readDix = () => parseDix(readText(FILES.dix, DIX_HINT));

/** Example tokens may also be forms approved by hand. */
const corpusAndExtra = (): Set<string> => new Set([...readWordforms(), ...readLines(FILES.attestedExtra).map((form) => form.toLowerCase())]);

function candidates(): void {
  const lemmas = parseLemmas(readText(FILES.lemmas, SOURCES_HINT));
  // Entries of cognates.json without `by: "apertium"` were added by the author: they are kept across runs.
  const byAuthor = (readCognates()?.cognates ?? []).filter((c) => c.by !== "apertium");
  const authored = new Set(byAuthor.map((c) => c.word));
  const built = buildCandidates(lemmas, readWordforms(), readDix(), CANDIDATE_LIMIT, authored);
  const found = new Set(built.cognates.map((c) => c.word));
  const unknown = byAuthor.filter((c) => !found.has(c.word));
  const cognates = [...built.cognates.map((c) => ({ ...c, by: authored.has(c.word) ? "author" : "apertium" })), ...unknown.map((c) => ({ ...c, by: "author" }))];
  writeText(FILES.candidates, formatCandidates(built.candidates));
  writeText(FILES.droppedVerbs, formatDroppedVerbs(built.droppedVerbs));
  writeText(FILES.cognates, `{\n"total": ${built.total},\n"cognates": [\n${cognates.map((c) => JSON.stringify(c)).join(",\n")}\n]\n}\n`);

  const dropped = Object.entries(built.dropped).map(([reason, n]) => `${reason} ${n}`).join(", ");
  console.log(`лемм в списках: ${lemmas.length}, сумма частот ${built.total}`);
  console.log(`убрано: ${dropped}`);
  console.log(`из них глаголов: ${built.droppedVerbs.length} → ${FILES.droppedVerbs}`);
  console.log(`оставлено строк: ${built.kept}`);
  console.log(`совпадают с русским: ${cognates.length} (из них от автора: ${cognates.filter((c) => c.by === "author").length}) → ${FILES.cognates}`);
  console.log(`кандидатов: ${built.candidates.length} → ${FILES.candidates}`);
  for (const c of unknown) console.log(`внимание: слова «${c.word}» из ${FILES.cognates} нет среди лемм корпуса`);
}

/**
 * The next words for one level, by the rules of the spec §3.6 (`levelCandidates`): the words of its KFU list, the very
 * frequent words of the higher KFU lists, the words of its frequency band that no KFU list has — without the words
 * the catalog already holds. Read it again after rows are added to a level file: the list gets shorter.
 */
function candidatesOfLevel(slug: string): void {
  const level = levelBySlug(slug);
  const ranked = rankWords(parseLemmas(readText(FILES.lemmas, SOURCES_HINT)), readWordforms());
  const catalog = catalogKeys(readCatalog());
  const kfu = readKfuTexts().map(({ level: of, text }) => ({ level: of, topics: parseKfuLevel(text).topics }));
  const pool = buildPool(kfu, { ranks: new Map(ranked.map((w) => [w.word, w.rank])), catalog });
  const cognates = new Set((readCognates()?.cognates ?? []).map((c) => c.word));
  const list = levelCandidates(level, { pool, ranked, catalog: new Set(catalog.keys()), cognates, examples: exampleCounter(parseTatoeba(readText(FILES.tatoeba, SOURCES_HINT))) });
  const path = levelCandidatesPath(slug);
  writeText(path, formatLevelCandidates(list));
  const of = (source: CandidateSource) => list.filter((c) => c.source === source);
  console.log(`в каталоге карточек: ${catalog.size}, из них в ${slug}: ${[...catalog.values()].filter((file) => file === slug).length}`);
  console.log(`слов для ${slug}: ${list.length} → ${path}`);
  console.log(`  kfu (список КФУ этого уровня): ${of("kfu").length}, из них нет в частотном списке: ${of("kfu").filter((c) => c.rank === null).length}`);
  console.log(`  kfu-early (списки КФУ старших уровней, по частоте — этот уровень или младше): ${of("kfu-early").length}`);
  console.log(`  freq (частотная полоса уровня, в списках КФУ нет): ${of("freq").length}`);
  console.log(`  отложены как совпадающие с русским: ${list.filter((c) => c.cognate).length}; без предложений Tatoeba: ${list.filter((c) => c.tatoeba === 0).length}`);
}

function examples(args: string[]): void {
  const { words: [word, pos, ...rest], values } = parseArgs(args, { values: ["min"] });
  const minWords = values.min === undefined ? 1 : Number(values.min);
  if (!word || rest.length || !Number.isInteger(minWords)) throw new Error(USAGE);
  if (pos !== undefined && !POS_CODES.includes(pos)) throw new Error(`часть речи «${pos}» не из списка ${POS_CODES.join(", ")}`);
  const pairs = parseTatoeba(readText(FILES.tatoeba, SOURCES_HINT));
  const lookup = pos ?? lookupPos(word, verbInfinitives(parseLemmas(readText(FILES.lemmas, SOURCES_HINT))));
  const hits = findExamples(pairs, word, lookup, { minWords, attested: corpusAndExtra() });
  process.stdout.write(hits.map((hit) => [hit.tatId, hit.form, hit.tat, hit.rus, hit.unattested.length ? `нет в корпусе: ${hit.unattested.join(", ")}` : ""].join("\t") + "\n").join(""));
  if (hits.length === 0) console.error(`пар с формой слова «${word}» нет`);
}

/**
 * Prints the transcription the catalog expects for a headword, as the check of the catalog computes it
 * (`computedTranscription`): by the rule of the bot, and for a phrase (`phr`) without its final sign. Without a part
 * of speech the final sign is dropped too: only a phrase is written with one. The stress the rule does not know
 * (ба́рлык, ке́регез — the guide, rule 10) is then moved by hand; the check allows that and nothing else.
 */
function transcription(args: string[]): void {
  const { words: [word, pos = "phr", ...rest] } = parseArgs(args);
  if (!word || rest.length) throw new Error(USAGE);
  if (!POS_CODES.includes(pos)) throw new Error(`часть речи «${pos}» не из списка ${POS_CODES.join(", ")}`);
  console.log(computedTranscription(word, pos));
}

/**
 * Rewrites data/attested.txt: the word forms of the corpus that the examples of the catalog use. The check of the
 * catalog reads this file, not the corpus, so that it runs where the sources are not at hand (CI, the deploy). Run it
 * after an example is added or changed; a token the corpus does not know stays out, and the check names it.
 */
function attest(): void {
  const catalog = readCatalog();
  if (catalog.length === 0) throw new Error("каталога нет: нет файлов data/catalog/a1.csv … c1.csv");
  const attested = attestedForms(catalog.flatMap((level) => level.rows.map((row) => ({ example_tt: row.example_tt ?? "" }))), readWordforms());
  writeText(FILES.attested, attested.map((form) => `${form}\n`).join(""));
  console.log(`${FILES.attested}: ${attested.length} словоформ из примеров ${catalog.reduce((sum, level) => sum + level.rows.length, 0)} карточек`);
}

// `… examples слово | head` closes the pipe early: that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => process.exit(e.code === "EPIPE" ? 0 : 1));

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "candidates") {
    const { words, values } = parseArgs(args, { values: ["level"] });
    if (words.length) throw new Error(USAGE);
    if (values.level === undefined) candidates();
    else candidatesOfLevel(values.level);
  } else if (command === "examples") examples(args);
  else if (command === "transcribe") transcription(args);
  else if (command === "attest" && args.length === 0) attest();
  else throw new Error(USAGE);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
