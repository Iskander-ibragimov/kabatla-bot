/**
 * Building the wordlist: candidates from the corpus lemma lists, example lookup in Tatoeba, cutting the reviewed
 * wordlist into levels, and the list of doubtful rows. Pure: no I/O; scripts/build-wordlist.ts reads and writes the files.
 */
import { transcribe } from "../../src/content/transcribe";
import { wordKey } from "../../src/db/repo";
import { levelSlug } from "../../src/users/service";
import { LEVEL_SIZE, type Row, isAttested, tokenize, wordForm } from "./levels";
import type { LemmaRow, SentencePair } from "./sources";
import { dictionaryForm, verbInfinitive } from "./tatar-verbs";

/** Corpus list suffix (and Apertium tag) → project part-of-speech code. Lists that are not here are dropped whole. */
export const POS_MAP: Readonly<Record<string, string>> = {
  n: "n", v: "v", vaux: "v", cop: "v", adj: "adj", adv: "adv", postadv: "adv", cnjadv: "adv", prn: "pron", det: "pron",
  num: "num", post: "post", cnjcoo: "conj", cnjsub: "conj", ij: "intj",
};
const TATAR_WORD = /^[а-яёәөүҗңһ]+(?:-[а-яёәөүҗңһ]+)*$/;

/** lemmas.tsv: `count\tlemma\tpos`. */
export function parseLemmas(tsv: string): LemmaRow[] {
  const out: LemmaRow[] = [];
  for (const line of tsv.split("\n")) {
    const [count, lemma, pos] = line.replace(/\r$/, "").split("\t");
    if (count && lemma && pos && /^\d+$/.test(count)) out.push({ count: Number(count), lemma, pos });
  }
  return out;
}

/** tatoeba.tsv: `tat_id\ttat\trus_id\trus`. */
export function parseTatoeba(tsv: string): SentencePair[] {
  const out: SentencePair[] = [];
  for (const line of tsv.split("\n")) {
    const [tatId, tat, rusId, rus] = line.replace(/\r$/, "").split("\t");
    if (tatId && tat && rusId && rus && /^\d+$/.test(tatId)) out.push({ tatId: Number(tatId), tat, rusId: Number(rusId), rus });
  }
  return out;
}

/** Apertium tat-rus entries: word in dictionary form → project part of speech → Russian translations. */
export type Dix = Map<string, Map<string, string[]>>;

/**
 * Reads `<e><p><l>lemma<s n="pos"/>…</l><r>translation<s …/></r></p></e>` entries; `<b/>` is a space, and the
 * superscript digit that tells Russian homonyms apart (год², мир¹) is dropped.
 */
export function parseDix(xml: string): Dix {
  const dix: Dix = new Map();
  const text = (side: string) => side.replace(/<b\/>/g, " ").replace(/<[^>]*>/g, "").replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]/g, "").trim();
  for (const [, left, right] of xml.matchAll(/<l>(.*?)<\/l>\s*<r>(.*?)<\/r>/g)) {
    const pos = POS_MAP[/<s n="([^"]+)"\/>/.exec(left!)?.[1] ?? ""];
    const lemma = text(left!);
    const translation = text(right!);
    if (!pos || !lemma || !translation) continue;
    const word = dictionaryForm(lemma, pos);
    const byPos = dix.get(word) ?? new Map<string, string[]>();
    const list = byPos.get(pos) ?? [];
    if (!list.includes(translation)) list.push(translation);
    dix.set(word, byPos.set(pos, list));
  }
  return dix;
}

/** Apertium translations of a word: of the given part of speech, or of every one when that has no entry (or none is given). */
export function apertium(dix: Dix, word: string, pos?: string): string[] {
  const byPos = dix.get(word);
  if (!byPos) return [];
  const exact = pos === undefined ? undefined : byPos.get(pos);
  return exact ?? [...new Set([...byPos.values()].flat())];
}

