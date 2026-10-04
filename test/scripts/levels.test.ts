import { describe, expect, it } from "vitest";
import { CSV_HEADER, type Row, checkLevels, checkRenames, coverage, coverageDrops, formatLevel, levelFile, levelNumber, levelSlug, parseLevel, renamesOf, tokenize, wordForm } from "../../scripts/lib/levels";
import { transcribe } from "../../src/content/transcribe";

const C1 = "бтдкмнрслч", C2 = "зшрлнмтдкб";
/** 100 distinct made-up nouns per level: `<c1>а<c2>ы<c3>` with the level picking c3. */
const fixtureWord = (level: number, i: number) => `${C1[i % 10]}а${C2[Math.floor(i / 10)]}ы${"мнрлштзд"[level]}`;

function fixtureRow(level: number, i: number): Row {
  const word = fixtureWord(level, i);
  return {
    word, transcription: transcribe(word), pos: "n", translation: `слово ${level * 100 + i}`,
    example_tt: `Бу — ${word}.`, example_ru: "Это слово.", example_src: i % 2 ? "own" : `tatoeba:${1000 + i}`, audio_file_id: "",
  };
}

/** `n` clean levels of 100 rows; row 10 is a verb and row 11 a phrase without an example. */
function fixtureLevels(n = 2): Row[][] {
  return Array.from({ length: n }, (_, level) => Array.from({ length: 100 }, (_, i) => {
    const row = fixtureRow(level, i);
    if (i === 10) return { ...row, word: `${row.word}лау`, transcription: transcribe(`${row.word}лау`), pos: "v", example_tt: `Мин ${row.word}лыйм.` };
    if (i === 11) return { ...row, word: `зур ${row.word}`, transcription: transcribe(`зур ${row.word}`), pos: "phr", example_tt: "", example_ru: "", example_src: "" };
    return row;
  }));
}

const attested = new Set(["бу", "мин", ...fixtureLevels(4).flat().flatMap((r) => tokenize(r.example_tt))]);
const opts = (expectLevels: number) => ({ attested, expectLevels });

describe("level files", () => {
  it("names level files like the deck slugs", () => {
    expect([1, 9, 20].map(levelSlug)).toEqual(["l01", "l09", "l20"]);
    expect(levelFile(1)).toBe("l01.csv");
    for (let n = 1; n <= 20; n++) expect(levelFile(n)).toBe(`${levelSlug(n)}.csv`);
  });

  it("takes only l01.csv … l20.csv for level files", () => {
    expect(["l01.csv", "l09.csv", "l20.csv"].map(levelNumber)).toEqual([1, 9, 20]);
    expect(["l00.csv", "l21.csv", "l99.csv", "l1.csv", "l001.csv", "L01.csv", "l01.csv.bak", "meta.json"].map(levelNumber)).toEqual(Array(8).fill(null));
  });

  it("keeps the agreed column order", () => {
    expect([...CSV_HEADER]).toEqual(["word", "transcription", "pos", "translation", "example_tt", "example_ru", "example_src", "audio_file_id"]);
  });

  it("writes a level as CSV with the header and reads it back", () => {
    const rows = fixtureLevels(1)[0]!.slice(0, 3);
    rows[0]!.translation = "слово, «речь»";
    const csv = formatLevel(rows);
    expect(csv.split("\n")[0]).toBe(CSV_HEADER.join(","));
    expect(parseLevel(csv)).toEqual(rows);
  });
});

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

