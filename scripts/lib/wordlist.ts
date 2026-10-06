/**
 * Sources of new catalog words: candidates from the corpus lemma lists, example lookup in Tatoeba, and the list of
 * word forms the examples of the catalog use. Pure: no I/O; scripts/build-wordlist.ts reads and writes the files.
 */
import { LEVELS } from "../../src/levels/scale";
import { formStems, isAttested, tokenize, wordForm } from "./forms";
import type { LemmaRow, SentencePair } from "./sources";
import { dictionaryForm, finiteForms, verbInfinitive } from "./tatar-verbs";

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

/** The lemma rows of the corpus joined by word. */
interface Merged {
  /** Word in dictionary form → project part of speech → count, in the order the words first stand in the lists. */
  words: Map<string, Map<string, number>>;
  total: number;
  kept: number;
  dropped: Record<DropReason, number>;
  droppedVerbs: DroppedVerb[];
}

/**
 * Joins the rows of the corpus lemma lists by word. Dropped: the lists of unrecognised tokens, proper nouns,
 * abbreviations and ideograms; lemmas with a digit, a Latin letter, a capital, of one letter; lemmas whose dictionary
 * form is not among the corpus word forms (stem fragments). Verbs go to the infinitive. Rows of one word (ал `v` and
 * `vaux`, ул `prn` and `n`) are kept by part of speech.
 */
function mergeLemmas(lemmas: LemmaRow[], forms: ReadonlySet<string>): Merged {
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
  return { words, total, kept, dropped, droppedVerbs };
}

const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
/** The parts of speech of a merged word, the one with the highest count first, and the sum of their counts. */
function wordCounts(byPos: Map<string, number>): { parts: [string, number][]; count: number } {
  return { parts: [...byPos].sort((a, b) => b[1] - a[1]), count: [...byPos.values()].reduce((sum, c) => sum + c, 0) };
}

/**
 * Merges the corpus lemma lists into one list by frequency (`mergeLemmas` says what is dropped). The rows of one word
 * are added up: the word gets the part of speech with the highest count, `also` names the rest.
 * A word that Apertium translates, in its main part of speech, by the same word goes to `cognates`, and so does every
 * word of `known` (cognates named by hand); neither is among the candidates.
 */
export function buildCandidates(lemmas: LemmaRow[], forms: ReadonlySet<string>, dix: Dix, limit = 3500, known: ReadonlySet<string> = new Set()): Candidates {
  const { words, total, kept, dropped, droppedVerbs } = mergeLemmas(lemmas, forms);
  const candidates: Candidate[] = [];
  const cognates: Cognate[] = [];
  for (const [word, byPos] of words) {
    const { parts: [main, ...rest], count } = wordCounts(byPos);
    const exact = [...new Set([main!, ...rest].flatMap(([pos]) => dix.get(word)?.get(pos) ?? []))];
    const translations = exact.length ? exact : apertium(dix, word);
    if (known.has(word) || isCognate(word, dix.get(word)?.get(main![0]) ?? [])) cognates.push({ word, count });
    else candidates.push({ word, pos: main![0], count, apertium: translations, also: rest.map(([pos, c]) => `${pos} ${c}`).join(", ") });
  }
  return { candidates: candidates.sort(byCount).slice(0, limit), cognates: cognates.sort(byCount), total, kept, dropped, droppedVerbs: droppedVerbs.sort(byCount) };
}

/** A word of the corpus in dictionary form: its main part of speech, the count of all its rows, and its place in the frequency list, from 1. */
export interface RankedWord { word: string; pos: string; count: number; rank: number }

/**
 * The frequency list of the corpus the levels are banded by (spec §3.6): every word `buildCandidates` keeps, the
 * look-alikes of Russian among them, most frequent first. Words with one count stand in the order of the lists, as the
 * candidates do, so a candidate is before another here exactly when it is in `candidates.tsv`.
 */
export function rankWords(lemmas: LemmaRow[], forms: ReadonlySet<string>): RankedWord[] {
  const words = [...mergeLemmas(lemmas, forms).words].map(([word, byPos]) => {
    const { parts, count } = wordCounts(byPos);
    return { word, pos: parts[0]![0], count };
  });
  return words.sort(byCount).map((w, i) => ({ ...w, rank: i + 1 }));
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

/**
 * Finite form → the name of action of its verb, for the verbs of the corpus the candidates keep: the present of the
 * third person and its negative (ошый, ошамый → ошау), where the corpus has the form among its word forms. A word
 * list that prints a verb so is read back to the verb with it. A form of two verbs goes to the more frequent one.
 */
export function finiteVerbForms(lemmas: LemmaRow[], forms: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const verbs = lemmas.filter((l) => POS_MAP[l.pos] === "v" && dropReason(l.lemma, "v", forms) === null).sort(byCount);
  for (const { lemma } of verbs) {
    for (const form of finiteForms(lemma)) if (forms.has(form) && !out.has(form)) out.set(form, verbInfinitive(lemma));
  }
  return out;
}

/** Word → its place in the frequency list. */
export const rankMap = (ranked: readonly RankedWord[]): Map<string, number> => new Map(ranked.map((w) => [w.word, w.rank]));

/**
 * The level a place in the frequency list of the corpus gives a word: 1–500 → A1, 501–1 350 → A2, 1 351–2 200 → B1,
 * 2 201–3 000 → B2, 3 001–3 850 → C1 — the sizes of the levels, added up. Null for a place after the last band and
 * for a word without a place.
 */
export function frequencyBand(rank: number | null): number | null {
  if (rank === null || rank < 1) return null;
  let last = 0;
  for (const level of LEVELS) {
    last += level.size;
    if (rank <= last) return level.no;
  }
  return null;
}

/**
 * A counter of example sentences: for a word, the number of Tatoeba sentences `findExamples` looks through that hold
 * a form of it — each Tatar sentence once, none longer than `maxWords`. Zero means `examples <слово>` prints nothing.
 */
export function exampleCounter(pairs: SentencePair[], maxWords = 8): (word: string, pos: string) => number {
  const sentences = new Map<number, string>();
  for (const pair of pairs) {
    const length = tokenize(pair.tat).length;
    if (length >= 1 && length <= maxWords && !sentences.has(pair.tatId)) sentences.set(pair.tatId, pair.tat);
  }
  /** Token → the sentences it stands in: a word of one token is counted over the distinct tokens, not over the sentences. */
  const byToken = new Map<string, number[]>();
  for (const [id, text] of sentences) {
    for (const token of new Set(tokenize(text))) {
      const ids = byToken.get(token);
      if (ids) ids.push(id);
      else byToken.set(token, [id]);
    }
  }
  return (word, pos) => {
    if (tokenize(word).length !== 1) return [...sentences.values()].filter((text) => wordForm(text, word, pos, true) !== null).length;
    const stems = formStems(tokenize(word)[0]!, pos, true);
    const found = new Set<number>();
    for (const [token, ids] of byToken) {
      if (stems.some((stem) => token.startsWith(stem))) for (const id of ids) found.add(id);
    }
    return found.size;
  };
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
