import { describe, expect, it } from "vitest";
import { CATALOG_HEADER, type CatalogLevel, TOPICS_HEADER, type Topic, catalogRenames, checkCatalog, parseCatalogLevel, parseTopics } from "../../scripts/lib/catalog";
import { tokenize } from "../../scripts/lib/levels";
import { toCsv } from "../../src/content/csv";
import { transcribe } from "../../src/content/transcribe";

const C1 = "бтдкмнрслч", C2 = "зшрлнмтдкб", C3 = "мнрлштзд";
/** 800 distinct made-up nouns: `<c1>а<c2>ы<c3>`. */
const word = (i: number) => `${C1[i % 10]}а${C2[Math.floor(i / 10) % 10]}ы${C3[Math.floor(i / 100)]}`;

type Row = Record<string, string>;
/** A clean card: a noun with its own example. */
const row = (i: number, over: Row = {}): Row => {
  const w = over.word ?? word(i);
  return {
    word: w, transcription: transcribe(w), pos: "n", translation: `слово ${i}`,
    example_tt: `Бу — ${w}.`, example_ru: "Это слово.", example_src: i % 2 ? "own" : `tatoeba:${1000 + i}`, topic: "food", audio_file_id: "", ...over,
  };
};
const level = (no: number, rows: Row[], header: readonly string[] = CATALOG_HEADER): CatalogLevel => ({ level: no, header: [...header], rows });

