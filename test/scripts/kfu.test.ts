import { describe, expect, it } from "vitest";
import {
  KFU_TOPICS, type KfuLevel, POOL_HEADER, buildPool, classifyEntry, entryKey, formatPool, infinitiveForms, kfuTopicSlug, parseKfuLevel, parseKfuTopicNames,
} from "../../scripts/lib/kfu";
import { LEVELS } from "../../src/levels/scale";

/**
 * A specification in the layout the lists are read from, written for this test with everyday words: the list of
 * topics (numbered, with the Russian name after a slash, one of them wrapped, a page number and a page break inside),
 * the word section in two columns, and the section that follows it.
 */
const SPEC = [
  "Говорение: рассказ по одной из тем (далее: Основные темы).",
  "Основные темы",
  "    1. Өй / Дом.",
  "    2. Мәктәп көне / Школьный день",
  "       и уроки.",
  "                                   4",
  "\f  3. Шәһәр / Город. Транспорт.",
  "    4. Ял / Отдых.",
  "       7. ЛЕКСИКА",
  "Словарь уровня включает лексические единицы,",
  "применяемые в языке. Кандидаты должны",
  "",
  "                 Лексический минумум",
  "",
  "       Өй",
  "Өй                      шәһәр",
  "өй                      Сәлам!",
  "алма                    кил-ергә",
  "бабай (дәү әти)",
  "",
  "      Шәһәр. Транспорт  Казан",
  "урам                    автобус",
  "юл",
  "4. Ял",
  "1.    ял итәргә         3.   Яңа      ел",
  "2. җырларга             бәйрәме",
  "                    5",
  "\f4.   бию              5.",
  " 8. Содержание отдельных частей тестирования на уровне",
  "урам                    бу уже не читается",
].join("\n");

describe("parseKfuTopicNames", () => {
  it("reads the Tatar names of the list of topics: without the number, the Russian name, a wrapped line and the page number", () => {
    expect(parseKfuTopicNames(SPEC)).toEqual(["Өй", "Мәктәп көне", "Шәһәр", "Ял"]);
  });

  it("reads a list without numbers line by line", () => {
    expect(parseKfuTopicNames("Основные темы\n     Өй\n     Мәктәп көне\n                 6\n\f     Ял\n   7. ЛЕКСИКА\n")).toEqual(["Өй", "Мәктәп көне", "Ял"]);
  });

  it("drops the glyphs of a symbol font that stand for the bullets of a list", () => {
    expect(parseKfuTopicNames("Основные темы\n    \uF031\uF02E   Өй\n    \uF032\uF02E   Ял\n   7. ЛЕКСИКА\n")).toEqual(["Өй", "Ял"]);
  });

  it("reads a list whose numbers stand apart from the names", () => {
    expect(parseKfuTopicNames("       Основные темы\n  1.   Өй\n 10.   Ял\n        7. ЛЕКСИКА\n")).toEqual(["Өй", "Ял"]);
  });

  it("refuses a text without the list or without the word section", () => {
    expect(() => parseKfuTopicNames("Основные темы\n 1. Өй\n")).toThrow(/7\. ЛЕКСИКА/);
    expect(() => parseKfuTopicNames("7. ЛЕКСИКА\n")).toThrow(/Основные темы/);
  });
});