describe("checkLevels", () => {
  it("reports every violation with level and row", () => {
    const bad = fixtureLevels(); bad[0]![3]!.word = "hава"; bad[1]![0]!.word = bad[0]![0]!.word; bad[0]![5]!.example_tt = "Бу — кыйшыксүз.";
    const errs = checkLevels(bad, { attested, expectLevels: 2 });
    expect(errs).toEqual(expect.arrayContaining([expect.stringMatching(/l01:5 .*букв/), expect.stringMatching(/l02:2 .*дубль/), expect.stringMatching(/l01:7 .*кыйшыксүз/)]));
  });

  it("passes a clean fixture", () => expect(checkLevels(fixtureLevels(), { attested, expectLevels: 2 })).toEqual([]));

  it("wants exactly the expected number of levels, 100 rows each", () => {
    const levels = fixtureLevels(); levels[1]!.pop();
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l02:1 .*99.*100/)]);
    expect(checkLevels(fixtureLevels(), opts(20))).toEqual([expect.stringMatching(/уровней 2.*20/)]);
  });

  it("checks the header of every file", () => {
    const levels = fixtureLevels();
    levels[0] = levels[0]!.map(({ audio_file_id: _, ...rest }) => ({ ...rest, audio: "" }) as unknown as Row);
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l01:1 .*заголовок/)]);
  });

  it("checks the fields of a row", () => {
    const levels = fixtureLevels();
    levels[0]![0]!.pos = "noun";
    levels[0]![1]!.translation = " ";
    levels[0]![2]!.example_tt = ""; levels[0]![2]!.example_ru = ""; levels[0]![2]!.example_src = "";
    levels[0]![4]!.example_src = "tatoeba";
    levels[0]![6]!.transcription = "baзым";
    levels[0]![7]!.example_ru = "";
    levels[0]![8]!.word = "";
    expect(checkLevels(levels, opts(2))).toEqual([
      expect.stringMatching(/^l01:2 .*часть речи.*noun/),
      expect.stringMatching(/^l01:3 .*перевод/),
      expect.stringMatching(/^l01:4 .*пример/),
      expect.stringMatching(/^l01:6 .*example_src.*tatoeba/),
      expect.stringMatching(/^l01:8 .*transcription.*букв.*b/),
      expect.stringMatching(/^l01:9 .*example_ru/),
      expect.stringMatching(/^l01:10 .*слово/),
    ]);
  });

  it("allows w, ʼ and the stress mark in the transcription, and nothing else foreign", () => {
    const levels = fixtureLevels();
    levels[0]![0]!.transcription = "wакъы́т мәсʼәлә";
    expect(checkLevels(levels, opts(2))).toEqual([]);
    levels[0]![0]!.transcription = "vакыт";
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l01:2 .*transcription.*букв.*v/)]);
  });

  it("wants the example to hold a form of the word", () => {
    const levels = fixtureLevels();
    levels[0]![0]!.example_tt = "Бу — мин.";
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l01:2 .*нет формы слова/)]);
  });

  it("takes a hyphenated token whose parts are attested", () => {
    const levels = fixtureLevels();
    const word = levels[0]![0]!.word;
    levels[0]![0]!.example_tt = `Бу-мин — ${word}.`;
    expect(checkLevels(levels, opts(2))).toEqual([]);
    levels[0]![0]!.example_tt = `Бу-юк — ${word}.`;
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l01:2 .*«бу-юк»/)]);
  });

  it("compares example tokens with the attested forms without regard to case", () => {
    const levels = fixtureLevels();
    levels[0]![0]!.example_tt = `МИН — ${levels[0]![0]!.word}.`;
    expect(checkLevels(levels, opts(2))).toEqual([]);
  });

  it("takes a phrase without an example and checks the example of a phrase that has one", () => {
    const levels = fixtureLevels();
    const phrase = levels[0]![11]!;
    const withZur = { ...opts(2), attested: new Set([...attested, ...tokenize(phrase.word)]) };
    Object.assign(phrase, { example_tt: `Бу — ${phrase.word}.`, example_ru: "Это большое слово.", example_src: "own" });
    expect(checkLevels(levels, withZur)).toEqual([]);
    phrase.example_tt = "Бу — зур.";
    expect(checkLevels(levels, withZur)).toEqual([expect.stringMatching(/^l01:13 .*нет формы слова/)]);
    Object.assign(phrase, { example_tt: "", example_ru: "Это большое слово.", example_src: "own" });
    expect(checkLevels(levels, withZur)).toEqual([expect.stringMatching(/^l01:13 .*example_ru.*без примера/)]);
  });

  it("rejects a line break inside a Tatar field", () => {
    const levels = fixtureLevels();
    levels[0]![0]!.example_tt = `Бу —\n${levels[0]![0]!.word}.`;
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l01:2 .*example_tt.*букв/)]);
  });

  it("finds duplicates inside a level by word key", () => {
    const levels = fixtureLevels();
    levels[0]![9]!.word = ` ${levels[0]![0]!.word.toUpperCase()}`;
    levels[0]![9]!.example_tt = levels[0]![0]!.example_tt;
    expect(checkLevels(levels, opts(2))).toEqual([expect.stringMatching(/^l01:11 .*дубль.*l01:2/)]);
  });

  it("wants the core words in levels 1–4 once four levels exist", () => {
    const four = fixtureLevels(4);
    const core = [four[0]![0]!.word, four[3]![99]!.word.toUpperCase(), "әни"];
    expect(checkLevels(four, { ...opts(4), core })).toEqual([expect.stringMatching(/ядр.*әни/)]);
    expect(checkLevels(fixtureLevels(3), { ...opts(3), core })).toEqual([]);
    expect(checkLevels(four, opts(4))).toEqual([]);
  });

  it("wants enough phrases in levels 1–3 once three levels exist", () => {
    expect(checkLevels(fixtureLevels(3), { ...opts(3), minPhrases: 3 })).toEqual([]);
    expect(checkLevels(fixtureLevels(3), { ...opts(3), minPhrases: 55 })).toEqual([expect.stringMatching(/фраз.*3.*55/)]);
    expect(checkLevels(fixtureLevels(2), { ...opts(2), minPhrases: 55 })).toEqual([]);
  });
});

