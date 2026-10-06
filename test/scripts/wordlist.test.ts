import { describe, expect, it } from "vitest";
import {
  apertium, attestedForms, buildCandidates, exampleCounter, findExamples, formatCandidates, formatDroppedVerbs, lookupPos, parseDix, parseLemmas, parseTatoeba,
  rankWords, verbInfinitives,
} from "../../scripts/lib/wordlist";

const DIX = `<dictionary><section id="main" type="standard">
<e>       <p><l>бар<s n="v"/><s n="iv"/></l>           <r>идти<s n="vblex"/><s n="impf"/><s n="iv"/></r></p><par n="impf__verb"/></e>
<e>       <p><l>бар<s n="v"/><s n="iv"/></l>           <r>пойти<s n="vblex"/><s n="perf"/><s n="iv"/></r></p><par n="perf__verb"/></e>
<e>       <p><l>бар<s n="adj"/></l>                    <r>быть<s n="vbser"/><s n="pres"/></r></p></e>
<e>       <p><l>бар<s n="n"/></l>                      <r>бар<s n="n"/><s n="m"/><s n="nn"/></r></p><par n="__n"/></e>
<e>       <p><l>район<s n="n"/></l>                    <r>район<s n="n"/><s n="m"/><s n="nn"/></r></p><par n="__n"/></e>
<e>       <p><l>район<s n="n"/><s n="attr"/></l>       <r>районный<s n="adj"/><s n="m"/></r></p></e>
<e>       <p><l>ярдәм<b/>ит<s n="v"/><s n="iv"/></l>   <r>помогать<s n="vblex"/><s n="impf"/><s n="iv"/></r></p><par n="impf__verb"/></e>
<e>       <p><l>китап<s n="n"/></l>                    <r>книга<s n="n"/><s n="f"/><s n="nn"/></r></p><par n="__n"/></e>
<e>       <p><l>ул<s n="prn"/><s n="pers"/></l>        <r>он<s n="prn"/><s n="pers"/></r></p></e>
<e>       <p><l>ул<s n="det"/><s n="dem"/></l>         <r>тот<s n="det"/><s n="dem"/></r></p></e>
<e>       <p><l>ул<s n="n"/></l>                       <r>сын<s n="n"/></r></p></e>
<e>       <p><l>теге<b/>юлы<s n="adv"/></l>            <r>в<b/>тот<b/>раз<s n="adv"/></r></p></e>
<e>       <p><l>Казан<s n="np"/><s n="top"/></l>       <r>Казань<s n="np"/><s n="top"/></r></p></e>
<e>       <p><l>май<s n="n"/></l>                      <r>май<s n="n"/><s n="m"/><s n="nn"/></r></p><par n="__n"/></e>
<e>       <p><l>май<s n="n"/></l>                      <r>масло<s n="n"/><s n="nt"/><s n="nn"/></r></p><par n="__n"/></e>
<e>       <p><l>ел<s n="n"/></l>                       <r>год²<s n="n"/><s n="m"/><s n="nn"/></r></p><par n="__n"/></e>
<e>       <p><l>ни<s n="cnjcoo"/></l>                  <r>ни<s n="cnjcoo"/></r></p></e>
<e>       <p><l>ни<s n="prn"/><s n="itg"/></l>         <r>что<s n="prn"/><s n="itg"/><s n="nt"/></r></p></e>
  <e>       <p><l></l>          <r><s n="m"/><s n="an"/><s n="sg"/><s n="nom"/></r></p></e>
</section></dictionary>`;
const dix = parseDix(DIX);

