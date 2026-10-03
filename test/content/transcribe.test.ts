import { describe, expect, it } from "vitest";
import { isTatarText } from "../../src/content/tatar";
import { transcribe } from "../../src/content/transcribe";
import { EXCEPTIONS } from "../../src/content/transcribe-exceptions";
import { SECTIONS, TABLE } from "./transcribe.table";

/** Lower-case Tatar Cyrillic plus the three marks of the notation: Latin w, ʼ (U+02BC) and the acute U+0301. */
const TRANSCRIPTION = /^[\u0430-\u044F\u0451\u04D9\u04E9\u04AF\u0497\u04A3\u04BBw\u02BC\u0301]+$/;
const CYRILLIC_WORD = /^[\u0400-\u04FF]+$/;
const ACUTE = "\u0301";
const ALPHABET = [..."аәбвгдеёжҗзийклмнңоөпрстуүфхһцчшщъыьэюя"];
const VOWEL_LETTERS = "аәеёиоөуүыэюя";
const stressMarks = (s: string) => s.split(ACUTE).length - 1;

describe("transcribe: reference table", () => {
  it.each(TABLE)("%s → %s", (word, expected) => expect(transcribe(word)).toBe(expected));
  it("has at least 80 reference words", () => expect(TABLE.length).toBeGreaterThanOrEqual(80));
  it("has no word twice", () => {
    const words = TABLE.map(([word]) => word);
    expect(words.filter((w, i) => words.indexOf(w) !== i)).toEqual([]);
  });
  it("covers each of rules 3–8 with at least six words and has at least 15 exception rows", () => {
    for (const rule of ["rule3", "rule4", "rule5", "rule6", "rule7", "rule8"] as const) {
      expect(SECTIONS[rule].length, rule).toBeGreaterThanOrEqual(6);
    }
    expect(SECTIONS.exceptions.length).toBeGreaterThanOrEqual(15);
    for (const [word] of SECTIONS.exceptions) expect(EXCEPTIONS, word).toHaveProperty(word);
    for (const rule of ["rule3", "rule4", "rule5", "rule6", "rule7", "rule8"] as const) {
      for (const [word] of SECTIONS[rule]) expect(EXCEPTIONS, word).not.toHaveProperty(word);
    }
  });
  it("is written in Tatar letters only, words and transcriptions alike", () => {
    for (const [word, expected] of TABLE) {
      expect(isTatarText(word), word).toBe(true);
      expect(word, word).toMatch(CYRILLIC_WORD);
      expect(expected, word).toMatch(TRANSCRIPTION);
      expect(stressMarks(expected), word).toBeLessThanOrEqual(1);
    }
  });
});

describe("transcribe: exceptions", () => {
  it("keeps lower-case single Tatar words as keys and plain transcriptions as values", () => {
    for (const [word, value] of Object.entries(EXCEPTIONS)) {
      expect(word, word).toMatch(CYRILLIC_WORD);
      expect(isTatarText(word), word).toBe(true);
      expect(word).toBe(word.toLowerCase());
      expect(value, word).toMatch(TRANSCRIPTION);
      expect(stressMarks(value), word).toBeLessThanOrEqual(1);
      expect(transcribe(word)).toBe(value);
    }
  });
  it("finds an exception whatever the case of the input", () => {
    expect(transcribe("Кайда")).toBe("къа́йда");
    expect(transcribe("НИЧЕК")).toBe("ни́чек");
  });
  it("leaves a word that is not listed to the rules", () => {
    expect(transcribe("алма")).toBe("алма́");   // «яблоко»; the negative «а́лма» is a homograph and is not listed
  });
});

