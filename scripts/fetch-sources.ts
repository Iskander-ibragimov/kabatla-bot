/**
 * Downloads the raw dictionary sources and writes them to out/ (run only in GitHub Actions: the hosts are not
 * reachable from the workspace). Needs `bzip2` and `unzip` on PATH (present on ubuntu runners).
 *   out/lemmas.tsv       count\tlemma\tpos        (pos = suffix of the corpus list file name, lower-case)
 *   out/wordforms.txt.gz one word form per line, frequency >= 3
 *   out/tatoeba.tsv      tat_id\ttat\trus_id\trus
 *   out/STATS.md
 */
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { join } from "node:path";
import { pairSentences, parseLemmaLine, parseLinks, parseSentences, parseWordformLine } from "./lib/sources";

const CORPUS_PAGE = "https://www.corpus.tatar/stat_en.htm";
const TATOEBA = "https://downloads.tatoeba.org/exports/per_language";
const TATOEBA_FILES = [`${TATOEBA}/tat/tat_sentences.tsv.bz2`, `${TATOEBA}/rus/rus_sentences.tsv.bz2`, `${TATOEBA}/tat/tat-rus_links.tsv.bz2`];
const MIN_WORDFORM_COUNT = 3;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const OUT = "out";
const WORK = "work";

const downloaded: string[] = [];

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": "kabatla-bot-fetch-sources" } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!file.write(value)) await once(file, "drain");
  }
  file.end();
  await once(file, "finish");
  downloaded.push(url);
  console.log(`downloaded ${url} (${statSync(dest).size} bytes)`);
}

const baseName = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const bunzip = (file: string) => execFileSync("bzip2", ["-dc", file], { encoding: "utf8", maxBuffer: 1 << 30 });

function checkSize(file: string): number {
  const size = statSync(file).size;
  if (size > MAX_FILE_BYTES) throw new Error(`${file} is ${size} bytes, over the 50 MB limit`);
  return size;
}

async function discoverLinks(): Promise<string[]> {
  const html = await (await fetch(CORPUS_PAGE, { headers: { "user-agent": "kabatla-bot-fetch-sources" } })).text();
  const links = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']*stat\/[^"']+\.(?:txt|zip))["']/giu)) links.add(new URL(m[1]!, CORPUS_PAGE).href);
  return [...links];
}

async function buildLemmas(urls: string[]): Promise<{ pos: string; lists: number; lemmas: number; sum: number }[]> {
  const lists = urls.flatMap((url) => {
    const m = /lemmas_frequency_([a-z]+)\.txt$/i.exec(url);
    return m ? [{ url, pos: m[1]!.toLowerCase() }] : [];
  });
  if (lists.length === 0) throw new Error("no lemmas_frequency_<pos>.txt links found on " + CORPUS_PAGE);
  const lines: string[] = [];
  const stats: { pos: string; lists: number; lemmas: number; sum: number }[] = [];
  for (const { url, pos } of lists) {
    const dest = join(WORK, baseName(url));
    await download(url, dest);
    const rows = readFileSync(dest, "utf8").split("\n").map((l) => parseLemmaLine(l, pos)).filter((r) => r !== null);
    if (rows.length === 0) throw new Error(`${url}: no parsable lines`);
    for (const r of rows) lines.push(`${r.count}\t${r.lemma}\t${r.pos}`);
    stats.push({ pos, lists: 1, lemmas: rows.length, sum: rows.reduce((s, r) => s + r.count, 0) });
  }
  writeFileSync(join(OUT, "lemmas.tsv"), lines.join("\n") + "\n");
  return stats;
}

async function buildWordforms(urls: string[]): Promise<number> {
  const url = urls.find((u) => /words_frequency_full\.txt\.zip$/i.test(u));
  if (!url) throw new Error("no words_frequency_full.txt.zip link found on " + CORPUS_PAGE);
  const zip = join(WORK, baseName(url));
  await download(url, zip);
  console.log(execFileSync("unzip", ["-l", zip], { encoding: "utf8" }));
  const unzip = spawn("unzip", ["-p", zip], { stdio: ["ignore", "pipe", "inherit"] });
  const gz = createGzip({ level: 9 });
  const outFile = createWriteStream(join(OUT, "wordforms.txt.gz"));
  gz.pipe(outFile);
  let kept = 0;
  let seen = 0;
  for await (const line of createInterface({ input: unzip.stdout, crlfDelay: Infinity })) {
    if (seen++ < 8) console.log(`wordforms raw line ${seen}: ${JSON.stringify(line.slice(0, 120))}`);
    const form = parseWordformLine(line, MIN_WORDFORM_COUNT);
    if (form === null) continue;
    kept++;
    if (!gz.write(form + "\n")) await once(gz, "drain");
  }
  const [code] = (await once(unzip, "close")) as [number | null];
  if (code !== 0) throw new Error(`unzip exited with ${code}`);
  gz.end();
  await once(outFile, "finish");
  if (kept === 0) throw new Error("word-form list gave no lines");
  return kept;
}

async function buildTatoeba(): Promise<number> {
  const [tatUrl, rusUrl, linksUrl] = TATOEBA_FILES as [string, string, string];
  const files = new Map<string, string>();
  for (const url of TATOEBA_FILES) {
    const dest = join(WORK, baseName(url));
    await download(url, dest);
    files.set(url, dest);
  }
  const tat = parseSentences(bunzip(files.get(tatUrl)!));
  const rus = parseSentences(bunzip(files.get(rusUrl)!));
  const links = parseLinks(bunzip(files.get(linksUrl)!));
  const pairs = pairSentences(tat, rus, links);
  writeFileSync(join(OUT, "tatoeba.tsv"), pairs.map((p) => `${p.tatId}\t${p.tat}\t${p.rusId}\t${p.rus}`).join("\n") + "\n");
  console.log(`tatoeba: ${tat.size} tat sentences, ${rus.size} rus sentences, ${links.length} links, ${pairs.length} pairs`);
  return pairs.length;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const urls = await discoverLinks();
  console.log(`found ${urls.length} stat links`);
  const lemmaStats = await buildLemmas(urls);
  const wordforms = await buildWordforms(urls);
  const pairs = await buildTatoeba();
  if (pairs === 0) throw new Error("no Tatoeba tat-rus pairs");

  const sizes = ["lemmas.tsv", "wordforms.txt.gz", "tatoeba.tsv"].map((f) => `| ${f} | ${checkSize(join(OUT, f))} |`);
  const stats = [
    "# Источники словаря",
    "",
    "## Леммы по частям речи (pos = суффикс файла списка)",
    "",
    "| pos | лемм | сумма частот |",
    "|---|---:|---:|",
    ...lemmaStats.map((s) => `| ${s.pos} | ${s.lemmas} | ${s.sum} |`),
    `| всего | ${lemmaStats.reduce((a, s) => a + s.lemmas, 0)} | ${lemmaStats.reduce((a, s) => a + s.sum, 0)} |`,
    "",
    `Словоформ с частотой не меньше ${MIN_WORDFORM_COUNT}: ${wordforms}`,
    "",
    `Пар Tatoeba (tat–rus): ${pairs}`,
    "",
    "## Размеры файлов, байт",
    "",
    "| файл | размер |",
    "|---|---:|",
    ...sizes,
    "",
    "## Скачано",
    "",
    ...downloaded.map((u) => `- ${u}`),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "STATS.md"), stats);
  console.log(stats);
}

main().catch((e) => { console.error(e); process.exit(1); });
