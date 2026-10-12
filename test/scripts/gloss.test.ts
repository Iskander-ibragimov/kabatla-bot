import { describe, expect, it } from "vitest";
import { CATALOG_HEADER, parseCatalogLevel } from "../../scripts/lib/catalog";
import { GLOSS_HEADER, checkGloss, glossByWord, parseGlossLevel } from "../../scripts/lib/gloss";

/** Lines 2, 5, 8 and 11 of data/catalog/a1.csv: in the fixture they are lines 2 … 5. */
const CATALOG = [
  CATALOG_HEADER.join(","),
  'Исәнмесез!,исә́нмесез,phr,здравствуйте,"Исәнмесез, дуслар!","Здравствуйте, друзья!",tatoeba:2875390,greet,',
  "һәм,һәм,conj,и,Аша һәм эч.,Ешь и пей.,tatoeba:14064597,core,",
  'булу,булу́,v,быть; становиться,"Юк, мин өйдә булдым!","Нет, я был дома!",tatoeba:13212791,core,',
  'Хәлләр ничек?,хәллә́р ни́чек,phr,как дела?,"— Сәлам! Хәлләр ничек? — Яхшы, ә синең?","— Привет! Как дела? — Хорошо, а у тебя?",own,greet,',
].join("\n") + "\n";

/** Their lines of data/gloss/a1.tsv: Исәнмесез! on lines 2–3, һәм 4–6, булу 7–10, Хәлләр ничек? 11–16. */
const GLOSS_LINES = [
  "Исәнмесез!\t1\tИсәнмесез\tисәнмесез\tздравствуйте",
  "Исәнмесез!\t2\tдуслар\tдус\tдрузья",
  "һәм\t1\tАша\tашау\tешь",
  "һәм\t2\tһәм\tһәм\tи",
  "һәм\t3\tэч\tэчү\tпей",
  "булу\t1\tЮк\tюк\tнет",
  "булу\t2\tмин\tмин\tя",
  "булу\t3\tөйдә\tөй\tдома",
  "булу\t4\tбулдым\tбулу\t(я) был",
  "Хәлләр ничек?\t1\tСәлам\tсәлам\tпривет",
  "Хәлләр ничек?\t2\tХәлләр\tхәл\tдела",
  "Хәлләр ничек?\t3\tничек\tничек\tкак",
  "Хәлләр ничек?\t4\tЯхшы\tяхшы\tхорошо",
  "Хәлләр ничек?\t5\tә\tә\tа",
  "Хәлләр ничек?\t6\tсинең\tсин\tу тебя (твои)",
];

const levels = () => [parseCatalogLevel(1, CATALOG)];
const gloss = (lines: string[] = GLOSS_LINES, header = GLOSS_HEADER.join("\t"), level = 1) => parseGlossLevel(level, [header, ...lines].join("\n") + "\n");
/** The fixture with the line of the file `line` (2 … 16) replaced. */
const withLine = (line: number, text: string): string[] => GLOSS_LINES.map((l, i) => (i + 2 === line ? text : l));
const check = (lines: string[]) => checkGloss(levels(), [gloss(lines)]);

describe("reading a breakdown file", () => {
  it("keeps the header and the lines with their line numbers; empty lines and \\r are skipped", () => {
    const g = parseGlossLevel(2, "word\tn\tform\tlemma\tgloss\r\nсу\t1\tСу\tсу\tвода\r\n\r\nсу\t2\tбар\n");
    expect(g).toEqual({
      level: 2, header: "word\tn\tform\tlemma\tgloss",
      lines: [{ line: 2, fields: ["су", "1", "Су", "су", "вода"] }, { line: 4, fields: ["су", "2", "бар"] }],
    });
  });

  it("groups the lines of five fields by the exact word, in file order", () => {
    const byWord = glossByWord(gloss());
    expect([...byWord.keys()]).toEqual(["Исәнмесез!", "һәм", "булу", "Хәлләр ничек?"]);
    expect(byWord.get("булу")).toEqual([
      { form: "Юк", lemma: "юк", gloss: "нет" }, { form: "мин", lemma: "мин", gloss: "я" },
      { form: "өйдә", lemma: "өй", gloss: "дома" }, { form: "булдым", lemma: "булу", gloss: "(я) был" },
    ]);
    expect(glossByWord(gloss(withLine(2, "Исәнмесез!\t1\tИсәнмесез"))).get("Исәнмесез!")).toHaveLength(1);
  });
});

