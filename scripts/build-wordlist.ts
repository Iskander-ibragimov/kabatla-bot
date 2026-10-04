/**
 * Builds the catalog wordlist. Run from the repository root:
 *   npx tsx scripts/build-wordlist.ts candidates          corpus lemmas → data/work/candidates.tsv, cognates.json, dropped-verbs.tsv
 *   npx tsx scripts/build-wordlist.ts examples <слово> [pos] [--min N]   Tatoeba pairs with a form of the word
 *   npx tsx scripts/build-wordlist.ts cut [--force]       data/wordlist.csv → data/levels/l01.csv …, meta.json, data/attested.txt
 *   npx tsx scripts/build-wordlist.ts review              doubtful rows of data/wordlist.csv → data/work/review.tsv
 * The sources (branch `sources`) are expected in data/work/sources/, the Apertium dictionary in data/work/tat-rus.dix.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { parseCsv } from "../src/content/csv";
import { wordKey } from "../src/db/repo";
import { FILES, LEVELS_DIR, levelNumbers, readLevel, readLines, readText, readWordforms, writeLevel, writeMeta, writeText } from "./lib/files";
import { LEVEL_COUNT, LEVEL_SIZE, type LevelMeta, POS_CODES, type Row, coverage, coverageDrops, levelFile, levelSlug, parseLevel } from "./lib/levels";
import {
  type Cognate, WORDLIST_HEADER, type WordlistRow, attestedForms, buildCandidates, checkWordlist, cutLevels, findExamples, formatCandidates, formatDroppedVerbs,
  lookupPos, lostWords, parseDix, parseLemmas, parseTatoeba, reviewWordlist, verbInfinitives,
} from "./lib/wordlist";

const USAGE = "подкоманды: candidates | examples <слово> [pos] [--min N] | cut [--force] | review";
const CANDIDATE_LIMIT = 3500;
const SOURCES_HINT = "распакуйте ветку sources в data/work/sources/";
const DIX_HINT = "скачайте apertium-tat-rus.tat-rus.dix в data/work/tat-rus.dix";

/** data/work/cognates.json: the corpus total and the words set aside as known to a Russian speaker. */
interface CognatesFile { total: number; cognates: (Cognate & { by?: string })[] }

const readCognates = (): CognatesFile | null => (existsSync(FILES.cognates) ? (JSON.parse(readText(FILES.cognates)) as CognatesFile) : null);
const readDix = () => parseDix(readText(FILES.dix, DIX_HINT));

function readWordlist(): WordlistRow[] {
  const text = readText(FILES.wordlist);
  const header = (text.split(/\r?\n/, 1)[0] ?? "").replace(/^\uFEFF/, "");
  if (header !== WORDLIST_HEADER.join(",")) throw new Error(`${FILES.wordlist}: заголовок «${header}», нужен «${WORDLIST_HEADER.join(",")}»`);
  return parseCsv(text) as WordlistRow[];
}

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

/** The level files as the last commit has them: what a deploy has already loaded, or will with the next push. */
function committedLevels(): Row[][] {
  const out: Row[][] = [];
  for (let n = 1; n <= LEVEL_COUNT; n++) {
    try {
      out.push(parseLevel(execFileSync("git", ["show", `HEAD:${LEVELS_DIR}/${levelFile(n)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
    } catch {
      break;
    }
  }
  return out;
}

function cut(force: boolean): void {
  const wordlist = readWordlist();
  const problems = checkWordlist(wordlist);
  if (problems.length) throw new Error(problems.join("\n"));
  const cognates = readCognates();
  if (!cognates) throw new Error(`нет файла ${FILES.cognates} — сначала build-wordlist.ts candidates`);
  const forms = readWordforms();

  const audio = new Map<string, string>();
  for (const n of levelNumbers()) for (const row of readLevel(n)) if (row.audio_file_id) audio.set(wordKey(row.word), row.audio_file_id);
  const { levels } = cutLevels(wordlist.slice(0, LEVEL_COUNT * LEVEL_SIZE), audio);

  const lost = lostWords(committedLevels(), levels);
  if (lost.length) {
    console.error(`слова закоммиченных уровней меняют уровень или пропадают (после деплоя слово каталога не меняет уровень):\n${lost.map((l) => `  ${l}`).join("\n")}`);
    if (!force) throw new Error("уровни не записаны; если эти уровни ещё не выкладывались, повторите с --force");
  }

  const counts = levels.map((_, i) => wordlist.slice(i * LEVEL_SIZE, (i + 1) * LEVEL_SIZE).map((r) => ({ count: Number(r.count) || 0, origin: r.origin.trim() })));
  const meta: LevelMeta[] = coverage(counts, cognates.cognates, cognates.total).map((coveragePct, i) => ({ level: i + 1, coveragePct }));
  const drops = coverageDrops(meta);
  if (drops.length) throw new Error(`покрытие не должно падать от уровня к уровню; уровни не записаны:\n${drops.join("\n")}`);

  levels.forEach((rows, i) => writeLevel(i + 1, rows));
  for (const n of levelNumbers().filter((n) => n > levels.length)) {
    rmSync(`${LEVELS_DIR}/${levelFile(n)}`);
    console.log(`удалён ${levelFile(n)}: в списке нет полных ${n * LEVEL_SIZE} строк`);
  }

  writeMeta(meta);
  const attested = attestedForms(wordlist, forms);
  writeText(FILES.attested, attested.map((form) => `${form}\n`).join(""));

  console.log(`строк в списке: ${wordlist.length}; уровней записано: ${levels.length}; строк вне уровней: ${wordlist.length - levels.length * LEVEL_SIZE}`);
  console.log(`покрытие: ${meta.map((m) => `${levelSlug(m.level)} ${m.coveragePct}%`).join(", ") || "—"}`);
  console.log(`${FILES.attested}: ${attested.length} словоформ`);
}

function review(): void {
  const lines = reviewWordlist(readWordlist(), readDix(), corpusAndExtra());
  writeText(FILES.review, ["word\tkind\tdetail", ...lines.map((l) => [l.word, l.kind, l.detail].join("\t"))].join("\n") + "\n");
  const of = (kind: string) => lines.filter((l) => l.kind === kind).length;
  console.log(`${FILES.review}: строк ${lines.length} (перевод ${of("translation")}, токен ${of("token")}, форма ${of("form")})`);
}

// `… examples слово | head` closes the pipe early: that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => process.exit(e.code === "EPIPE" ? 0 : 1));

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "candidates") candidates();
  else if (command === "examples") examples(args);
  else if (command === "cut") cut(args.includes("--force"));
  else if (command === "review") review();
  else throw new Error(USAGE);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
