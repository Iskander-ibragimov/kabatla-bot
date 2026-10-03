import { describe, expect, it } from "vitest";
import { hasTatarLetters, isBackWord, isTatarText } from "../../src/content/tatar";

const UPPER = "АӘБВГДЕЁЖҖЗИЙКЛМНҢОӨПРСТУҮФХҺЦЧШЩЪЫЬЭЮЯ";
const LOWER = "аәбвгдеёжҗзийклмнңоөпрстуүфхһцчшщъыьэюя";

/** Code points that look like Tatar letters but are not. Written as escapes so the source cannot hide them. */
const LOOK_ALIKES: [name: string, char: string][] = [
  ["Latin h", "h"], ["Latin H", "H"], ["Latin schwa ə", "ə"], ["Latin SCHWA Ə", "Ə"],
  ["Latin y", "y"], ["Latin Y", "Y"], ["Latin e", "e"], ["Latin a", "a"], ["Latin o", "o"],
  ["Latin c", "c"], ["Latin x", "x"], ["Latin p", "p"],
  ["Kazakh қ", "қ"], ["Kazakh/Bashkir ғ", "ғ"], ["Kazakh ұ", "ұ"], ["Kazakh/Ukrainian і", "і"],
  ["Bashkir ҙ", "ҙ"], ["Bashkir ҫ", "ҫ"], ["Bashkir ҡ", "ҡ"],
  ["Ukrainian ї", "ї"], ["Ukrainian є", "є"],
  ["Cyrillic schwa with diaeresis ӛ", "ӛ"], ["Cyrillic fita ѳ", "ѳ"], ["Greek theta θ", "θ"],
];

describe("hasTatarLetters", () => {
  it("detects Tatar letters and look-alikes", () => {
    expect(hasTatarLetters("әни")).toBe(true); expect(hasTatarLetters("эни")).toBe(false);
    expect(isTatarText("Һава яхшы.")).toBe(true);
    expect(isTatarText("hава")).toBe(false);   // латинская h
    expect(isTatarText("əни")).toBe(false);    // латинская ə U+0259
  });
  it.each([..."әөүҗңһӘӨҮҖҢҺ"])("finds %s", (letter) => expect(hasTatarLetters(`су${letter}`)).toBe(true));
  it("is false for Russian-only, empty and non-Cyrillic text", () => {
    for (const s of ["", "привет", "Казан", "hello", "123"]) expect(hasTatarLetters(s)).toBe(false);
  });
  it.each(LOOK_ALIKES)("does not take %s for a Tatar letter", (_name, char) => expect(hasTatarLetters(char)).toBe(false));
});

describe("isTatarText", () => {
  it("accepts the whole Tatar alphabet in both cases", () => {
    expect(UPPER).toHaveLength(39);
    expect(LOWER).toBe(UPPER.toLowerCase());
    expect(isTatarText(UPPER)).toBe(true);
    expect(isTatarText(LOWER)).toBe(true);
  });
  it("accepts digits, spaces and the listed punctuation", () => {
    expect(isTatarText("Сәгать 10 тулды: кил, зинһар!")).toBe(true);
    for (const mark of [..." .,!?:;-–—«»\"'()…0123456789"]) expect(isTatarText(`сүз${mark}сүз`), JSON.stringify(mark)).toBe(true);
  });
  it.each(LOOK_ALIKES)("rejects %s", (_name, char) => {
    expect(isTatarText(char)).toBe(false);
    expect(isTatarText(`сүз${char}`)).toBe(false);
  });
  it("rejects anything outside the list", () => {
    for (const s of ["сүз\nсүз", "сүз\tсүз", "сүз сүз", "сүз/сүз", "сүз_сүз", "[сүз]", "wакъы́т", "сүз🙂", "hello"]) {
      expect(isTatarText(s), JSON.stringify(s)).toBe(false);
    }
  });
  it("is vacuously true for the empty string", () => expect(isTatarText("")).toBe(true));
});

describe("isBackWord", () => {
  it.each([
    ["вакыт", true], ["авыл", true], ["уку", true], ["сыер", true], ["кояш", true],
    ["мәктәп", false], ["өй", false], ["күл", false], ["ике", false], ["эш", false],
    ["китап", false],  // the first unambiguous vowel decides
    ["яңа", true], ["ярдәм", false], ["ерак", true], ["ефәк", false], ["юкә", false],
    ["яшел", false], ["егет", false],  // е after a consonant is front
    ["ел", true], ["юл", true], ["юк", true], ["ая", true],  // only я/ю/е, no ь at the end
    ["яшь", false], ["юнь", false], ["ямь", false],  // only я/ю/е and ь at the end
    ["Вакыт", true], ["МӘКТӘП", false],
    ["", true], ["к", true],
  ] as [string, boolean][])("%s → %s", (word, back) => expect(isBackWord(word)).toBe(back));
});