describe("checkRenames: data/renames.csv", () => {
  const levels = fixtureLevels(2);
  const [inLevel1, alsoInLevel1] = [levels[0]![0]!.word, levels[0]![1]!.word];
  const inLevel2 = levels[1]![0]!.word;
  const file = (...lines: string[]) => ["level,old_word,new_word", ...lines].join("\n") + "\n";

  it("passes a file with the header only, and an absent file", () => {
    expect(checkRenames(file(), levels)).toEqual([]);
    expect(checkRenames("", levels)).toEqual([]);
  });

  it("passes a rename whose new word stands in the level and whose old word does not", () => {
    expect(checkRenames(file(`1,батим,${inLevel1}`, `2,"со, су",${inLevel2}`), levels)).toEqual([]);
    expect(renamesOf(file(`1,батим,${inLevel1}`, `2,"со, су",${inLevel2}`), 1)).toEqual([{ oldWord: "батим", newWord: inLevel1 }]);
    expect(renamesOf(file(`1,батим,${inLevel1}`), 2)).toEqual([]);
    expect(renamesOf("", 1)).toEqual([]);
  });

  it("wants the three columns in the header", () => {
    expect(checkRenames("level,old,new\n", levels)).toEqual(["renames.csv:1 заголовок «level,old,new», нужен «level,old_word,new_word»"]);
  });

  it("wants a level that has a file", () => {
    expect(checkRenames(file(`3,батим,${inLevel1}`), levels)).toEqual(["renames.csv:2 уровня «3» нет: есть уровни 1–2"]);
    expect(checkRenames(file(`,батим,${inLevel1}`, `l01,батим,${inLevel1}`, `1.5,батим,${inLevel1}`, `0,батим,${inLevel1}`), levels)).toHaveLength(4);
  });

  it("wants the new word in the file of that level", () => {
    expect(checkRenames(file("1,батим,яңасүз"), levels)).toEqual(["renames.csv:2 нового слова «яңасүз» нет в l01"]);
    // A word of another level is not in this one.
    expect(checkRenames(file(`1,батим,${inLevel2}`), levels)).toEqual([`renames.csv:2 нового слова «${inLevel2}» нет в l01`]);
  });

  it("wants the old word to be gone from the file of that level", () => {
    expect(checkRenames(file(`1,${alsoInLevel1},${inLevel1}`), levels)).toEqual([`renames.csv:2 старое слово «${alsoInLevel1}» всё ещё стоит в l01`]);
    // The same word with other punctuation or case is not a rename: such a fix needs no line here.
    expect(checkRenames(file(`1,${inLevel1.toUpperCase()}!,${inLevel1}`), levels)).toEqual([`renames.csv:2 старое слово «${inLevel1.toUpperCase()}!» всё ещё стоит в l01`]);
  });

  it("wants both words, and each old word once per level", () => {
    expect(checkRenames(file(`1,,${inLevel1}`), levels)).toEqual(["renames.csv:2 пустое old_word"]);
    expect(checkRenames(file("1,батим,"), levels)).toEqual(["renames.csv:2 пустое new_word"]);
    expect(checkRenames(file(`1,батим,${inLevel1}`, `1,Батим,${alsoInLevel1}`), levels)).toEqual(["renames.csv:3 старое слово «Батим» уже переименовано в строке 2"]);
    // The same misspelling in two levels is two renames.
    expect(checkRenames(file(`1,батим,${inLevel1}`, `2,батим,${inLevel2}`), levels)).toEqual([]);
  });
});