describe("parseDix and apertium", () => {
  it("keys the entries by dictionary form and project part of speech", () => {
    expect(apertium(dix, "бару", "v")).toEqual(["идти", "пойти"]);
    expect(apertium(dix, "бар", "adj")).toEqual(["быть"]);
    expect(apertium(dix, "бар", "n")).toEqual(["бар"]);
    expect(apertium(dix, "район", "n")).toEqual(["район", "районный"]);
    expect(apertium(dix, "ярдәм итү", "v")).toEqual(["помогать"]);
    expect(apertium(dix, "теге юлы", "adv")).toEqual(["в тот раз"]);
  });

  it("joins prn and det into pron, skips proper nouns and empty entries", () => {
    expect(apertium(dix, "ул", "pron")).toEqual(["он", "тот"]);
    expect(apertium(dix, "казан", "n")).toEqual([]);
    expect(apertium(dix, "Казан", "n")).toEqual([]);
    expect(apertium(dix, "", "n")).toEqual([]);
  });

  it("answers from any part of speech when the asked one has no entry", () => {
    expect(apertium(dix, "китап", "adj")).toEqual(["книга"]);
    expect(apertium(dix, "китап")).toEqual(["книга"]);
    expect(apertium(dix, "ул")).toEqual(["он", "тот", "сын"]);
    expect(apertium(dix, "өстәл", "n")).toEqual([]);
  });

  it("drops the homonym marks of the Russian side", () => {
    expect(apertium(dix, "ел", "n")).toEqual(["год"]);
  });
});

const LEMMAS = [
  "900\tул\tprn", "800\tбул\tv", "700\tрайон\tn", "600\tбар\tv", "500\tбар\tadj", "400\tкабул\tv", "300\tкитап\tn", "250\tал\tv", "150\tал\tvaux",
  "120\tалд\tn", "100\tә\tcnjcoo", "90\tКазан\tnp", "80\tbул\tn", "70\t2010\tnum", "65\t3м\tnum", "60\tМәскәү\tn", "50\tзззз\tasterisk", "45\tтр.\tabbr",
  "40\tхатын-кыз\tn", "30\tул\tn", "20\tгына\tpostadv", "10\tһәм\tcnjcoo", "5\tаһ\tij", "4\tбелән\tpost", "3\tбер\tnum", "2\tбу\tdet", "1\tи\tcop",
  "37\tбар\tn", "35\tмай\tn", "33\tни\tprn", "31\tни\tcnjcoo",
].join("\n") + "\n";
const FORMS = new Set(["ул", "булу", "район", "бару", "бар", "китап", "алу", "хатын-кыз", "гына", "һәм", "аһ", "белән", "бер", "бу", "май", "ни"]);

describe("buildCandidates", () => {
  const lemmas = parseLemmas(LEMMAS);
  const built = buildCandidates(lemmas, FORMS, dix);

  it("reads the lemma list", () => {
    expect(lemmas).toHaveLength(31);
    expect(lemmas[0]).toEqual({ count: 900, lemma: "ул", pos: "prn" });
  });

  it("merges the lists by frequency, with verbs in the infinitive and the counts of one word added up", () => {
    expect(built.candidates.map((c) => [c.word, c.pos, c.count])).toEqual([
      ["ул", "pron", 930], ["булу", "v", 800], ["бару", "v", 600], ["бар", "adj", 537], ["алу", "v", 400], ["китап", "n", 300],
      ["ни", "pron", 64], ["хатын-кыз", "n", 40], ["май", "n", 35], ["гына", "adv", 20], ["һәм", "conj", 10], ["аһ", "intj", 5], ["белән", "post", 4], ["бер", "num", 3], ["бу", "pron", 2],
    ]);
  });

  it("notes the other parts of speech of a merged word", () => {
    expect(built.candidates[0]!.also).toBe("n 30");
    expect(built.candidates[1]!.also).toBe("");
  });

  it("adds the Apertium translations, the main part of speech first", () => {
    expect(built.candidates[0]!.apertium).toEqual(["он", "тот", "сын"]);
    expect(built.candidates[2]!.apertium).toEqual(["идти", "пойти"]);
    expect(built.candidates[3]!.apertium).toEqual(["быть", "бар"]);
    expect(built.candidates[4]!.apertium).toEqual([]);
  });

  it("sets aside the words whose main part of speech Apertium translates by the word itself and its derivatives", () => {
    expect(built.cognates).toEqual([{ word: "район", count: 700 }]);
  });

  it("keeps a word that has a translation of its own (май — масло) or is a look-alike only in a minor part of speech (бар, ни)", () => {
    const of = (word: string) => built.candidates.find((c) => c.word === word);
    expect(of("май")).toMatchObject({ pos: "n", apertium: ["май", "масло"] });
    expect(of("бар")).toMatchObject({ pos: "adj", also: "n 37" });
    expect(of("ни")).toMatchObject({ pos: "pron", apertium: ["что", "ни"], also: "conj 31" });
  });

  it("sets aside the cognates named by hand as well", () => {
    const again = buildCandidates(lemmas, FORMS, dix, 3500, new Set(["китап"]));
    expect(again.cognates).toEqual([{ word: "район", count: 700 }, { word: "китап", count: 300 }]);
    expect(again.candidates.map((c) => c.word)).not.toContain("китап");
  });

  it("counts the corpus total and the dropped lemmas by reason", () => {
    expect(built.total).toBe(lemmas.reduce((s, l) => s + l.count, 0));
    expect(built.dropped).toEqual({ list: 3, digits: 2, latin: 1, upper: 1, short: 2, symbols: 0, unattested: 2 });
    expect(built.kept).toBe(20);
  });

  it("lists the verb rows it dropped, by count, with the infinitive it tried and the reason", () => {
    expect(built.droppedVerbs).toEqual([
      { count: 400, stem: "кабул", infinitive: "кабулу", reason: "unattested" },
      { count: 1, stem: "и", infinitive: "ию", reason: "short" },
    ]);
    expect(formatDroppedVerbs(built.droppedVerbs)).toBe("count\tstem\tinfinitive\treason\n400\tкабул\tкабулу\tunattested\n1\tи\tию\tshort\n");
  });

  it("keeps the first `limit` words", () => {
    expect(buildCandidates(lemmas, FORMS, dix, 3).candidates.map((c) => c.word)).toEqual(["ул", "булу", "бару"]);
  });

  it("prints the candidates as a table", () => {
    expect(formatCandidates(built.candidates.slice(0, 3))).toBe(
      "rank\tword\tpos\tcount\tapertium\talso\n1\tул\tpron\t930\tон; тот; сын\tn 30\n2\tбулу\tv\t800\t\t\n3\tбару\tv\t600\tидти; пойти\t\n",
    );
  });
});