describe("transcribe: text", () => {
  it("transcribes phrases word by word and keeps punctuation", () => expect(transcribe("Исәнмесез! Хәлләр ничек?")).toBe("исәнмесе́з! хәллә́р ни́чек?"));
  it("never throws and leaves non-Tatar input as is", () => {
    for (const s of ["", "   ", "hello", "123", "🙂", "wifi роутер", "а".repeat(500)]) expect(() => transcribe(s)).not.toThrow();
    expect(transcribe("hello")).toBe("hello"); expect(transcribe("")).toBe("");
  });
  it("never throws on broken or hostile strings", () => {
    const hostile = ["\uD83D", "\uDC00а", "а\uD83D", "\u0000", "\u0301", "а\u0301", "ьъьъ", "къ", "гъ", "кь", "ъя", "ьеъю",
      "\u04C0", "\u0487\u0488", "\u0130stanbul", "constructor", "__proto__", "toString", "к".repeat(100_000), "я".repeat(100_000)];
    for (const s of hostile) expect(() => transcribe(s), JSON.stringify(s.slice(0, 12))).not.toThrow();
    expect(transcribe("constructor")).toBe("constructor");
    expect(transcribe("__proto__")).toBe("__proto__");
    expect(transcribe("\uD83D")).toBe("\uD83D");
  });
  it("keeps the notation well formed for every string of one to three Tatar letters", () => {
    const broken: string[] = [];
    const check = (word: string): void => {
      const t = transcribe(word);
      const vowels = [...t].filter((c) => VOWEL_LETTERS.includes(c)).length;
      const at = t.indexOf(ACUTE);
      const wellFormed = (t === "" || TRANSCRIPTION.test(t))
        && stressMarks(t) === (vowels > 1 ? 1 : 0)
        && (at === -1 || VOWEL_LETTERS.includes(t[at - 1] ?? " "));
      if (!wellFormed && broken.length < 10) broken.push(`${word} → ${t}`);
    };
    for (const a of ALPHABET) {
      check(a);
      for (const b of ALPHABET) {
        check(a + b);
        for (const c of ALPHABET) check(a + b + c);
      }
    }
    expect(broken).toEqual([]);
  });
  it("lower-cases Cyrillic words and leaves everything else untouched", () => {
    expect(transcribe("Вакыт")).toBe("wакъы́т");
    expect(transcribe("ТАУ")).toBe("таw");
    expect(transcribe("Wi-Fi 5G 🙂")).toBe("Wi-Fi 5G 🙂");
    expect(transcribe("  авыл,  тау…  ")).toBe("  аwы́л,  таw…  ");
  });
  it("treats the parts of a hyphenated word as separate words", () => {
    expect(transcribe("әкрен-әкрен")).toBe("әкре́н-әкре́н");
    expect(transcribe("бала-чага")).toBe("бала́-чагъа́");
  });
  it("puts one stress mark on every word of two or more syllables and none on shorter ones", () => {
    expect(transcribe("мин татар телен өйрәнәм")).toBe("мин тата́р теле́н өйрәнә́м");
  });
  it("does not choke on stray letters and signs", () => {
    expect(transcribe("ь")).toBe("");
    expect(transcribe("ъ")).toBe("");
    expect(transcribe("к")).toBe("к");
    expect(transcribe("в")).toBe("w");
    expect(transcribe("қазақ")).toBe("қаза́қ");   // foreign Cyrillic passes through letter by letter
  });
});

describe("transcribe: rule details", () => {
  it("rule 3: decides къ/гъ by the vowel of the same syllable", () => {
    expect(transcribe("китапка")).toBe("китапкъа́");   // front word, back syllable
    expect(transcribe("мәктәпкә")).toBe("мәктәпкә́");
    expect(transcribe("юкка")).toBe("йукъкъа́");        // ю read as [йу] is a back vowel for the к after it
    expect(transcribe("кырык")).toBe("къыры́къ");        // к at the end of a syllable, a consonant in between
    expect(transcribe("класс")).toBe("класс");          // no vowel in reach: plain к
  });
  it("rule 4: needs к/г before the vowel and ь after the next consonant", () => {
    expect(transcribe("сәгатьне")).toBe("сәгъәтне́");
    expect(transcribe("мәшгульлек")).toBe("мәшгъүлле́к");   // у is read [ү] the same way
    expect(transcribe("тугыз")).toBe("тугъы́з");           // no ь: у and ы stay back
    expect(transcribe("медаль")).toBe("меда́л");        // not after к/г: а stays
    expect(transcribe("бакыр")).toBe("бакъы́р");        // no ь: the vowel stays
  });
  it("rule 5: у, ү stay vowels after a consonant and at the word start", () => {
    expect(transcribe("урам")).toBe("ура́м");
    expect(transcribe("үлән")).toBe("үлә́н");
    expect(transcribe("бару")).toBe("бару́");
    expect(transcribe("килү")).toBe("килү́");
  });
  it("rule 6: after ь, ъ the vowel is back whatever the row of the word", () => {
    expect(transcribe("дөньяга")).toBe("дөнйагъа́");
    expect(transcribe("төньяк")).toBe("төнйа́къ");
    expect(transcribe("бишьеллык")).toBe("бишйыллы́къ");
    expect(transcribe("кулъязма")).toBe("къулйазма́");
  });
  it("rule 7: э is a vowel at the word start and after a consonant", () => {
    expect(transcribe("эшче")).toBe("эшче́");
    expect(transcribe("эт")).toBe("эт");
  });
});