export interface Candidate { word: string; pos: string; count: number; apertium: string[]; also: string }
export type DropReason = "list" | "digits" | "latin" | "upper" | "short" | "symbols" | "unattested";
export interface Cognate { word: string; count: number }
/** A verb row of the corpus lists that did not become a candidate: its stem, the infinitive that was tried, and why. */
export interface DroppedVerb { count: number; stem: string; infinitive: string; reason: DropReason }
export interface Candidates {
  /** Words to translate, most frequent first. */
  candidates: Candidate[];
  /** Words a Russian speaker knows already (район, президент): set aside, counted in the coverage. */
  cognates: Cognate[];
  /** Sum of the counts of every lemma row, dropped ones included. */
  total: number;
  /** Lemma rows that went into the candidates and the cognates. */
  kept: number;
  dropped: Record<DropReason, number>;
  /**
   * The dropped verb rows, most frequent first. The infinitive is built by rule, so a stem the rule does not cover
   * (курык → курку) or the first word of a compound verb (кабул [итү]) is only visible here.
   */
  droppedVerbs: DroppedVerb[];
}

/**
 * True if the translations say the word is the same in Russian: one of them is the word itself and the rest are its
 * derivatives (район — район, районный). A word with a translation of its own stays a candidate (май — май, масло).
 */
function isCognate(word: string, translations: string[]): boolean {
  const stem = word.slice(0, Math.max(4, word.length - 1));
  return translations.includes(word) && translations.every((t) => t === word || t.startsWith(stem));
}

function dropReason(lemma: string, pos: string | undefined, forms: ReadonlySet<string>): DropReason | null {
  if (!pos) return "list";
  if (/\d/.test(lemma)) return "digits";
  if (/[a-z]/i.test(lemma)) return "latin";
  if (lemma !== lemma.toLowerCase()) return "upper";
  if ([...lemma].length === 1) return "short";
  if (!TATAR_WORD.test(lemma)) return "symbols";
  return forms.has(dictionaryForm(lemma, pos)) ? null : "unattested";
}

/**
 * Merges the corpus lemma lists into one list by frequency. Dropped: the lists of unrecognised tokens, proper nouns,
 * abbreviations and ideograms; lemmas with a digit, a Latin letter, a capital, of one letter; lemmas whose dictionary
 * form is not among the corpus word forms (stem fragments). Verbs go to the infinitive. Rows of one word (ал `v` and
 * `vaux`, ул `prn` and `n`) are added up: the word gets the part of speech with the highest count, `also` names the rest.
 * A word that Apertium translates, in its main part of speech, by the same word goes to `cognates`, and so does every
 * word of `known` (cognates named by hand); neither is among the candidates.
 */
export function buildCandidates(lemmas: LemmaRow[], forms: ReadonlySet<string>, dix: Dix, limit = 3500, known: ReadonlySet<string> = new Set()): Candidates {
  const dropped: Record<DropReason, number> = { list: 0, digits: 0, latin: 0, upper: 0, short: 0, symbols: 0, unattested: 0 };
  const droppedVerbs: DroppedVerb[] = [];
  const words = new Map<string, Map<string, number>>();
  let total = 0;
  let kept = 0;
  for (const { count, lemma, pos: list } of lemmas) {
    total += count;
    const pos = POS_MAP[list];
    const reason = dropReason(lemma, pos, forms);
    if (reason || !pos) {
      dropped[reason ?? "list"] += 1;
      if (reason && pos === "v") droppedVerbs.push({ count, stem: lemma, infinitive: verbInfinitive(lemma), reason });
      continue;
    }
    kept += 1;
    const word = dictionaryForm(lemma, pos);
    const byPos = words.get(word) ?? new Map<string, number>();
    words.set(word, byPos.set(pos, (byPos.get(pos) ?? 0) + count));
  }

  const candidates: Candidate[] = [];
  const cognates: Cognate[] = [];
  for (const [word, byPos] of words) {
    const [main, ...rest] = [...byPos].sort((a, b) => b[1] - a[1]);
    const count = [...byPos.values()].reduce((sum, c) => sum + c, 0);
    const exact = [...new Set([main!, ...rest].flatMap(([pos]) => dix.get(word)?.get(pos) ?? []))];
    const translations = exact.length ? exact : apertium(dix, word);
    if (known.has(word) || isCognate(word, dix.get(word)?.get(main![0]) ?? [])) cognates.push({ word, count });
    else candidates.push({ word, pos: main![0], count, apertium: translations, also: rest.map(([pos, c]) => `${pos} ${c}`).join(", ") });
  }
  const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
  return { candidates: candidates.sort(byCount).slice(0, limit), cognates: cognates.sort(byCount), total, kept, dropped, droppedVerbs: droppedVerbs.sort(byCount) };
}

