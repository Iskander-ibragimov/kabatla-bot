import { describe, expect, it } from "vitest";
import { KFU_CORRECTIONS, KFU_TOPICS, type KfuCorrection, kfuTopicSlug, parseKfuLevel, parseKfuLists, parseKfuTopicNames } from "../../scripts/lib/kfu";
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
  "әни (әнкәй)",
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

  it("reads a table of two columns in the printed order, the left column and then the right one, and leaves the text before the first heading and after the section out", () => {
    expect(level.topics[0]!.entries).toEqual(["Өй", "өй", "алма", "әни (әнкәй)", "шәһәр", "Сәлам!", "кил-ергә"]);
  });

  it("takes a heading printed again under itself for an entry, and a word that is the name of a later topic too", () => {
    expect(level.topics[0]!.entries).toContain("Өй");
    expect(level.topics[0]!.entries).toContain("шәһәр");
    expect(level.topics.map((t) => t.name).filter((name) => name === "Шәһәр")).toHaveLength(1);
  });

  it("gives the cell that shares the line with a heading to the topic of that heading, in its column", () => {
    expect(level.topics[1]!.entries).toEqual(["урам", "юл", "Казан", "автобус"]);
  });

  it("reads a numbered list by its numbers: in their order, a cell without one continues the entry of its column, a page number and a number alone are no entries", () => {
    expect(level.topics[2]!.entries).toEqual(["ял итәргә", "җырларга", "Яңа ел бәйрәме", "бию"]);
  });

  it("joins nothing in a text without wrapped entries", () => {
    expect(level.joins).toEqual([]);
  });

  it("refuses a section without its end", () => {
    expect(() => parseKfuLevel(SPEC.split("\n").filter((line) => !line.includes("Содержание отдельных")).join("\n"))).toThrow(/Содержание отдельных/);
  });

  it("opens the topics only in the order of the list", () => {
    const text = ["Основные темы", " 1. Өй", " 2. Ял", "7. ЛЕКСИКА", "Ял", "уен", "Өй", "ишек", "8. Содержание отдельных частей"].join("\n");
    expect(parseKfuLevel(text)).toEqual({ topics: [{ name: "Ял", heading: "Ял", entries: ["уен", "Өй", "ишек"] }], missing: ["Өй"], joins: [] });
  });
});

/** The widest line of the one-column list below: a name that the margin cuts. */
const WIDE = "Бөтендөнья Кошлар һәм Җәнлекләр Дуслары Җәмгыяте әгъзаларының еллык";
/** A name of `length` characters. */
const name = (length: number): string => `Аю ${"б".repeat(length - 3)}`;
/**
 * A second specification: a table whose columns stand at other places after a page break, a cell of the right
 * column alone on its line, a table whose two columns stand on alternating lines, and a list in one column.
 */
const COLUMNS = [
  "Основные темы",
  " 1. Кош",
  " 2. Агач",
  " 3. Исем",
  "7. ЛЕКСИКА",
  "Кош",
  "ата каз                 күгәрчен",
  "аккош                   Кошлар Дөньясы Оешмасы",
  "                        (КДО)",
  "карга",
  "                    9",
  "FF      сандугач             тукран",
  "      торна",
  "Агач",
  "                   каен",
  "имән",
  "                   нарат",
  "Исем",
  WIDE,
  "җыелышы",
  "Кечкенә Кошлар Мәктәбе",
  "китап",
  name(WIDE.length - 3),
  "ел",
  name(WIDE.length - 2),
  "су",
  "Зур Урман",
  "Агачлары Музее",
  "8. Содержание отдельных частей",
].join("\n").replace("FF", "\f");