describe("checkGloss (spec B2)", () => {
  it("a level whose breakdown matches its examples has no violation", () => {
    expect(check(GLOSS_LINES)).toEqual([]);
  });

  it("a level without a gloss file is not checked", () => {
    expect(checkGloss(levels(), [])).toEqual([]);
  });

  it("names a wrong header, tabs shown as \\t", () => {
    expect(checkGloss(levels(), [gloss(GLOSS_LINES, "word\tn\tform\tgloss")])).toEqual(["gloss/a1.tsv:1 заголовок «word\\tn\\tform\\tgloss», нужен «word\\tn\\tform\\tlemma\\tgloss»"]);
  });

  it("names a gloss file whose level has no catalog file", () => {
    expect(checkGloss(levels(), [gloss(GLOSS_LINES, undefined, 4)])).toEqual(["gloss/b2.tsv: нет файла уровня b2.csv"]);
  });

  it("names a line without five fields", () => {
    expect(check(withLine(3, "Исәнмесез!\t2\tдуслар\tдус"))).toContain("gloss/a1.tsv:3 разбор: полей 4, нужно 5");
  });

  it("names a line of a word that is no card of the level", () => {
    expect(check([...GLOSS_LINES, "китап\t1\tКитап\tкитап\tкнига"])).toEqual(["gloss/a1.tsv:17 разбор: слова «китап» нет в a1.csv"]);
  });

  it("names a card with an example and no lines", () => {
    expect(check(GLOSS_LINES.filter((l) => !l.startsWith("һәм\t")))).toEqual(["a1:3 разбор: нет строк"]);
  });

  it("names numbers that do not run 1 … n", () => {
    expect(check(withLine(5, "һәм\t3\tһәм\tһәм\tи"))).toEqual(["a1:3 разбор: n не 1…3"]);
    expect(check(withLine(5, "һәм\tдва\tһәм\tһәм\tи"))).toEqual(["a1:3 разбор: n не 1…3"]);
  });

  it("names forms that are not the words of the example", () => {
    expect(check(withLine(6, "һәм\t3\tэчә\tэчү\tпей"))).toEqual(["a1:3 разбор: формы «Аша һәм эчә» не совпадают со словами примера «Аша һәм эч»"]);
    expect(check(GLOSS_LINES.filter((_, i) => i + 2 !== 6))).toEqual(["a1:3 разбор: формы «Аша һәм» не совпадают со словами примера «Аша һәм эч»"]);
  });

  it("names a card whose word is neither a lemma nor a form of its example", () => {
    expect(check(withLine(10, "булу\t4\tбулдым\tбул\t(я) был"))).toEqual(["a1:4 разбор: слово карточки «булу» не стоит ни в lemma, ни в form"]);
  });

  it("finds a phrase card by its first word", () => {
    expect(check(withLine(12, "Хәлләр ничек?\t2\tХәлләр\tхәл\tдела"))).toEqual([]);
    expect(check(withLine(12, "Хәлләр ничек?\t2\tХәлләр\tхәл\tдела").map((l) => l.replace("\tХәлләр\t", "\tхәлләр\t")))).toEqual([
      "a1:5 разбор: формы «Сәлам хәлләр ничек Яхшы ә синең» не совпадают со словами примера «Сәлам Хәлләр ничек Яхшы ә синең»",
    ]);
  });

  it("names an empty lemma and an empty gloss", () => {
    expect(check(withLine(4, "һәм\t1\tАша\t\tешь"))).toEqual(["a1:3 разбор, строка 4: пустая lemma"]);
    expect(check(withLine(4, "һәм\t1\tАша\tашау\t"))).toEqual(["a1:3 разбор, строка 4: пустой gloss"]);
  });

  it("names a gloss longer than 40 characters, counted in characters", () => {
    expect(check(withLine(4, `һәм\t1\tАша\tашау\t${"ё".repeat(40)}`))).toEqual([]);
    expect(check(withLine(4, `һәм\t1\tАша\tашау\t${"ё".repeat(41)}`))).toEqual(["a1:3 разбор, строка 4: gloss длиннее 40"]);
  });

  it("names spaces at the edges of the lemma or the gloss", () => {
    expect(check(withLine(4, "һәм\t1\tАша\tашау\tешь "))).toEqual(["a1:3 разбор, строка 4: пробелы по краям"]);
    expect(check(withLine(4, "һәм\t1\tАша\t ашау\tешь"))).toEqual(["a1:3 разбор, строка 4: пробелы по краям", "a1:3 разбор, строка 4: « ашау» не татарскими буквами"]);
  });

  it("names a form or a lemma that is not in Tatar letters", () => {
    expect(check(withLine(4, "һәм\t1\tАша\tashau\tешь"))).toEqual(["a1:3 разбор, строка 4: «ashau» не татарскими буквами"]);
    expect(check(withLine(4, "һәм\t1\tAша\tашау\tешь"))).toEqual([
      "a1:3 разбор: формы «Aша һәм эч» не совпадают со словами примера «Аша һәм эч»",
      "a1:3 разбор, строка 4: «Aша» не татарскими буквами",
    ]);
  });

  it("a card with an empty example has no lines", () => {
    const empty = parseCatalogLevel(1, `${CATALOG_HEADER.join(",")}\nсу,су,n,вода,,,own,core,\n`);
    expect(checkGloss([empty], [gloss([])])).toEqual([]);
    expect(checkGloss([empty], [gloss(["су\t1\tСу\tсу\tвода"])])).toEqual(["a1:2 разбор: формы «Су» не совпадают со словами примера «»"]);
  });
});
