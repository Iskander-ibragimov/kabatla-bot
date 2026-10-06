/**
 * Helps to fill the catalog. Run from the repository root:
 *   npx tsx scripts/build-wordlist.ts candidates          corpus lemmas → data/work/candidates.tsv, cognates.json, dropped-verbs.tsv
 *   npx tsx scripts/build-wordlist.ts examples <слово> [pos] [--min N]   Tatoeba pairs with a form of the word
 *   npx tsx scripts/build-wordlist.ts attest              examples of data/catalog/*.csv → data/attested.txt
 * The sources (branch `sources`) are expected in data/work/sources/, the Apertium dictionary in data/work/tat-rus.dix.
 */
import { existsSync } from "node:fs";
import { POS_CODES } from "./lib/catalog";
import { FILES, readCatalog, readLines, readText, readWordforms, writeText } from "./lib/files";
import {
  type Cognate, attestedForms, buildCandidates, findExamples, formatCandidates, formatDroppedVerbs, lookupPos, parseDix, parseLemmas, parseTatoeba, verbInfinitives,
} from "./lib/wordlist";

const USAGE = "подкоманды: candidates | examples <слово> [pos] [--min N] | attest";
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

function examples(args: string[]): void {
  const min = args.indexOf("--min");
  const minWords = min < 0 ? 1 : Number(args[min + 1]);
  const [word, pos] = min < 0 ? args : args.filter((_, i) => i !== min && i !== min + 1);
  if (!word || !Number.isInteger(minWords)) throw new Error(USAGE);
  if (pos !== undefined && !POS_CODES.includes(pos)) throw new Error(`часть речи «${pos}» не из списка ${POS_CODES.join(", ")}`);
  const pairs = parseTatoeba(readText(FILES.tatoeba, SOURCES_HINT));
  const lookup = pos ?? lookupPos(word, verbInfinitives(parseLemmas(readText(FILES.lemmas, SOURCES_HINT))));
  const hits = findExamples(pairs, word, lookup, { minWords, attested: corpusAndExtra() });
  process.stdout.write(hits.map((hit) => [hit.tatId, hit.form, hit.tat, hit.rus, hit.unattested.length ? `нет в корпусе: ${hit.unattested.join(", ")}` : ""].join("\t") + "\n").join(""));
  if (hits.length === 0) console.error(`пар с формой слова «${word}» нет`);
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
  if (command === "candidates") candidates();
  else if (command === "examples") examples(args);
  else if (command === "attest") attest();
  else throw new Error(USAGE);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