describe("parseKfuLevel", () => {
  const level = parseKfuLevel(SPEC);

  it("cuts the word section into the topics of the list, each with its heading as printed", () => {
    expect(level.topics.map((t) => [t.name, t.heading])).toEqual([["Өй", "Өй"], ["Шәһәр", "Шәһәр. Транспорт"], ["Ял", "Ял"]]);
  });

  it("names the topic of the list that has no heading over the words", () => {
    expect(level.missing).toEqual(["Мәктәп көне"]);
  });

  it("reads the two columns row by row and leaves the text before the first heading and after the section out", () => {
    expect(level.topics[0]!.entries).toEqual(["Өй", "шәһәр", "өй", "Сәлам!", "алма", "кил-ергә", "бабай (дәү әти)"]);
  });

  it("takes a heading printed again under itself for an entry, and a word that is the name of a later topic too", () => {
    expect(level.topics[0]!.entries.slice(0, 2)).toEqual(["Өй", "шәһәр"]);
    expect(level.topics.map((t) => t.name).filter((name) => name === "Шәһәр")).toHaveLength(1);
  });

  it("gives the cell that shares the line with a heading to the topic of that heading", () => {
    expect(level.topics[1]!.entries).toEqual(["Казан", "урам", "автобус", "юл"]);
  });

  it("reads a numbered list by its numbers: a cell without one continues the entry of its column, a page number and a number alone are no entries", () => {
    expect(level.topics[2]!.entries).toEqual(["ял итәргә", "Яңа ел бәйрәме", "җырларга", "бию"]);
  });

  it("refuses a section without its end", () => {
    expect(() => parseKfuLevel(SPEC.split("\n").filter((line) => !line.includes("Содержание отдельных")).join("\n"))).toThrow(/Содержание отдельных/);
  });

  it("opens the topics only in the order of the list", () => {
    const text = ["Основные темы", " 1. Өй", " 2. Ял", "7. ЛЕКСИКА", "Ял", "уен", "Өй", "ишек", "8. Содержание отдельных частей"].join("\n");
    expect(parseKfuLevel(text)).toEqual<KfuLevel>({ topics: [{ name: "Ял", heading: "Ял", entries: ["уен", "Өй", "ишек"] }], missing: ["Өй"] });
  });
});

describe("the topics of the specifications", () => {
  const SLUGS = [
    "core", "greet", "family", "person", "home", "time", "numbers", "nature", "food", "shop", "city", "study", "work", "leisure", "health", "travel", "culture",
    "tatar", "society", "language", "media",
  ];

  it("maps eleven topics of every level to the topics of the catalog", () => {
    expect(Object.keys(KFU_TOPICS)).toEqual(LEVELS.map((l) => l.slug));
    for (const [level, topics] of Object.entries(KFU_TOPICS)) {
      expect([level, Object.keys(topics).length]).toEqual([level, 11]);
      for (const slug of Object.values(topics)) expect(SLUGS).toContain(slug);
    }
  });

  it("follows the table of the specification", () => {
    expect(kfuTopicSlug("a1", "Танышу")).toBe("greet");
    expect(kfuTopicSlug("a1", "Шәһәр")).toBe("city");
    expect(kfuTopicSlug("a2", "Йорт. Фатир")).toBe("home");
    expect(kfuTopicSlug("b1", "Мода һәм матурлык")).toBe("shop");
    expect(kfuTopicSlug("b2", "Сәяхәт итү һәм ял")).toBe("travel");
    expect(kfuTopicSlug("c1", "Интернет чыганаклар")).toBe("media");
  });

  it("fails on a topic that is not mapped, naming it", () => {
    expect(() => kfuTopicSlug("a1", "Яңа тема")).toThrow(/«Яңа тема».*a1/);
    expect(() => kfuTopicSlug("a2", "Танышу")).toThrow(/«Танышу».*a2/);
  });
});

describe("infinitiveForms", () => {
  it("turns the form in -рга/-ргә into the name of action, the stem in a vowel first", () => {
    expect(infinitiveForms("эшләргә")).toEqual(["эшләү", "эшлү"]);
    expect(infinitiveForms("язарга")).toEqual(["язау", "язу"]);
    expect(infinitiveForms("барырга")).toEqual(["бару"]);
    expect(infinitiveForms("килергә")).toEqual(["килү"]);
    expect(infinitiveForms("укырга")).toEqual(["уку"]);
    expect(infinitiveForms("зураерга")).toEqual(["зураю"]);
    expect(infinitiveForms("җыярга")).toEqual(["җыю"]);
    expect(infinitiveForms("кияргә")).toEqual(["кию"]);
  });

  it("takes the stem as given when the list separates it with a hyphen", () => {
    expect(infinitiveForms("сана-рга")).toEqual(["санау"]);
    expect(infinitiveForms("тор-ырга")).toEqual(["тору"]);
    expect(infinitiveForms("көл-әргә")).toEqual(["көлү"]);
    expect(infinitiveForms("куй-рга")).toEqual(["кую"]);
  });

  it("has nothing for a word that is no such form", () => {
    expect(infinitiveForms("китап")).toEqual([]);
    expect(infinitiveForms("әти-әни")).toEqual([]);
    expect(infinitiveForms("рга")).toEqual([]);
  });
});

