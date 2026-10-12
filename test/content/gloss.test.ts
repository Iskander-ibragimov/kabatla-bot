import { describe, expect, it } from "vitest";
import { GLOSS_EDGE, GLOSS_MAX, TATAR_WORD, cardWordLines, exampleWords, glossKey, parseGloss } from "../../src/content/gloss";

describe("the words of an example (spec B1)", () => {
  it("a lone dash disappears, punctuation goes at the edges only", () => {
    expect(exampleWords("— Сәлам! Хәлләр ничек? — Яхшы, ә синең?")).toEqual(["Сәлам", "Хәлләр", "ничек", "Яхшы", "ә", "синең"]);
  });
  it("a number with its ending and a hyphenated word stay one word", () => {
    expect(exampleWords("Ул 5-че сыйныфта әкрен-әкрен укый.")).toEqual(["Ул", "5-че", "сыйныфта", "әкрен-әкрен", "укый"]);
  });
  it("quotes and brackets are stripped at the edges", () => {
    expect(exampleWords("«Китап» (яңа)…")).toEqual(["Китап", "яңа"]);
    expect(exampleWords("“Әйе”, „юк“ [бар]")).toEqual(["Әйе", "юк", "бар"]);
  });
  it("an empty example has no words", () => {
    expect(exampleWords("")).toEqual([]);
    expect(exampleWords("  — ")).toEqual([]);
  });
});

describe("the key of a word", () => {
  it("is trimmed, stripped at the edges, lower case, ё as е", () => {
    expect(glossKey(" Ёлка! ")).toBe("елка");
    expect(glossKey("«Әни»")).toBe("әни");
  });
  it("is NFC: a decomposed letter equals the composed one", () => {
    expect(glossKey("ёж")).toBe(glossKey("ёж"));
  });
});

describe("the lines of the card's word (spec B2)", () => {
  it("a phrase is found by its first word, through the form", () => {
    expect(cardWordLines("Хәлләр ничек?", [{ form: "Сәлам", lemma: "сәлам" }, { form: "Хәлләр", lemma: "хәл" }])).toEqual([false, true]);
  });
  it("a word is found through the lemma", () => {
    expect(cardWordLines("булу", [{ form: "булдым", lemma: "булу" }])).toEqual([true]);
  });
  it("case and edge punctuation are ignored; a word that matches nothing marks no line", () => {
    expect(cardWordLines("Исәнмесез!", [{ form: "Исәнмесез", lemma: "исәнмесез" }, { form: "дуслар", lemma: "дус" }])).toEqual([true, false]);
    expect(cardWordLines("китап", [{ form: "су", lemma: "су" }])).toEqual([false]);
  });
});

describe("the stored breakdown", () => {
  it("is read back as entries", () => {
    expect(parseGloss('[["китабымны","китап","мою книгу","A1"]]')).toEqual([["китабымны", "китап", "мою книгу", "A1"]]);
    expect(parseGloss('[["укыйм","уку","(я) читаю",null]]')).toEqual([["укыйм", "уку", "(я) читаю", null]]);
  });
  it("anything else is no breakdown", () => {
    for (const bad of [null, "", "{}", "[]", '[["a","b"]]', '[["a","b","c",5]]', '[["a","b","c",null,1]]', "[1]", "nope"]) expect(parseGloss(bad)).toBeNull();
  });
});

describe("constants shared with the interim checker", () => {
  it("are the checker's", () => {
    expect(GLOSS_MAX).toBe(40);
    expect(GLOSS_EDGE).toBe(".,!?;:«»\"()…—–-'“”„[]");
    expect(TATAR_WORD.test("5-че")).toBe(true);
    expect(TATAR_WORD.test("әкрен-әкрен")).toBe(true);
    expect(TATAR_WORD.test("kitap")).toBe(false);
    expect(TATAR_WORD.test("-су")).toBe(false);
  });
});