describe("rankWords", () => {
  const ranked = rankWords(parseLemmas(LEMMAS), FORMS);

  it("numbers the words of the corpus from the most frequent, the look-alikes of Russian among them", () => {
    expect(ranked.map((w) => [w.rank, w.word, w.pos, w.count])).toEqual([
      [1, "ул", "pron", 930], [2, "булу", "v", 800], [3, "район", "n", 700], [4, "бару", "v", 600], [5, "бар", "adj", 537], [6, "алу", "v", 400], [7, "китап", "n", 300],
      [8, "ни", "pron", 64], [9, "хатын-кыз", "n", 40], [10, "май", "n", 35], [11, "гына", "adv", 20], [12, "һәм", "conj", 10], [13, "аһ", "intj", 5], [14, "белән", "post", 4],
      [15, "бер", "num", 3], [16, "бу", "pron", 2],
    ]);
  });

  it("keeps the order of the candidates: a candidate stands before another in both lists", () => {
    const candidates = buildCandidates(parseLemmas(LEMMAS), FORMS, dix).candidates.map((c) => c.word);
    expect(ranked.map((w) => w.word).filter((word) => candidates.includes(word))).toEqual(candidates);
  });

  it("gives words with one count their places in the order of the lists", () => {
    expect(rankWords(parseLemmas("5\tбу\tdet\n5\tаһ\tij\n9\tбер\tnum\n"), FORMS).map((w) => [w.rank, w.word])).toEqual([[1, "бер"], [2, "бу"], [3, "аһ"]]);
  });
});

const TATOEBA = [
  "1\tМин китап укыйм.\t11\tЯ читаю книгу.",
  "2\tБу китабы бик яхшы.\t12\tЭта его книга очень хорошая.",
  "3\tУл китте.\t13\tОн ушёл.",
  "4\tМин бүген бик зур һәм бик кызык яңа китап сатып алдым.\t14\tЯ сегодня купил очень большую и очень интересную новую книгу.",
  "5\tКитап.\t15\tКнига.",
  "6\tУл миңа ярдәм итте.\t16\tОн мне помог.",
  "7\tУл эшли.\t17\tОн работает.",
  "8\tМин мәктәпкә барам.\t18\tЯ иду в школу.",
  "9\tМәктәптә бар.\t19\tВ школе есть.",
  "10\tКитабым юк.\t20\tУ меня нет книги.",
].join("\n") + "\n";