describe("checkLevels and meta.json", () => {
  const meta = (...pct: number[]) => pct.map((coveragePct, i) => ({ level: i + 1, coveragePct }));

  it("passes a coverage that grows or stays from level to level", () => {
    expect(checkLevels(fixtureLevels(3), { ...opts(3), meta: meta(30, 41, 41) })).toEqual([]);
    expect(checkLevels(fixtureLevels(3), opts(3))).toEqual([]);
  });

  it("reports a coverage that falls, whatever the order of the entries", () => {
    expect(checkLevels(fixtureLevels(3), { ...opts(3), meta: meta(30, 41, 39).reverse() })).toEqual([expect.stringMatching(/^l03: покрытие 39% .*l02.*41%/)]);
  });

  it("wants a coverage for every level", () => {
    expect(checkLevels(fixtureLevels(3), { ...opts(3), meta: meta(30, 41) })).toEqual([expect.stringMatching(/^l03: .*нет покрытия/)]);
  });

  it("coverageDrops names every fall", () => {
    expect(coverageDrops(meta(30, 28, 35, 34))).toEqual([expect.stringMatching(/^l02: покрытие 28% .*l01.*30%/), expect.stringMatching(/^l04: покрытие 34% .*l03.*35%/)]);
    expect(coverageDrops(meta(30, 30, 31))).toEqual([]);
    expect(coverageDrops([])).toEqual([]);
  });
});

describe("coverage", () => {
  it("computes cumulative coverage with removed cognates", () =>
    expect(coverage([[{ count: 300 }, { count: 200 }], [{ count: 100 }]], [{ count: 250 }, { count: 50 }], 2000)).toEqual([38, 43]));

  it("takes the cognate threshold from the corpus words of the level, not from the core words", () =>
    expect(coverage([[{ count: 300 }, { count: 200, origin: "corpus" }, { count: 0, origin: "core" }]], [{ count: 250 }, { count: 50 }], 2000)).toEqual([38]));

  it("never falls: the cognate threshold is the rarest corpus word of all the levels so far, so a rare word in an early level does not make the next one lose cognates", () => {
    const cognates = [{ count: 250 }, ...Array.from({ length: 8 }, () => ({ count: 15 }))];
    expect(coverage([[{ count: 300 }, { count: 6 }], [{ count: 20 }]], cognates, 1000)).toEqual([68, 70]);
  });

  it("keeps the threshold through a level of core words only", () =>
    expect(coverage([[{ count: 300 }, { count: 200 }], [{ count: 10, origin: "core" }]], [{ count: 250 }, { count: 50 }], 2000)).toEqual([38, 38]));

  it("counts no cognates for a level without corpus words", () =>
    expect(coverage([[{ count: 10, origin: "core" }]], [{ count: 250 }], 1000)).toEqual([1]));
});