describe("parseKfuLevel: columns and wrapped entries", () => {
  const level = parseKfuLevel(COLUMNS);
  const entries = (topic: string) => level.topics.find((t) => t.name === topic)!.entries;

  it("reads every page of a table by its own columns: the left one, then the right one, then the next page", () => {
    expect(entries("Кош")).toEqual(["ата каз", "аккош", "карга", "күгәрчен", "Кошлар Дөньясы Оешмасы (КДО)", "сандугач", "торна", "тукран"]);
  });

  it("tells the column of a cell that stands alone on its line by where it begins", () => {
    expect(entries("Агач")).toEqual(["имән", "каен", "нарат"]);
  });

  it("joins a cell that is nothing but brackets to the entry above it in its column", () => {
    expect(level.joins).toContainEqual({ topic: "Кош", rule: "brackets", parts: ["Кошлар Дөньясы Оешмасы", "(КДО)"] });
  });

  it("joins, in a list of one column, a name with the line under it when that begins with a small letter and its first word would not have fit on the line of the name", () => {
    expect(entries("Исем")).toEqual([
      `${WIDE} җыелышы`, "Кечкенә Кошлар Мәктәбе", "китап", name(WIDE.length - 3), "ел", `${name(WIDE.length - 2)} су`, "Зур Урман", "Агачлары Музее",
    ]);
    expect(level.joins.filter((j) => j.rule === "margin")).toEqual([
      { topic: "Исем", rule: "margin", parts: [WIDE, "җыелышы"] }, { topic: "Исем", rule: "margin", parts: [name(WIDE.length - 2), "су"] },
    ]);
  });

  it("does not use the margin rule in a table of two columns", () => {
    expect(entries("Кош")).toContain("аккош");
    expect(level.joins.filter((j) => j.topic === "Кош")).toHaveLength(1);
  });
});

describe("parseKfuLists", () => {
  const texts = [{ level: "a1", text: COLUMNS }, { level: "a2", text: SPEC }];
  const fix = (...corrections: KfuCorrection[]) => parseKfuLists(texts, { a1: corrections });
  const entries = (lists: ReturnType<typeof parseKfuLists>, topic: string) => lists[0]!.topics.find((t) => t.name === topic)!.entries;

  it("reads every specification and keeps its level", () => {
    const lists = parseKfuLists(texts, {});
    expect(lists.map((l) => [l.level, l.topics.length, l.missing])).toEqual([["a1", 3, []], ["a2", 3, ["Мәктәп көне"]]]);
    expect(lists[0]!.moves).toEqual([]);
    expect(lists[0]).toMatchObject(parseKfuLevel(COLUMNS));
  });

  it("joins two entries a correction names, where they stand one after the other", () => {
    const lists = fix({ join: ["Зур Урман", "Агачлары Музее"] });
    expect(entries(lists, "Исем").slice(-2)).toEqual([`${name(WIDE.length - 2)} су`, "Зур Урман Агачлары Музее"]);
    expect(lists[0]!.joins).toContainEqual({ topic: "Исем", rule: "correction", parts: ["Зур Урман", "Агачлары Музее"] });
    expect(lists[1]!.joins).toEqual([]);
  });

  it("moves an entry a correction names to its topic, before the entry named or to the end", () => {
    const lists = fix({ move: "торна", to: "Агач", before: "каен" }, { move: "карга", to: "Исем" });
    expect(entries(lists, "Кош")).toEqual(["ата каз", "аккош", "күгәрчен", "Кошлар Дөньясы Оешмасы (КДО)", "сандугач", "тукран"]);
    expect(entries(lists, "Агач")).toEqual(["имән", "торна", "каен", "нарат"]);
    expect(entries(lists, "Исем").at(-1)).toBe("карга");
    expect(lists[0]!.moves).toEqual([{ entry: "торна", from: "Кош", to: "Агач" }, { entry: "карга", from: "Кош", to: "Исем" }]);
  });

  it("stops at a correction that does not fit the text any more, naming it", () => {
    expect(() => fix({ join: ["ата каз", "карга"] })).toThrow(/a1.*«ата каз».*«карга»/);
    expect(() => fix({ move: "юкбар", to: "Агач" })).toThrow(/a1.*«юкбар»/);
    expect(() => fix({ move: "торна", to: "Юк тема" })).toThrow(/a1.*«Юк тема»/);
    expect(() => fix({ move: "торна", to: "Агач", before: "юкбар" })).toThrow(/a1.*«юкбар»/);
    expect(() => fix({ move: "имән", to: "Агач" })).toThrow(/a1.*«имән»/);
  });

  it("has corrections for levels of the scale only", () => {
    for (const level of Object.keys(KFU_CORRECTIONS)) expect(Object.keys(KFU_TOPICS)).toContain(level);
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