describe("classifyEntry", () => {
  const known = new Set(["язу", "килү", "дус", "булу", "карга", "белем", "алу", "әни", "өй", "су", "агу"]);
  const kind = (entry: string) => classifyEntry(entry, known).kind;
  const lemma = (entry: string) => classifyEntry(entry, known).lemma;

  it("takes one token for a word", () => {
    expect(classifyEntry("өй", known)).toEqual({ kind: "word", lemma: "өй", words: [] });
    expect(kind("әти-әни")).toBe("word");
  });

  it("gives a verb its dictionary form by the stem the corpus knows", () => {
    expect(lemma("язарга")).toBe("язу");
    expect(lemma("кил-ергә")).toBe("килү");
    expect(lemma("көл-әргә")).toBe("көлү");
    expect(lemma("эшләргә")).toBe("эшләү");
    expect(lemma("карга")).toBe("карга");
  });

  it("guesses the stem of a verb the corpus lacks: in a vowel after л or р (-ла, -ра make verbs), in a consonant otherwise", () => {
    expect(lemma("зурларга")).toBe("зурлау");
    expect(lemma("калтырарга")).toBe("калтырау");
    expect(lemma("сүнәргә")).toBe("сүнү");
    expect(lemma("тамарга")).toBe("таму");
    expect(lemma("сеңәргә")).toBe("сеңү");
  });

  it("takes the stem in a vowel when the corpus knows both", () => {
    expect(classifyEntry("ашарга", new Set(["ашау", "ашу"])).lemma).toBe("ашау");
    expect(classifyEntry("ашарга", new Set(["ашу"])).lemma).toBe("ашу");
  });

  it("reads the main form of an entry with a variant: before the brackets, the slash or the comma, without the final sign", () => {
    expect(classifyEntry("әни (әнкәй)", known)).toEqual({ kind: "word", lemma: "әни", words: [] });
    expect(lemma("гына/генә, кына/кенә")).toBe("гына");
    expect(lemma("бара\\бармый")).toBe("бара");
    expect(lemma("күрше,")).toBe("күрше");
    expect(lemma("укучы(лар)")).toBe("укучы");
    expect(lemma("куй-(я)рга")).toBe("кую");
    expect(lemma("китап// дәфтәр")).toBe("китап");
  });

  it("reads look-alike letters of other alphabets as the Tatar ones", () => {
    expect(lemma("я\u04CAа")).toBe("яңа");
    expect(lemma("к\u0473н")).toBe("көн");
  });

  it("takes an entry with ! or ?, a line of speech and a listed formula for a phrase, and keeps it as printed", () => {
    expect(classifyEntry("Син кайда?", known)).toEqual({ kind: "phrase", lemma: "Син кайда?", words: [] });
    expect(classifyEntry("Рәхмәт сезгә! (Рәхмәт!)", known)).toEqual({ kind: "phrase", lemma: "Рәхмәт сезгә!", words: [] });
    expect(classifyEntry("– Кунакка рәхим итегез.", known)).toEqual({ kind: "phrase", lemma: "Кунакка рәхим итегез.", words: [] });
    expect(classifyEntry(". – Сезгә уңышлар телим.", known).lemma).toBe("Сезгә уңышлар телим.");
    expect(kind("рәхим итегез")).toBe("phrase");
    expect(kind("Чынмыни")).toBe("phrase");
    expect(kind("Сәлам!")).toBe("phrase");
  });

  it("takes an entry that begins with a capital or a quotation mark for a name", () => {
    for (const entry of ["Казан", "Яңа ел бәйрәме", "«Чишмә» балалар бакчасы", "“Кояш” кафесы", "IT-белгеч", "(ТР)"]) expect([entry, kind(entry)]).toEqual([entry, "name"]);
    expect(classifyEntry("Казан", known).words).toEqual([]);
  });

  it("takes the rest for a free combination and names its words the corpus knows, a verb in its dictionary form", () => {
    expect(classifyEntry("белем алырга", known)).toEqual({ kind: "combination", lemma: "белем алу", words: ["белем", "алу"] });
    expect(classifyEntry("дус бул-ырга", known)).toEqual({ kind: "combination", lemma: "дус булу", words: ["дус", "булу"] });
    expect(classifyEntry("су ага\\ акмый", known)).toEqual({ kind: "combination", lemma: "су ага", words: ["су"] });
    expect(classifyEntry("зур шәһәр", known)).toEqual({ kind: "combination", lemma: "зур шәһәр", words: [] });
    expect(classifyEntry("өй өй", known).words).toEqual(["өй"]);
  });

  it("works without the corpus words", () => {
    expect(classifyEntry("язарга")).toEqual({ kind: "word", lemma: "язу", words: [] });
    expect(classifyEntry("белем алырга")).toEqual({ kind: "combination", lemma: "белем алу", words: [] });
  });
});

