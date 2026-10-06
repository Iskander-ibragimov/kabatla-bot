/**
 * The next words for a level of the catalog (spec §3.6, rules 1–4): the words of the KFU list of the level, the very
 * frequent words of the higher KFU lists, the words of the frequency band of the level that no KFU list has, and
 * what is left of the lower bands.
 * Pure: no I/O; scripts/build-wordlist.ts reads the sources and writes the table.
 */
import { wordKey } from "../../src/db/repo";
import { LEVELS } from "../../src/levels/scale";
import { type PoolEntry, entryKey } from "./kfu-pool";
import { type RankedWord, frequencyBand } from "./wordlist";

/**
 * `kfu`: a word of the KFU list of the level; `kfu-early`: a word of a higher KFU list offered here for its frequency;
 * `freq`: a word of the frequency band of the level that no KFU list has; `freq-late`: such a word of a lower band
 * that the catalog still lacks.
 */
export type CandidateSource = "kfu" | "kfu-early" | "freq" | "freq-late";
export interface LevelCandidate {
  /** The word in dictionary form. */
  word: string;
  source: CandidateSource;
  /** The heading of the KFU list the word first stands under, and the catalog topic it is mapped to; empty for `freq`. */
  kfuTopic: string;
  topic: string;
  /** Place in the frequency list of the corpus; null for a word the corpus lacks. */
  rank: number | null;
  /** Part of speech by the tag of the corpus lemma; `v` for a word the corpus lacks that the list gives in -рга/-ргә; empty otherwise. */
  pos: string;
  /** The word is set aside as known to a Russian speaker (data/work/cognates.json). */
  cognate: boolean;
  /** The number of Tatoeba sentences `build-wordlist examples` can show for the word. */
  tatoeba: number;
}

/** True if a single word of the lists is printed as a verb, in -рга/-ргә, and its lemma is the name of action made from it. */
const printedAsVerb = (p: PoolEntry): boolean => /рг[аә]$/.test(entryKey(p.entry)) && p.lemma !== entryKey(p.entry);

/**
 * The words to consider for level `level` (1–5), in the order they are taken (spec §3.6):
 *  1. `kfu` — the words of the KFU list of this level, in the order of the list: its single words and the words of
 *     its free combinations that the corpus knows («белем алырга» → «белем», «алу»). The level of a word is the
 *     lowest level whose list has it, and its topic is the topic of its first place there (rule 1).
 *  2. `kfu-early` — the words of the KFU lists of higher levels whose frequency band is this level or a lower one:
 *     a very frequent word does not wait for its KFU level (rule 3). By frequency.
 *  3. `freq` — the words of the frequency band of this level that stand in no KFU list (rule 2). By frequency.
 *  4. `freq-late` — the words of the lower bands that stand in no KFU list and are still not in the catalog: what
 *     did not fit into its own level moves on to the next (rule 4). By frequency, so the most frequent come first.
 * A word the catalog already holds, in any level, is left out; so the list of a level gets shorter as the level is
 * filled. `catalog` holds the word keys of the
 * catalog, `cognates` the words set aside as known to a Russian speaker — they are listed and marked, the author
 * decides — and `examples` counts the example sentences of a word.
 */
export function levelCandidates(level: number, o: {
  pool: readonly PoolEntry[]; ranked: readonly RankedWord[]; catalog: ReadonlySet<string>; cognates: ReadonlySet<string>;
  examples: (word: string, pos: string) => number;
}): LevelCandidate[] {
  if (!LEVELS.some((l) => l.no === level)) throw new Error(`уровня ${level} нет: уровни 1–${LEVELS.length}`);
  const corpus = new Map(o.ranked.map((w) => [w.word, w]));
  /** Word → its first place in the KFU lists: the pool goes from the lowest level up. */
  const kfu = new Map<string, { level: number; kfuTopic: string; topic: string; verb: boolean }>();
  for (const p of o.pool) {
    const words = p.kind === "word" ? [p.lemma] : p.kind === "combination" ? p.words : [];
    const place = { level: LEVELS.find((l) => l.slug === p.level)?.no ?? NaN, kfuTopic: p.kfuTopic, topic: p.topic };
    for (const word of words) if (!kfu.has(word)) kfu.set(word, { ...place, verb: p.kind === "word" && printedAsVerb(p) });
  }
  const candidate = (word: string, source: CandidateSource): LevelCandidate => {
    const place = kfu.get(word);
    const pos = corpus.get(word)?.pos ?? (place?.verb ? "v" : "");
    return {
      word, source, kfuTopic: place?.kfuTopic ?? "", topic: place?.topic ?? "", rank: corpus.get(word)?.rank ?? null, pos,
      cognate: o.cognates.has(word), tatoeba: o.examples(word, pos),
    };
  };
  const fresh = (word: string): boolean => !o.catalog.has(wordKey(word));
  const ofList = [...kfu].filter(([word, place]) => place.level === level && fresh(word)).map(([word]) => candidate(word, "kfu"));
  const early = o.ranked
    .filter((w) => (kfu.get(w.word)?.level ?? 0) > level && (frequencyBand(w.rank) ?? Infinity) <= level && fresh(w.word))
    .map((w) => candidate(w.word, "kfu-early"));
  const frequent = o.ranked.filter((w) => !kfu.has(w.word) && fresh(w.word));
  const ofBand = frequent.filter((w) => frequencyBand(w.rank) === level).map((w) => candidate(w.word, "freq"));
  const late = frequent.filter((w) => (frequencyBand(w.rank) ?? Infinity) < level).map((w) => candidate(w.word, "freq-late"));
  return [...ofList, ...early, ...ofBand, ...late];
}

export const CANDIDATES_HEADER = ["word", "source", "kfu_topic", "topic", "rank", "pos", "cognate", "tatoeba"] as const;

/** The list as a table: tab-separated, a header, one line per word; `cognate` is `yes` or empty. */
export function formatLevelCandidates(candidates: readonly LevelCandidate[]): string {
  const lines = candidates.map((c) => [c.word, c.source, c.kfuTopic, c.topic, c.rank ?? "", c.pos, c.cognate ? "yes" : "", c.tatoeba].join("\t"));
  return [CANDIDATES_HEADER.join("\t"), ...lines].join("\n") + "\n";
}
