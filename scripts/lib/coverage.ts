/**
 * The coverage figure of data/catalog/meta.json: the share of running text a learner reads with the words up to a
 * level. Pure: no I/O; scripts/coverage.ts reads the catalog and the corpus lists and writes the file.
 */
import { wordKey } from "../../src/db/repo";
import type { LevelMeta } from "./catalog";
import { frequencyBand } from "./level-candidates";
import type { LemmaRow } from "./sources";
import { dictionaryForm } from "./tatar-verbs";
import { POS_MAP } from "./wordlist";

/**
 * The tokens of the corpus by word: the counts of the rows of the tagged lemma lists, added up under the dictionary
 * form (a verb under its name of action). The lists of proper nouns, abbreviations and unrecognised tokens are left
 * out. Unlike the candidates, nothing else is dropped: a word of one letter (ә, юу) is no candidate for a card that
 * the lists offer, but it is a card, and the text holds it.
 */
export function lemmaCounts(lemmas: readonly LemmaRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { count, lemma, pos: list } of lemmas) {
    const pos = POS_MAP[list];
    if (!pos) continue;
    const word = dictionaryForm(lemma, pos);
    counts.set(word, (counts.get(word) ?? 0) + count);
  }
  return counts;
}

export interface CoverageSources {
  /** Word in dictionary form → its tokens in the corpus (`lemmaCounts`). */
  counts: ReadonlyMap<string, number>;
  /** Word → its place in the frequency list of the corpus (`rankWords`). */
  ranks: ReadonlyMap<string, number>;
  /** The words set aside as known to a Russian speaker, with their tokens (data/work/cognates.json). */
  cognates: readonly { word: string; count: number }[];
  /** All the tokens of the corpus lists, the unrecognised ones too. */
  total: number;
}

/**
 * Cumulative coverage of running text by level, in whole percent, for the levels given, lowest first. Level N covers
 * the corpus tokens of the words of the levels up to N — a card is found by its word key, so «Рәхмәт!» counts as
 * рәхмәт, and a card the corpus lists do not have (a phrase, алдында) counts nothing — plus those of the Russian
 * look-alikes that are no card and are at least as frequent as the rarest of these words that stands there by
 * frequency: a learner knows them anyway. A word stands there by frequency when its frequency band is N or lower;
 * a word taken for its topic from further down the list (коймак in A1) does not set that bar, or one rare thematic
 * word would count every look-alike as known. The bar only goes down from level to level, so the coverage never falls.
 *
 * This is the figure the catalog had while it was cut into hundreds, with one change: the rows whose count did not
 * set the bar were marked by hand then (`origin: core`); now the frequency band says it.
 */
export function coverage(levels: readonly { level: number; words: readonly string[] }[], o: CoverageSources): LevelMeta[] {
  const cards = new Set<string>();
  let learned = 0;
  /** The counted words so far, with the band each stands in. */
  const banded: { band: number; count: number }[] = [];
  return [...levels].sort((a, b) => a.level - b.level).map(({ level, words }) => {
    for (const word of words) {
      const key = wordKey(word);
      if (key === "" || cards.has(key)) continue;
      cards.add(key);
      const count = o.counts.get(key) ?? 0;
      learned += count;
      const band = frequencyBand(o.ranks.get(key) ?? null);
      if (band !== null && count > 0) banded.push({ band, count });
    }
    const bar = Math.min(...banded.filter((w) => w.band <= level).map((w) => w.count));
    const known = o.cognates.reduce((sum, c) => (c.count >= bar && !cards.has(wordKey(c.word)) ? sum + c.count : sum), 0);
    return { level, coveragePct: Math.round(((learned + known) / o.total) * 100) };
  });
}

/** The text of data/catalog/meta.json: one line. */
export const formatMeta = (meta: readonly LevelMeta[]): string => `${JSON.stringify(meta.map(({ level, coveragePct }) => ({ level, coveragePct })))}\n`;
