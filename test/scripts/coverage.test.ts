import { describe, expect, it } from "vitest";
import { type CoverageSources, coverage, formatMeta, lemmaCounts } from "../../scripts/lib/coverage";
import { parseLemmas } from "../../scripts/lib/wordlist";

describe("lemmaCounts", () => {
  const counts = lemmaCounts(parseLemmas([
    "900\tул\tprn", "30\tул\tn", "600\tбар\tv", "500\tбар\tadj", "250\tал\tv", "150\tал\tvaux", "349\tә\tcnjcoo", "13\tю\tv",
    "90\tКазан\tnp", "50\tзззз\tasterisk", "45\tтр.\tabbr", "7\tбар\tnp",
  ].join("\n")));

  it("adds up the rows of a word over the tagged lists, a verb under its name of action", () => {
    expect(counts.get("ул")).toBe(930);
    expect(counts.get("бар")).toBe(500);
    expect(counts.get("бару")).toBe(600);
    expect(counts.get("алу")).toBe(400);
  });

  it("keeps a word of one letter: the candidates drop it, the text still holds it", () => {
    expect(counts.get("ә")).toBe(349);
    expect(counts.get("юу")).toBe(13);
  });

  it("leaves out proper nouns, abbreviations and unrecognised tokens", () => {
    expect([...counts.keys()].sort()).toEqual(["алу", "бар", "бару", "ул", "юу", "ә"]);
  });
});

/** A corpus of 2000 tokens. Places 1–500 are the band of A1, 501–1350 of A2, 2201–3000 of B2. */
const sources = (over: Partial<CoverageSources> = {}): CoverageSources => ({
  counts: new Map([["ул", 300], ["китап", 200], ["коймак", 6], ["рәхмәт", 100], ["яңгыр", 50], ["район", 250]]),
  ranks: new Map([["ул", 1], ["китап", 400], ["коймак", 2500], ["рәхмәт", 450], ["яңгыр", 600], ["район", 3]]),
  cognates: [{ word: "район", count: 250 }, { word: "проект", count: 150 }, { word: "атом", count: 20 }],
  total: 2000,
  ...over,
});
const a1 = { level: 1, words: ["ул", "китап", "коймак", "Рәхмәт!", "юкбар"] };
const a2 = { level: 2, words: ["яңгыр"] };

describe("coverage", () => {
  it("is the share of the corpus the words up to each level cover, in whole percent", () => {
    expect(coverage([a1, a2], sources({ cognates: [] }))).toEqual([{ level: 1, coveragePct: 30 }, { level: 2, coveragePct: 33 }]);
  });

  it("counts a word by its key: a phrase card that is one word of the corpus, and nothing for a word the corpus lacks", () => {
    expect(coverage([{ level: 1, words: ["Рәхмәт!"] }], sources({ cognates: [] }))).toEqual([{ level: 1, coveragePct: 5 }]);
    expect(coverage([{ level: 1, words: ["юкбар", "Хәлләр ничек?"] }], sources())).toEqual([{ level: 1, coveragePct: 0 }]);
  });

  it("adds the look-alikes of Russian that are at least as frequent as the rarest word that stands in its level by frequency", () => {
    // A1: 606 tokens of its words; the rarest word of the A1 band is рәхмәт (100), so район and проект are known: 400 more.
    // A2: яңгыр, a word of the A2 band, brings the bar down to 50; атом (20) is still below it.
    expect(coverage([a1, a2], sources())).toEqual([{ level: 1, coveragePct: 50 }, { level: 2, coveragePct: 53 }]);
  });

  it("does not let a word that stands in a level for its use, not for its frequency, lower that bar", () => {
    // коймак (6 tokens, place 2500) is in A1 by its topic: with it as the bar, атом would count.
    expect(coverage([a1], sources({ ranks: new Map([...sources().ranks, ["коймак", 499]]) }))).toEqual([{ level: 1, coveragePct: 51 }]);
    expect(coverage([a1], sources())).toEqual([{ level: 1, coveragePct: 50 }]);
  });

  it("lets a word set the bar from the level of its band on", () => {
    // яңгыр (place 600, the A2 band) stands in A1: it sets no bar there, and does once A2 has a file.
    const early = { level: 1, words: [...a1.words, "яңгыр"] };
    const cognates = [...sources().cognates, { word: "спорт", count: 60 }];
    expect(coverage([early, { level: 2, words: [] }], sources({ cognates }))).toEqual([{ level: 1, coveragePct: 53 }, { level: 2, coveragePct: 56 }]);
  });

  it("adds no look-alikes while no word of the levels stands there by frequency", () => {
    expect(coverage([{ level: 1, words: ["коймак"] }], sources())).toEqual([{ level: 1, coveragePct: 0 }]);
  });

  it("counts a look-alike that is a card once", () => {
    expect(coverage([{ level: 1, words: [...a1.words, "район"] }], sources())).toEqual([{ level: 1, coveragePct: 50 }]);
  });

  it("never falls from level to level, and takes the levels in their order whatever order they are given in", () => {
    const b2 = { level: 4, words: ["коймак"] };
    const levels = [{ ...a1, words: a1.words.filter((w) => w !== "коймак") }, a2, b2];
    const meta = coverage([...levels].reverse(), sources());
    expect(meta.map((m) => m.level)).toEqual([1, 2, 4]);
    // B2: коймак stands in its own band now and is the bar: атом counts too.
    expect(meta.map((m) => m.coveragePct)).toEqual([50, 53, 54]);
  });

  it("has nothing for a catalog without levels", () => {
    expect(coverage([], sources())).toEqual([]);
  });
});

describe("formatMeta", () => {
  it("writes meta.json on one line, as the file is kept", () => {
    expect(formatMeta([{ level: 1, coveragePct: 45 }, { level: 2, coveragePct: 61 }])).toBe('[{"level":1,"coveragePct":45},{"level":2,"coveragePct":61}]\n');
  });
});