export function formatCandidates(candidates: Candidate[]): string {
  const lines = candidates.map((c, i) => [i + 1, c.word, c.pos, c.count, c.apertium.join("; "), c.also].join("\t"));
  return ["rank\tword\tpos\tcount\tapertium\talso", ...lines].join("\n") + "\n";
}

/** The infinitives of the verbs of the corpus lemma lists. */
export function verbInfinitives(lemmas: LemmaRow[]): Set<string> {
  return new Set(lemmas.filter((l) => POS_MAP[l.pos] === "v").map((l) => dictionaryForm(l.lemma, "v")));
}

/**
 * The part of speech to look a word up with when the caller names none: `v` if the word, or the last word of a
 * compound (ярдәм итү), is the infinitive of a corpus verb, and none otherwise. An ending in -у is not enough: бу, су.
 */
export function lookupPos(word: string, infinitives: ReadonlySet<string>): string {
  return infinitives.has(tokenize(word).pop() ?? "") ? "v" : "";
}

export function formatDroppedVerbs(verbs: DroppedVerb[]): string {
  return ["count\tstem\tinfinitive\treason", ...verbs.map((v) => [v.count, v.stem, v.infinitive, v.reason].join("\t"))].join("\n") + "\n";
}

export interface ExampleHit { tatId: number; tat: string; rus: string; form: string; unattested: string[] }

/**
 * Tatoeba pairs whose Tatar sentence holds a form of the word. Tatar is agglutinative, so a form is a token that
 * begins with the word (китап → китапны, китабы) or, for a verb, with one of its stems (бару → барам, эшләү → эшли).
 * Sentences with the word exactly as given come first, then from short to long. Sentences longer than `maxWords` or
 * shorter than `minWords` are skipped. With `attested`, each hit names its tokens the corpus does not know: such a
 * sentence fails validation.
 */
export function findExamples(
  pairs: SentencePair[], word: string, pos: string, opts: { limit?: number; minWords?: number; maxWords?: number; attested?: ReadonlySet<string> } = {},
): ExampleHit[] {
  const { limit = 30, minWords = 1, maxWords = 8, attested } = opts;
  const target = tokenize(word).join(" ");
  const seen = new Set<number>();
  const hits: (ExampleHit & { rank: number; words: number })[] = [];
  for (const pair of pairs) {
    const tokens = tokenize(pair.tat);
    if (tokens.length < Math.max(1, minWords) || tokens.length > maxWords || seen.has(pair.tatId)) continue;
    const form = wordForm(pair.tat, word, pos, true);
    if (form === null) continue;
    seen.add(pair.tatId);
    const unattested = attested ? [...new Set(tokens)].filter((token) => !isAttested(token, attested)) : [];
    hits.push({ tatId: pair.tatId, tat: pair.tat, rus: pair.rus, form, unattested, rank: pos !== "v" && form === target ? 0 : 1, words: tokens.length });
  }
  hits.sort((a, b) => a.rank - b.rank || a.words - b.words || a.tat.length - b.tat.length || a.tatId - b.tatId);
  return hits.slice(0, limit).map(({ tatId, tat, rus, form, unattested }) => ({ tatId, tat, rus, form, unattested }));
}

export const WORDLIST_HEADER = ["word", "pos", "translation", "example_tt", "example_ru", "example_src", "count", "origin", "transcription"] as const;
export type WordlistRow = Record<(typeof WORDLIST_HEADER)[number], string>;

/**
 * Rows of the wordlist whose `count` or `origin` would spoil the coverage figure, as `wordlist:5 <what is wrong>`
 * (the number is the line of the file). The fields that go into the level files are checked there, by `checkLevels`.
 */
