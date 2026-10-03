import { describe, expect, it } from "vitest";
import { dictionaryForm, verbInfinitive, verbStems } from "../../scripts/lib/tatar-verbs";

describe("verbInfinitive", () => {
  it.each([["бар", "бару"], ["кил", "килү"], ["аша", "ашау"], ["эшлә", "эшләү"], ["укы", "уку"], ["төзе", "төзү"], ["куй", "кую"], ["сөй", "сөю"], ["ки", "кию"]])(
    "%s → %s", (s, inf) => expect(verbInfinitive(s)).toBe(inf));

  it.each([["чык", "чыгу"], ["тап", "табу"], ["түк", "түгү"], ["тип", "тибү"]])(
    "voices a final к, п after a vowel: %s → %s", (s, inf) => expect(verbInfinitive(s)).toBe(inf));

  it.each([["курк", "курку"], ["тарт", "тарту"], ["әйт", "әйтү"]])(
    "keeps a final consonant after a consonant: %s → %s", (s, inf) => expect(verbInfinitive(s)).toBe(inf));

  it.each([["яу", "яву"], ["сау", "саву"], ["ту", "туу"], ["ю", "юу"], ["төя", "төяү"], ["буя", "буяу"], ["җый", "җыю"], ["елмай", "елмаю"], ["ди", "дию"], ["ое", "ою"], ["бае", "баю"], ["бие", "бию"]])(
    "stems in a vowel or a glide: %s → %s", (s, inf) => expect(verbInfinitive(s)).toBe(inf));

  it.each([["тәмамла", "тәмамлау"], ["гаеплә", "гаепләү"], ["чистарт", "чистарту"], ["канәгатьләндер", "канәгатьләндерү"], ["ремонтла", "ремонтлау"], ["ерт", "ерту"]])(
    "the last vowel of the stem picks the suffix: %s → %s", (s, inf) => expect(verbInfinitive(s)).toBe(inf));

  it("puts the last word of a compound verb into the infinitive", () => {
    expect(verbInfinitive("ярдәм ит")).toBe("ярдәм итү");
    expect(verbInfinitive("сатып ал")).toBe("сатып алу");
  });
});

describe("dictionaryForm", () => {
  it("is the infinitive for verbs and the lemma itself for the rest", () => {
    expect(dictionaryForm("бар", "v")).toBe("бару");
    expect(dictionaryForm("бар", "adj")).toBe("бар");
  });
});

describe("verbStems", () => {
  it("is the infinitive without its final у, ү or ю", () => {
    expect(verbStems("бару")).toEqual(["бар"]);
    expect(verbStems("килү")).toEqual(["кил"]);
    expect(verbStems("кую")).toEqual(["ку"]);
    expect(verbStems("уку")).toEqual(["ук"]);
  });

  it("adds the stem as it sounds before a consonant: г → к, б → п, в → у", () => {
    expect(verbStems("чыгу")).toEqual(["чыг", "чык"]);
    expect(verbStems("табу")).toEqual(["таб", "тап"]);
    expect(verbStems("түгү")).toEqual(["түг", "түк"]);
    expect(verbStems("яву")).toEqual(["яв", "яу"]);
  });

  it("adds the present-tense stem of a verb in -а, -ә: ашау → ашый, эшләү → эшли", () => {
    expect(verbStems("ашау")).toEqual(["аша", "ашый"]);
    expect(verbStems("эшләү")).toEqual(["эшлә", "эшли"]);
  });

  it("takes the last word of a compound verb", () => {
    expect(verbStems("ярдәм итү")).toEqual(["ит"]);
  });
});
