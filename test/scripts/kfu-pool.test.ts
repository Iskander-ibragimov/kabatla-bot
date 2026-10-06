import { describe, expect, it } from "vitest";
import type { KfuTopic } from "../../scripts/lib/kfu";
import { type Corpus, POOL_HEADER, buildPool, classifyEntry, entryKey, formatPool, infinitiveForms } from "../../scripts/lib/kfu-pool";

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
  const corpus: Corpus = {
    known: new Set(["язу", "килү", "дус", "булу", "карга", "белем", "алу", "әни", "өй", "су", "агу", "бару", "аяк", "кием", "ризык", "бүлмә", "ял", "урын", "эш"]),
    finite: new Map([["бара", "бару"], ["бармый", "бару"], ["ага", "агу"]]),
  };
  const sort = (entry: string) => classifyEntry(entry, corpus);
  const kind = (entry: string) => sort(entry).kind;
  const lemma = (entry: string) => sort(entry).lemma;

  it("takes one token for a word", () => {
    expect(sort("өй")).toEqual({ kind: "word", lemma: "өй", found: "lemma", words: [] });
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
    expect(classifyEntry("ашарга", { known: new Set(["ашау", "ашу"]), finite: new Map() }).lemma).toBe("ашау");
    expect(classifyEntry("ашарга", { known: new Set(["ашу"]), finite: new Map() }).lemma).toBe("ашу");
  });

  it("leads a finite form of a corpus verb, alone or the first of a pair, back to the verb", () => {
    expect(sort("бара")).toEqual({ kind: "word", lemma: "бару", found: "form", words: [] });
    expect(sort("бара\\бармый")).toEqual({ kind: "word", lemma: "бару", found: "form", words: [] });
    expect(sort("бармый")).toMatchObject({ lemma: "бару", found: "form" });
  });

  it("says how the corpus knows a word: by its lemma, as a form of a verb, or not at all", () => {
    expect(sort("язарга").found).toBe("lemma");
    expect(sort("кил-ергә").found).toBe("lemma");
    expect(sort("бара").found).toBe("form");
    expect(sort("юкбар")).toEqual({ kind: "word", lemma: "юкбар", found: "none", words: [] });
    expect(sort("зурларга").found).toBe("none");
    expect(sort("көл-әргә").found).toBe("none");
    // The possessive is cut only inside a combination: a single word in that form is not led back to its stem.
    expect(sort("киеме")).toEqual({ kind: "word", lemma: "киеме", found: "none", words: [] });
  });

  it("reads the main form of an entry with a variant: before the brackets, the slash or the comma, without the final sign", () => {
    expect(sort("әни (әнкәй)")).toEqual({ kind: "word", lemma: "әни", found: "lemma", words: [] });
    expect(lemma("гына/генә, кына/кенә")).toBe("гына");
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
    expect(sort("Син кайда?")).toEqual({ kind: "phrase", lemma: "Син кайда?", found: "", words: [] });
    expect(sort("Рәхмәт сезгә! (Рәхмәт!)")).toEqual({ kind: "phrase", lemma: "Рәхмәт сезгә!", found: "", words: [] });
    expect(sort("– Кунакка рәхим итегез.")).toEqual({ kind: "phrase", lemma: "Кунакка рәхим итегез.", found: "", words: [] });
    expect(sort(". – Сезгә уңышлар телим.").lemma).toBe("Сезгә уңышлар телим.");
    expect(kind("рәхим итегез")).toBe("phrase");
    expect(kind("Чынмыни")).toBe("phrase");
    expect(kind("Сәлам!")).toBe("phrase");
  });

  it("takes an entry that begins with a capital or a quotation mark for a name", () => {
    for (const entry of ["Казан", "Яңа ел бәйрәме", "«Чишмә» балалар бакчасы", "“Кояш” кафесы", "IT-белгеч", "(ТР)"]) expect([entry, kind(entry)]).toEqual([entry, "name"]);
    expect(sort("Казан")).toEqual({ kind: "name", lemma: "Казан", found: "", words: [] });
  });

  it("takes the rest for a free combination and names its words the corpus knows, a verb in its dictionary form", () => {
    expect(sort("белем алырга")).toEqual({ kind: "combination", lemma: "белем алу", found: "", words: ["белем", "алу"] });
    expect(sort("дус бул-ырга")).toEqual({ kind: "combination", lemma: "дус булу", found: "", words: ["дус", "булу"] });
    expect(sort("су ага\\ акмый")).toEqual({ kind: "combination", lemma: "су агу", found: "", words: ["су", "агу"] });
    expect(sort("зур шәһәр")).toEqual({ kind: "combination", lemma: "зур шәһәр", found: "", words: [] });
    expect(sort("өй өй").words).toEqual(["өй"]);
  });

  it("finds the head of a combination in the possessive form: without -ы/-е, -сы/-се, -лары/-ләре, and with к, п for г, б", () => {
    expect(sort("аяк киеме").words).toEqual(["аяк", "кием"]);
    expect(sort("эш урыны").words).toEqual(["эш", "урын"]);
    expect(sort("ял бүлмәсе").words).toEqual(["ял", "бүлмә"]);
    expect(sort("милли ризыгы").words).toEqual(["ризык"]);
    expect(sort("милли ризыклары").words).toEqual(["ризык"]);
    expect(sort("аяк киеме").lemma).toBe("аяк киеме");
    // A word the corpus knows as it stands is not cut: карга is no possessive of «кар».
    expect(sort("кара карга").words).toEqual(["карга"]);
    expect(sort("зур сы").words).toEqual([]);
  });

  it("works without the corpus words", () => {
    expect(classifyEntry("язарга")).toEqual({ kind: "word", lemma: "язу", found: "none", words: [] });
    expect(classifyEntry("белем алырга")).toEqual({ kind: "combination", lemma: "белем алу", found: "", words: [] });
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
  const levels: { level: string; topics: KfuTopic[] }[] = [
    { level: "a1", topics: [
      { name: "Танышу", heading: "Танышу", entries: ["Сәлам!", "өй", "яз-арга", "Казан", "белем алырга"] },
      { name: "Шәһәр", heading: "Шәһәр. Транспорт", entries: ["урам", "өй"] },
    ] },
    { level: "a2", topics: [{ name: "Табибта", heading: "Табибта", entries: ["язарга", "урам", "авыру", "сәлам", "ала"] }] },
  ];
  const ranks = new Map([["өй", 40], ["язу", 7], ["белем", 300], ["алу", 3], ["авыру", 900]]);
  const catalog = new Map([["сәлам", "a1"], ["язу", "a1"], ["авыру", "a2"]]);
  const pool = buildPool(levels, { ranks, catalog, finite: new Map([["ала", "алу"]]) });

  it("keeps an entry once, at the lowest level and in the first topic it stands in", () => {
    expect(pool.map((p) => `${p.entry}@${p.level}`)).toEqual(["Сәлам!@a1", "өй@a1", "яз-арга@a1", "Казан@a1", "белем алырга@a1", "урам@a1", "авыру@a2", "ала@a2"]);
  });

  it("gives every entry the heading it stands under and the topic of the catalog", () => {
    expect(pool[0]).toMatchObject({ kfuTopic: "Танышу", topic: "greet" });
    expect(pool[5]).toMatchObject({ kfuTopic: "Шәһәр. Транспорт", topic: "city" });
    expect(pool[6]).toMatchObject({ kfuTopic: "Табибта", topic: "health" });
  });

  it("ranks a word by its dictionary form and leaves the rest without a rank", () => {
    expect(pool.map((p) => [p.kind, p.lemma, p.rank])).toEqual([
      ["phrase", "Сәлам!", null], ["word", "өй", 40], ["word", "язу", 7], ["name", "Казан", null], ["combination", "белем алу", null], ["word", "урам", null], ["word", "авыру", 900],
      ["word", "алу", 3],
    ]);
    expect(pool.map((p) => p.found)).toEqual(["", "lemma", "lemma", "", "", "none", "lemma", "form"]);
    expect(pool[4]!.words).toEqual(["белем", "алу"]);
  });

  it("names the level file that already holds the word", () => {
    expect(pool.map((p) => p.inCatalog)).toEqual(["a1", "", "a1", "", "", "", "a2", ""]);
  });

  it("fails on a topic without a mapping", () => {
    expect(() => buildPool([{ level: "a1", topics: [{ name: "Яңа тема", heading: "Яңа тема", entries: ["өй"] }] }], { ranks, catalog })).toThrow(/«Яңа тема»/);
  });

  it("writes the pool as a table with a header", () => {
    expect([...POOL_HEADER]).toEqual(["entry", "level", "kfu_topic", "topic", "kind", "lemma", "found", "rank", "in_catalog", "words"]);
    expect(formatPool(pool).split("\n").slice(0, 3)).toEqual([
      POOL_HEADER.join("\t"),
      "Сәлам!\ta1\tТанышу\tgreet\tphrase\tСәлам!\t\t\ta1\t",
      "өй\ta1\tТанышу\tgreet\tword\tөй\tlemma\t40\t\t",
    ]);
    expect(formatPool(pool).split("\n")[5]).toBe("белем алырга\ta1\tТанышу\tgreet\tcombination\tбелем алу\t\t\t\tбелем, алу");
    expect(formatPool(pool).split("\n")[6]).toBe("урам\ta1\tШәһәр. Транспорт\tcity\tword\tурам\tnone\t\t\t");
    expect(formatPool(pool).endsWith("\n")).toBe(true);
  });
});