const TOPICS: Topic[] = [
  { no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" },
  { no: 8, slug: "food", titleRu: "Еда", titleTt: "Ризык" },
  { no: 20, slug: "media", titleRu: "Медиа и технологии", titleTt: "Медиа һәм технологияләр" },
];

/** A1: a noun, a phrase whose example is a short exchange without the phrase itself, a verb, a noun. */
const a1 = (): Row[] => [
  row(0),
  row(1, { word: `зур ${word(1)}`, pos: "phr", topic: "core", example_tt: "— Бу зур? — Бу зур." }),
  row(2, { word: `${word(2)}лау`, pos: "v", example_tt: `Мин ${word(2)}лыйм.` }),
  row(3, { topic: "media" }),
];
/** The words of the second level file stand far from those of A1 in the made-up list. */
const next = (): Row[] => [row(600), row(601, { topic: "core" }), row(602)];

const attested = new Set(["бу", "мин", "зур", ...Array.from({ length: 800 }, (_, i) => word(i)), ...a1().flatMap((r) => tokenize(r.example_tt!))]);
const check = (levels: CatalogLevel[], over: Partial<Parameters<typeof checkCatalog>[1]> = {}) =>
  checkCatalog(levels, { topics: TOPICS, attested, meta: levels.map((l, i) => ({ level: l.level, coveragePct: 40 + i })), ...over });
/** The catalog with one row of A1 replaced; `at` is the row's place in the file, 0 for the first one. */
const withRow = (at: number, over: Row) => [level(1, a1().map((r, i) => (i === at ? { ...r, ...over } : r))), level(2, next())];

describe("catalog files", () => {
  it("keeps the agreed columns", () => {
    expect([...CATALOG_HEADER]).toEqual(["word", "transcription", "pos", "translation", "example_tt", "example_ru", "example_src", "topic", "audio_file_id"]);
    expect([...TOPICS_HEADER]).toEqual(["no", "slug", "title_ru", "title_tt"]);
  });

  it("reads a level file: the header as written, the rows by column", () => {
    const text = toCsv([...CATALOG_HEADER], a1());
    expect(parseCatalogLevel(1, text)).toEqual({ level: 1, header: [...CATALOG_HEADER], rows: a1() });
    expect(parseCatalogLevel(3, "word,pos\r\nсу,n\r\n")).toEqual({ level: 3, header: ["word", "pos"], rows: [{ word: "су", pos: "n" }] });
    expect(parseCatalogLevel(2, "")).toEqual({ level: 2, header: [], rows: [] });
  });

  it("reads the topics file", () => {
    expect(parseTopics('no,slug,title_ru,title_tt\n0,core,Основа,Нигез сүзләр\n17,tatar,Татарстан и традиции,"Татарстан һәм гореф-гадәтләр"\n')).toEqual([
      { no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" },
      { no: 17, slug: "tatar", titleRu: "Татарстан и традиции", titleTt: "Татарстан һәм гореф-гадәтләр" },
    ]);
    expect(parseTopics("")).toEqual([]);
  });

  it("refuses a topics file with another header", () => {
    expect(() => parseTopics("no,slug,title\n0,core,Основа\n")).toThrow("topics.csv:1 заголовок «no,slug,title», нужен «no,slug,title_ru,title_tt»");
  });

  it("reads every line of renames.csv as a rename of the whole catalog", () => {
    expect(catalogRenames("level,old_word,new_word\n1,китаб,китап\n3,со,су\n")).toEqual([{ oldWord: "китаб", newWord: "китап" }, { oldWord: "со", newWord: "су" }]);
    expect(catalogRenames("level,old_word,new_word\n")).toEqual([]);
    expect(catalogRenames("")).toEqual([]);
  });
});

describe("checkCatalog", () => {
  it("finds nothing in a clean catalog of two levels", () => {
    expect(check([level(1, a1()), level(2, next())])).toEqual([]);
  });

  it("takes a catalog with a level missing in between, and a level file without rows", () => {
    expect(check([level(1, a1()), level(3, next())])).toEqual([]);
    expect(check([level(1, a1()), level(2, [])])).toEqual([]);
  });

  it("requires the exact header", () => {
    const old = CATALOG_HEADER.filter((c) => c !== "topic");
    const rows = a1().map(({ topic: _, ...r }) => r);
    expect(check([level(1, rows, old), level(2, next())])).toEqual([`a1:1 заголовок «${old.join(",")}», нужен «${CATALOG_HEADER.join(",")}»`]);
  });

  it("requires topic numbers 0–20, each used once, and distinct slugs", () => {
    const levels = [level(1, a1()), level(2, next())];
    const topics = (over: Partial<Topic>) => ({ topics: TOPICS.map((t) => (t.slug === "media" ? { ...t, ...over } : t)) });
    expect(check(levels, topics({ no: 21 }))).toEqual(["topics.csv:4 номер темы «21»: нужен от 0 до 20"]);
    expect(check(levels, topics({ no: NaN }))).toEqual(["topics.csv:4 номер темы «NaN»: нужен от 0 до 20"]);
    expect(check(levels, topics({ no: 8 }))).toEqual(["topics.csv:4 номер темы 8 уже есть в topics.csv:3"]);
    expect(check(levels, { topics: [...TOPICS, { no: 9, slug: "food", titleRu: "Покупки", titleTt: "Сәүдә" }] })).toEqual(["topics.csv:5 код темы «food» уже есть в topics.csv:3"]);
    expect(check(levels, { topics: [...TOPICS, { no: 9, slug: "shop", titleRu: " ", titleTt: "Сәүдә" }] })).toEqual(["topics.csv:5 пустой код или название темы"]);
  });

  it("requires a word, a transcription, a translation, an example and its translation on every row", () => {
    expect(check(withRow(3, { word: " " }))).toEqual(["a1:5 пустое слово"]);
    expect(check(withRow(3, { word: "?!" }))).toEqual(["a1:5 пустое слово"]);
    expect(check(withRow(0, { transcription: "" }))).toEqual(["a1:2 пустая транскрипция"]);
    expect(check(withRow(0, { translation: " " }))).toEqual(["a1:2 пустой перевод"]);
    expect(check(withRow(0, { example_tt: "" }))).toEqual(["a1:2 нет примера"]);
    expect(check(withRow(0, { example_ru: "" }))).toEqual(["a1:2 пустой example_ru"]);
  });

  it("requires an example of a phrase too", () => {
    expect(check(withRow(1, { example_tt: "", example_ru: "", example_src: "" }))).toEqual(["a1:3 нет примера"]);
  });

  it("knows the eleven parts of speech", () => {
    for (const pos of ["n", "adj", "adv", "pron", "num", "post", "conj", "part", "intj"]) expect(check(withRow(0, { pos }))).toEqual([]);
    expect(check(withRow(0, { pos: "noun" }))).toEqual(["a1:2 часть речи «noun» не из списка n, v, adj, adv, pron, num, post, conj, part, intj, phr"]);
  });

  it("requires the topic to be one of the topics file", () => {
    expect(check(withRow(3, { topic: "sport" }))).toEqual(["a1:5 темы «sport» нет в topics.csv"]);
    expect(check(withRow(3, { topic: "" }))).toEqual(["a1:5 темы «» нет в topics.csv"]);
  });

  it("allows Tatar letters only in the word, the example and the transcription", () => {
    expect(check(withRow(0, { word: `${word(0)}h` }))).toEqual(["a1:2 word: чужие буквы или знаки «h»"]);
    expect(check(withRow(0, { example_tt: `Бу — ${word(0)} @.` }))).toEqual(["a1:2 example_tt: чужие буквы или знаки «@»"]);
    expect(check(withRow(0, { transcription: "qазым" }))).toEqual(["a1:2 transcription: чужие буквы или знаки «q»"]);
  });

  it("allows w, ʼ and the stress mark in the transcription", () => {
    expect(check(withRow(0, { transcription: "wаʼзы́м" }))).toEqual([]);
  });

  it("requires example_src to be own or tatoeba:<number>", () => {
    expect(check(withRow(0, { example_src: "tatoeba" }))).toEqual(["a1:2 example_src «tatoeba»: нужно own или tatoeba:<число>"]);
    expect(check(withRow(0, { example_src: "" }))).toEqual(["a1:2 example_src «»: нужно own или tatoeba:<число>"]);
  });

  it("allows one Tatoeba sentence once in the whole catalog", () => {
    const levels = [level(1, a1()), level(2, next().map((r, i) => (i === 1 ? { ...r, example_src: "tatoeba:1000" } : r)))];
    expect(check(levels)).toEqual(["a2:3 предложение tatoeba:1000 уже стоит в a1:2"]);
  });

  it("allows a word once in the whole catalog, whatever its case and outer punctuation", () => {
    const again = row(700, { word: `${word(0).toUpperCase()}!`, example_tt: `Бу — ${word(0)}.` });
    expect(check([level(1, a1()), level(3, [row(650), again])])).toEqual([`b1:3 дубль слова «${again.word}»: уже есть в a1:2`]);
  });

  it("requires every word of the example to be an attested form", () => {
    expect(check(withRow(0, { example_tt: `Бу — ${word(0)} әкәмәт.` }))).toEqual(["a1:2 example_tt: слова «әкәмәт» нет в списке словоформ"]);
  });

  it("requires the example of a word to hold a form of it, and does not ask that of a phrase", () => {
    expect(check(withRow(0, { example_tt: `Бу — ${word(5)}.` }))).toEqual([`a1:2 в примере нет формы слова «${word(0)}»`]);
    expect(check(withRow(1, { example_tt: `Бу — ${word(5)}.` }))).toEqual([]);
  });

  it("allows no more rows in a level than its size", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i, { example_src: "own" }));
    expect(check([level(1, rows(500))])).toEqual([]);
    expect(check([level(1, rows(501))])).toEqual(["a1:502 строк 501, в уровне A1 не больше 500"]);
  });

  it("requires a coverage for every level file, and the coverage never falls", () => {
    const levels = [level(1, a1()), level(2, next())];
    expect(check(levels, { meta: [{ level: 1, coveragePct: 45 }] })).toEqual(["a2: нет покрытия в meta.json"]);
    expect(check(levels, { meta: [{ level: 1, coveragePct: 45 }, { level: 2, coveragePct: 30 }] })).toEqual(["a2: покрытие 30% меньше, чем у a1 (45%)"]);
    expect(check(levels, { meta: [{ level: 1, coveragePct: 45 }, { level: 2, coveragePct: 45 }] })).toEqual([]);
  });

  it("reports every broken row, each with its file and line", () => {
    const levels = [level(1, a1().map((r, i) => (i === 3 ? { ...r, translation: "" } : r))), level(2, next().map((r) => ({ ...r, topic: "sport" })))];
    expect(check(levels)).toEqual(["a1:5 пустой перевод", "a2:2 темы «sport» нет в topics.csv", "a2:3 темы «sport» нет в topics.csv", "a2:4 темы «sport» нет в topics.csv"]);
  });
});