describe("entryKey", () => {
  it("is the same for an entry printed with and without the hyphen of the stem, in another case or with a sign", () => {
    expect(entryKey("сана-рга")).toBe(entryKey("санарга"));
    expect(entryKey("Сәлам!")).toBe(entryKey("сәлам"));
    expect(entryKey("  күрше, ")).toBe("күрше");
    expect(entryKey("я\u04CAа")).toBe("яңа");
    expect(entryKey("яңа ел")).not.toBe(entryKey("яңа"));
  });
});

describe("buildPool", () => {
  const levels: { level: string; topics: KfuLevel["topics"] }[] = [
    { level: "a1", topics: [
      { name: "Танышу", heading: "Танышу", entries: ["Сәлам!", "өй", "яз-арга", "Казан", "белем алырга"] },
      { name: "Шәһәр", heading: "Шәһәр. Транспорт", entries: ["урам", "өй"] },
    ] },
    { level: "a2", topics: [{ name: "Табибта", heading: "Табибта", entries: ["язарга", "урам", "авыру", "сәлам"] }] },
  ];
  const ranks = new Map([["өй", 40], ["язу", 7], ["белем", 300], ["алу", 3], ["авыру", 900]]);
  const catalog = new Map([["сәлам", "a1"], ["язу", "a1"], ["авыру", "a2"]]);
  const pool = buildPool(levels, { ranks, catalog });

  it("keeps an entry once, at the lowest level and in the first topic it stands in", () => {
    expect(pool.map((p) => `${p.entry}@${p.level}`)).toEqual(["Сәлам!@a1", "өй@a1", "яз-арга@a1", "Казан@a1", "белем алырга@a1", "урам@a1", "авыру@a2"]);
  });

  it("gives every entry the heading it stands under and the topic of the catalog", () => {
    expect(pool[0]).toMatchObject({ kfuTopic: "Танышу", topic: "greet" });
    expect(pool[5]).toMatchObject({ kfuTopic: "Шәһәр. Транспорт", topic: "city" });
    expect(pool[6]).toMatchObject({ kfuTopic: "Табибта", topic: "health" });
  });

  it("ranks a word by its dictionary form and leaves the rest without a rank", () => {
    expect(pool.map((p) => [p.kind, p.lemma, p.rank])).toEqual([
      ["phrase", "Сәлам!", null], ["word", "өй", 40], ["word", "язу", 7], ["name", "Казан", null], ["combination", "белем алу", null], ["word", "урам", null], ["word", "авыру", 900],
    ]);
    expect(pool[4]!.words).toEqual(["белем", "алу"]);
  });

  it("names the level file that already holds the word", () => {
    expect(pool.map((p) => p.inCatalog)).toEqual(["a1", "", "a1", "", "", "", "a2"]);
  });

  it("fails on a topic without a mapping", () => {
    expect(() => buildPool([{ level: "a1", topics: [{ name: "Яңа тема", heading: "Яңа тема", entries: ["өй"] }] }], { ranks, catalog })).toThrow(/«Яңа тема»/);
  });

  it("writes the pool as a table with a header", () => {
    expect([...POOL_HEADER]).toEqual(["entry", "level", "kfu_topic", "topic", "kind", "lemma", "rank", "in_catalog", "words"]);
    expect(formatPool(pool).split("\n").slice(0, 3)).toEqual([
      POOL_HEADER.join("\t"),
      "Сәлам!\ta1\tТанышу\tgreet\tphrase\tСәлам!\t\ta1\t",
      "өй\ta1\tТанышу\tgreet\tword\tөй\t40\t\t",
    ]);
    expect(formatPool(pool).split("\n")[5]).toBe("белем алырга\ta1\tТанышу\tgreet\tcombination\tбелем алу\t\t\tбелем, алу");
    expect(formatPool(pool).endsWith("\n")).toBe(true);
  });
});
