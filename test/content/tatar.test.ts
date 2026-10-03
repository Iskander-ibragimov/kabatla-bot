import { describe, expect, it } from "vitest";
import { hasTatarLetters, isBackWord, isTatarText } from "../../src/content/tatar";

const UPPER = "АӘБВГДЕЁЖҖЗИЙКЛМНҢОӨПРСТУҮФХҺЦЧШЩЪЫЬЭЮЯ";
const LOWER = "аәбвгдеёжҗзийклмнңоөпрстуүфхһцчшщъыьэюя";

/** Code points that look like Tatar letters but are not. The characters are escapes, so the source cannot hide them. */
const LOOK_ALIKES: [name: string, char: string][] = [
  ["Latin h", "\u0068"], ["Latin H", "\u0048"], ["Latin schwa U+0259", "\u0259"], ["Latin SCHWA U+018F", "\u018F"],
  ["Latin y", "\u0079"], ["Latin Y", "\u0059"], ["Latin e", "\u0065"], ["Latin a", "\u0061"], ["Latin o", "\u006F"],
  ["Latin c", "\u0063"], ["Latin x", "\u0078"], ["Latin p", "\u0070"],
  ["Kazakh ka with descender U+049B", "\u049B"], ["Kazakh/Bashkir ghe with stroke U+0493", "\u0493"],
  ["Kazakh straight u with stroke U+04B1", "\u04B1"], ["Kazakh/Ukrainian i U+0456", "\u0456"],
  ["Bashkir ze with descender U+0499", "\u0499"], ["Bashkir es with descender U+04AB", "\u04AB"], ["Bashkir qa U+04A1", "\u04A1"],
  ["Ukrainian yi U+0457", "\u0457"], ["Ukrainian ie U+0454", "\u0454"],
  ["Cyrillic schwa with diaeresis U+04DB", "\u04DB"], ["Cyrillic fita U+0473", "\u0473"], ["Greek theta U+03B8", "\u03B8"],
];

/** ә ө ү җ ң һ: lower case, then upper case. */
const TATAR_ONLY_CODE_POINTS = [0x04d9, 0x04e9, 0x04af, 0x0497, 0x04a3, 0x04bb, 0x04d8, 0x04e8, 0x04ae, 0x0496, 0x04a2, 0x04ba];
/** Everything isTatarText lets through: А–я, Ё, ё, the six Tatar letters in both cases, digits, the space and 16 marks. */
const ALLOWED_CODE_POINTS = new Set<number>([
  ...Array.from({ length: 0x044f - 0x0410 + 1 }, (_, i) => 0x0410 + i), 0x0401, 0x0451,
  ...TATAR_ONLY_CODE_POINTS,
  ...Array.from({ length: 10 }, (_, i) => 0x30 + i), 0x20,
  0x2e, 0x2c, 0x21, 0x3f, 0x3a, 0x3b, 0x2d, 0x2013, 0x2014, 0xab, 0xbb, 0x22, 0x27, 0x28, 0x29, 0x2026,
]);
const BMP = Array.from({ length: 0x10000 }, (_, cp) => cp);

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
  it("is true for exactly twelve code points of the Basic Multilingual Plane", () => {
    expect(BMP.filter((cp) => hasTatarLetters(String.fromCharCode(cp)))).toEqual([...TATAR_ONLY_CODE_POINTS].sort((a, b) => a - b));
  });
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
    for (const s of ["сүз\nсүз", "сүз\tсүз", "сүз\u00A0сүз", "сүз/сүз", "сүз_сүз", "[сүз]", "wакъы́т", "сүз🙂", "hello"]) {
      expect(isTatarText(s), JSON.stringify(s)).toBe(false);
    }
  });
  it("lets through exactly the listed code points of the Basic Multilingual Plane", () => {
    expect(ALLOWED_CODE_POINTS.size).toBe(66 + 12 + 10 + 1 + 16);
    expect(BMP.filter((cp) => isTatarText(String.fromCharCode(cp)))).toEqual([...ALLOWED_CODE_POINTS].sort((a, b) => a - b));
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
