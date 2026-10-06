import { describe, expect, it } from "vitest";
import { isAttested, tokenize, wordForm } from "../../scripts/lib/forms";

describe("tokenize and wordForm", () => {
  it("cuts a sentence into lower-case words, keeping inner hyphens", () => {
    expect(tokenize("Әти-әни өйдә, 2 бала — урамда!")).toEqual(["әти-әни", "өйдә", "бала", "урамда"]);
  });

  it("finds an inflected form of a noun by the first max(3, length − 2) letters", () => {
    expect(wordForm("Мин китапны укыйм.", "китап", "n")).toBe("китапны");
    expect(wordForm("Бу китабы яңа.", "китап", "n")).toBe("китабы");
    expect(wordForm("Су салкын.", "су", "n")).toBe("су");
    expect(wordForm("Сулар ага.", "су", "n")).toBe("сулар");
    expect(wordForm("Ул китте.", "китап", "n")).toBe("китте");
    expect(wordForm("Ул килде.", "китап", "n")).toBeNull();
  });

  it("finds a verb form by the infinitive without its final у, ү or ю", () => {
    expect(wordForm("Мин мәктәпкә барам.", "бару", "v")).toBe("барам");
    expect(wordForm("Ул китап укый.", "уку", "v")).toBe("укый");
    expect(wordForm("Ул эшләде.", "эшләү", "v")).toBe("эшләде");
    expect(wordForm("Ул эш эзли.", "эшләү", "v")).toBeNull();
    expect(wordForm("Китапны өстәлгә куйды.", "кую", "v")).toBe("куйды");
    expect(wordForm("Яңгыр яуды.", "яву", "v")).toBe("яуды");
    expect(wordForm("Кар ява.", "яву", "v")).toBe("ява");
  });

  it("knows the stem changes: к, п → г, б before a vowel, and the present tense of verbs in -а, -ә", () => {
    expect(wordForm("Ул өйдән чыкты.", "чыгу", "v")).toBe("чыкты");
    expect(wordForm("Мин ачкычны таптым.", "табу", "v")).toBe("таптым");
    expect(wordForm("Ул заводта эшли.", "эшләү", "v")).toBe("эшли");
    expect(wordForm("Без бергә ашыйбыз.", "ашау", "v")).toBe("ашыйбыз");
    expect(wordForm("Аягым авырта.", "аяк", "n")).toBe("аягым");
    expect(wordForm("Күге зәңгәр.", "күк", "n")).toBe("күге");
    expect(wordForm("Тубы кая?", "туп", "n")).toBe("тубы");
  });

  it("ignores the case and the outer spaces of the word", () => {
    expect(wordForm("Бу — Казан.", " КАЗАН ", "n")).toBe("казан");
  });

  it("matches a word of several words across neighbouring tokens", () => {
    expect(wordForm("Ул миңа ярдәм итте.", "ярдәм итү", "v")).toBe("ярдәм итте");
    expect(wordForm("Сезгә зур рәхмәт!", "зур рәхмәт", "phr")).toBe("зур рәхмәт");
    expect(wordForm("Ул итте ярдәм.", "ярдәм итү", "v")).toBeNull();
  });
});

describe("isAttested", () => {
  const attested = new Set(["әти", "әни", "өйдә"]);

  it("takes a token the corpus knows", () => {
    expect(isAttested("өйдә", attested)).toBe(true);
    expect(isAttested("урамда", attested)).toBe(false);
  });

  it("takes a hyphenated token when every part of it is known", () => {
    expect(isAttested("әти-әни", attested)).toBe(true);
    expect(isAttested("әти-бабай", attested)).toBe(false);
  });
});
