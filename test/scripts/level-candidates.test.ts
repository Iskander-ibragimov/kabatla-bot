import { describe, expect, it } from "vitest";
import type { PoolEntry } from "../../scripts/lib/kfu";
import { CANDIDATES_HEADER, formatLevelCandidates, frequencyBand, levelCandidates } from "../../scripts/lib/level-candidates";
import type { RankedWord } from "../../scripts/lib/wordlist";

describe("frequencyBand", () => {
  it("gives the level of a place in the frequency list: 1–500 A1, 501–1350 A2, 1351–2200 B1, 2201–3000 B2, 3001–3850 C1", () => {
    expect([1, 500, 501, 1350, 1351, 2200, 2201, 3000, 3001, 3850].map(frequencyBand)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("has no level for a place after the last band or for no place", () => {
    expect(frequencyBand(3851)).toBeNull();
    expect(frequencyBand(null)).toBeNull();
    expect(frequencyBand(0)).toBeNull();
  });
});

const entry = (over: Partial<PoolEntry> & { entry: string; level: string }): PoolEntry => ({
  kfuTopic: "Танышу", topic: "greet", kind: "word", lemma: over.entry, rank: null, inCatalog: "", words: [], ...over,
});
/** The corpus: `word` at place `rank`. Places 1–500 are the band of A1, 501–1350 of A2. */
const ranked: RankedWord[] = [
  { word: "ул", pos: "pron", count: 900, rank: 1 }, { word: "алу", pos: "v", count: 800, rank: 2 }, { word: "район", pos: "n", count: 700, rank: 3 },
  { word: "белем", pos: "n", count: 600, rank: 4 }, { word: "өй", pos: "n", count: 500, rank: 5 }, { word: "эш", pos: "n", count: 400, rank: 6 },
  { word: "яңгыр", pos: "n", count: 90, rank: 600 }, { word: "кояш", pos: "n", count: 80, rank: 700 }, { word: "табиб", pos: "n", count: 70, rank: 1400 },
  { word: "су", pos: "n", count: 60, rank: 5000 },
];
const pool: PoolEntry[] = [
  entry({ entry: "Сәлам!", level: "a1", kind: "phrase" }),
  entry({ entry: "өй", level: "a1", rank: 5 }),
  entry({ entry: "яңгыр", level: "a1", kfuTopic: "Һава торышы", topic: "nature", rank: 600 }),
  entry({ entry: "белем алырга", level: "a1", kind: "combination", lemma: "белем алу", words: ["белем", "алу"] }),
  entry({ entry: "Казан", level: "a1", kind: "name" }),
  entry({ entry: "адресларга", level: "a1", lemma: "адреслау" }),
  entry({ entry: "район", level: "a1", rank: 3 }),
  entry({ entry: "өй эше", level: "a1", kind: "combination", lemma: "өй эше", words: ["өй"] }),
  entry({ entry: "эш", level: "a2", kfuTopic: "Эш һәм ял", topic: "work", rank: 6 }),
  entry({ entry: "кояш", level: "a2", kfuTopic: "Табигать һәм тирәлек", topic: "nature", rank: 700 }),
  entry({ entry: "белем", level: "a2", kfuTopic: "Эш һәм ял", topic: "work", rank: 4 }),
  entry({ entry: "табиб", level: "b1", kfuTopic: "Заманча һөнәрләр", topic: "work", rank: 1400 }),
];
const examples = (word: string, pos: string) => (pos === "v" ? 7 : word.length);
const list = (level: number, catalog: string[] = []) =>
  levelCandidates(level, { pool, ranked, catalog: new Set(catalog), cognates: new Set(["район"]), examples });

describe("levelCandidates", () => {
  it("lists the words of the KFU list of the level first, in the order of the list: single words and the words of combinations", () => {
    expect(list(1).filter((c) => c.source === "kfu").map((c) => c.word)).toEqual(["өй", "яңгыр", "белем", "алу", "адреслау", "район"]);
  });

  it("gives a KFU word the topic of its first place at its lowest level", () => {
    const a1 = list(1);
    expect(a1.find((c) => c.word === "яңгыр")).toMatchObject({ kfuTopic: "Һава торышы", topic: "nature" });
    expect(a1.find((c) => c.word === "белем")).toMatchObject({ source: "kfu", kfuTopic: "Танышу", topic: "greet" });
  });

  it("offers a KFU word of a higher level early when its frequency band is this level or a lower one, by frequency", () => {
    expect(list(1).filter((c) => c.source === "kfu-early").map((c) => [c.word, c.kfuTopic, c.topic])).toEqual([["эш", "Эш һәм ял", "work"]]);
    expect(list(2).filter((c) => c.source === "kfu-early").map((c) => c.word)).toEqual([]);
    expect(list(3).filter((c) => c.source === "kfu").map((c) => c.word)).toEqual(["табиб"]);
  });

  it("then lists the words of the frequency band of the level that stand in no KFU list, by frequency", () => {
    expect(list(1).filter((c) => c.source === "freq").map((c) => [c.word, c.kfuTopic, c.topic])).toEqual([["ул", "", ""]]);
    expect(list(2).filter((c) => c.source === "freq")).toEqual([]);
    expect(list(1).map((c) => c.source)).toEqual(["kfu", "kfu", "kfu", "kfu", "kfu", "kfu", "kfu-early", "freq"]);
  });

  it("keeps the KFU words of the level whatever their frequency", () => {
    expect(list(2).map((c) => [c.word, c.source])).toEqual([["эш", "kfu"], ["кояш", "kfu"]]);
  });

  it("leaves out the words the catalog already holds, compared as the catalog compares words", () => {
    expect(list(1, ["өй", "ул", "эш", "алу"]).map((c) => c.word)).toEqual(["яңгыр", "белем", "адреслау", "район"]);
  });

  it("gives every word its place and part of speech in the corpus, the look-alike mark and the number of example sentences", () => {
    const a1 = list(1);
    expect(a1.find((c) => c.word === "өй")).toEqual({ word: "өй", source: "kfu", kfuTopic: "Танышу", topic: "greet", rank: 5, pos: "n", cognate: false, tatoeba: 2 });
    expect(a1.find((c) => c.word === "район")).toMatchObject({ rank: 3, cognate: true });
    expect(a1.find((c) => c.word === "алу")).toMatchObject({ rank: 2, pos: "v", tatoeba: 7 });
  });

  it("takes a word the corpus lacks for a verb when the list gives it in -рга/-ргә", () => {
    expect(list(1).find((c) => c.word === "адреслау")).toMatchObject({ rank: null, pos: "v", tatoeba: 7 });
  });

  it("refuses a level that is not 1–5", () => {
    expect(() => list(6)).toThrow(/уровня 6 нет/);
  });

  it("prints the list as a table", () => {
    expect([...CANDIDATES_HEADER]).toEqual(["word", "source", "kfu_topic", "topic", "rank", "pos", "cognate", "tatoeba"]);
    expect(formatLevelCandidates(list(1).filter((c) => ["район", "адреслау", "ул"].includes(c.word)))).toBe(
      "word\tsource\tkfu_topic\ttopic\trank\tpos\tcognate\ttatoeba\n" +
        "адреслау\tkfu\tТанышу\tgreet\t\tv\t\t7\n" +
        "район\tkfu\tТанышу\tgreet\t3\tn\tyes\t5\n" +
        "ул\tfreq\t\t\t1\tpron\t\t2\n",
    );
  });
});