export function checkWordlist(rows: WordlistRow[]): string[] {
  const errors: string[] = [];
  rows.forEach((row, i) => {
    if (!/^\d*$/.test(row.count.trim())) errors.push(`wordlist:${i + 2} count «${row.count}»: нужно целое число или пусто`);
    if (!["corpus", "core"].includes(row.origin.trim())) errors.push(`wordlist:${i + 2} origin «${row.origin}»: нужно corpus или core`);
  });
  return errors;
}

/**
 * Cuts the wordlist into levels of 100 in file order; `rest` is the number of rows after the last full level.
 * The transcription comes from the wordlist column or, when that is empty, from the rules; `audio` (word key → file id)
 * carries over the audio already attached to a word.
 */
export function cutLevels(wordlist: WordlistRow[], audio: ReadonlyMap<string, string>): { levels: Row[][]; rest: number } {
  const rows = wordlist.map((r): Row => {
    const word = r.word.trim();
    return {
      word, transcription: r.transcription.trim() || transcribe(word), pos: r.pos.trim(), translation: r.translation.trim(),
      example_tt: r.example_tt.trim(), example_ru: r.example_ru.trim(), example_src: r.example_src.trim(), audio_file_id: audio.get(wordKey(word)) ?? "",
    };
  });
  const full = Math.floor(rows.length / LEVEL_SIZE);
  return { levels: Array.from({ length: full }, (_, i) => rows.slice(i * LEVEL_SIZE, (i + 1) * LEVEL_SIZE)), rest: rows.length - full * LEVEL_SIZE };
}

/**
 * Words of the level files on disk that a new cut would move to another level or drop. Once a level is deployed
 * its words must stay in it: the seed never deletes or moves a note, so the old card would stay in the database.
 */
export function lostWords(before: Row[][], after: Row[][]): string[] {
  const now = new Map<string, number>();
  after.forEach((rows, i) => { for (const row of rows) now.set(wordKey(row.word), i + 1); });
  const out: string[] = [];
  before.forEach((rows, i) => {
    for (const row of rows) {
      const level = now.get(wordKey(row.word));
      if (level !== i + 1) out.push(`${levelSlug(i + 1)}: «${row.word.trim()}» ${level ? `→ ${levelSlug(level)}` : "убрано"}`);
    }
  });
  return out;
}

/** The tokens of the examples that are among the corpus word forms, sorted, each once: the content of data/attested.txt. */
export function attestedForms(rows: { example_tt: string }[], forms: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    for (const token of tokenize(row.example_tt)) {
      for (const form of forms.has(token) ? [token] : token.split("-")) if (forms.has(form)) out.add(form);
    }
  }
  return [...out].sort();
}

export interface ReviewLine { word: string; kind: "translation" | "token" | "form"; detail: string }

const russianWords = (text: string): string[] => text.toLowerCase().replace(/ё/g, "е").match(/[а-я]+/g) ?? [];
/** Two Russian words agree when they are equal or share their first four letters (школа — школьный). */
const agree = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));

/**
 * Rows of the wordlist a person should look at: a translation that shares no word with Apertium's, an example token
 * the corpus does not attest, an example without a form of the word.
 */
export function reviewWordlist(rows: WordlistRow[], dix: Dix, attested: ReadonlySet<string>): ReviewLine[] {
  const out: ReviewLine[] = [];
  for (const row of rows) {
    const word = row.word.trim();
    const theirs = apertium(dix, wordKey(word), row.pos);
    const ours = russianWords(row.translation);
    if (theirs.length && !theirs.flatMap(russianWords).some((t) => ours.some((o) => agree(o, t)))) {
      out.push({ word, kind: "translation", detail: `«${row.translation}» — Apertium: ${theirs.join("; ")}` });
    }
    if (row.example_tt.trim() === "") continue;
    for (const token of new Set(tokenize(row.example_tt))) if (!isAttested(token, attested)) out.push({ word, kind: "token", detail: token });
    if (wordForm(row.example_tt, word, row.pos) === null) out.push({ word, kind: "form", detail: row.example_tt });
  }
  return out;
}