describe("findExamples", () => {
  const pairs = parseTatoeba(TATOEBA);

  it("reads the sentence pairs", () => {
    expect(pairs).toHaveLength(10);
    expect(pairs[0]).toEqual({ tatId: 1, tat: "Мин китап укыйм.", rusId: 11, rus: "Я читаю книгу." });
  });

  it("finds the sentences with a form of a noun: the word itself first, then from short to long, no longer than 8 words", () => {
    expect(findExamples(pairs, "китап", "n").map((h) => [h.tatId, h.form])).toEqual([[5, "китап"], [1, "китап"], [10, "китабым"], [2, "китабы"]]);
  });

  it("finds the forms of a verb by its stems", () => {
    expect(findExamples(pairs, "бару", "v").map((h) => [h.tatId, h.form])).toEqual([[9, "бар"], [8, "барам"]]);
    expect(findExamples(pairs, "эшләү", "v").map((h) => [h.tatId, h.form])).toEqual([[7, "эшли"]]);
    expect(findExamples(pairs, "ярдәм итү", "v").map((h) => [h.tatId, h.form])).toEqual([[6, "ярдәм итте"]]);
  });

  it("returns both sentences and caps the list", () => {
    expect(findExamples(pairs, "китап", "n", { limit: 1 })).toEqual([{ tatId: 5, tat: "Китап.", rus: "Книга.", form: "китап", unattested: [] }]);
  });

  it("skips the sentences shorter than `minWords`", () => {
    expect(findExamples(pairs, "китап", "n", { minWords: 3 }).map((h) => h.tatId)).toEqual([1, 2]);
  });

  it("names the tokens of a sentence that the corpus does not attest", () => {
    const hits = findExamples(pairs, "китап", "n", { attested: new Set(["мин", "китап"]) });
    expect(hits.map((h) => h.unattested)).toEqual([[], ["укыйм"], ["китабым", "юк"], ["бу", "китабы", "бик", "яхшы"]]);
  });
});

describe("exampleCounter", () => {
  const count = exampleCounter(parseTatoeba(TATOEBA + "1\tМин китап укыйм.\t21\tЯ читаю книги.\n"));

  it("counts the sentences `findExamples` looks through: with a form of the word, no longer than 8 words, each once", () => {
    expect(count("китап", "n")).toBe(4);
    expect(count("бару", "v")).toBe(2);
    expect(count("эшләү", "v")).toBe(1);
    expect(count("ярдәм итү", "v")).toBe(1);
    expect(count("өстәл", "n")).toBe(0);
  });

  it("agrees with findExamples", () => {
    const pairs = parseTatoeba(TATOEBA);
    for (const [word, pos] of [["китап", "n"], ["бару", "v"], ["ул", "pron"], ["бик", "adv"], ["мин", ""]] as const) {
      expect([word, exampleCounter(pairs)(word, pos)]).toEqual([word, findExamples(pairs, word, pos, { limit: 1000 }).length]);
    }
  });

  it("takes another length limit", () => {
    expect(exampleCounter(parseTatoeba(TATOEBA), 20)("китап", "n")).toBe(5);
  });
});

describe("lookupPos", () => {
  const verbs = verbInfinitives(parseLemmas(LEMMAS));

  it("lists the infinitives of the corpus verbs", () => {
    expect([...verbs].sort()).toEqual(["алу", "бару", "булу", "ию", "кабулу"]);
  });

  it("takes a word for a verb when it, or its last word, is the infinitive of a corpus verb", () => {
    expect(lookupPos("бару", verbs)).toBe("v");
    expect(lookupPos(" Сатып алу ", verbs)).toBe("v");
  });

  it("takes any other word as it is, even one that ends in -у", () => {
    expect(lookupPos("бу", verbs)).toBe("");
    expect(lookupPos("китап", verbs)).toBe("");
  });
});

describe("attestedForms", () => {
  it("lists the example tokens the corpus knows, sorted, each once", () => {
    const rows = [{ example_tt: "Мин китап укыйм." }, { example_tt: "Мин Казанда, әти-әни — авылда." }, { example_tt: "" }];
    const forms = new Set(["мин", "китап", "әти", "әни", "авылда", "өстәл"]);
    expect(attestedForms(rows, forms)).toEqual(["авылда", "китап", "мин", "әни", "әти"]);
    expect(attestedForms(rows, new Set([...forms, "әти-әни"]))).toEqual(["авылда", "китап", "мин", "әти-әни"]);
  });
});
