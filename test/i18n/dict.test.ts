import { describe, expect, it } from "vitest";
import { isTatarText } from "../../src/content/tatar";
import { dict } from "../../src/i18n";
import { ru, type Dict } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";

type Key = keyof Dict;
type FnKey = { [K in Key]: Dict[K] extends string ? never : K }[Key];

const POS_CODES = ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"];

const STATS = { streak: 5, learned: 37, known: 20, learning: 14, fresh: 429, memory: 812, total: 950, r30: 400, retention: "92%", forecast: "3 · 5 · 0 · 12 · 7 · 1 · 4" };

/**
 * Sample arguments for every function key; several tuples where the text has branches.
 * Free-text arguments are Tatar-safe on purpose, so that the letter check looks at the template only.
 */
const SAMPLE_ARGS: { [K in FnKey]: Parameters<Dict[K]>[] } = {
  memory: [[2]],
  reviewNo: [[4]],
  doneToday: [[24, 3]],
  doneTotals: [[37, 20, 14, 429]],
  doneNextLearning: [["8 минут"]],
  streak: [[5]],
  addAll: [[3]],
  foundN: [[3]],
  placementQ: [[1, "китап"]],
  goalQ: [[2], [6]],
  goalBtn: [[5], [10], [20]],
  finished: [["09:00", "UTC+3"]],
  askWords: [["мисал.рф"]],
  dupLine: [["китап", "Минем сүзләр", false], ["китап", "Минем сүзләр", true]],
  manualAsk: [["китап"]],
  notTranslated: [["китап, вакыт"]],
  tooLong: [[80], [200]],
  addLimit: [[50]],
  added: [["<b>китап</b>, <b>вакыт</b>"]],
  editAsk: [["китап"]],
  genWorking: [["сәяхәт"]],
  genTitle: [["сәяхәт", 20]],
  genLeft: [[2]],
  genAdded: [["сәяхәт", 20]],
  statsText: [[{ ...STATS, level: 4, coverage: 54 }], [{ ...STATS, level: 1, coverage: null }], [{ ...STATS, level: 6, coverage: 61 }], [{ ...STATS, level: 21, coverage: 80 }]],
  setMode: [[0.85], [0.9], [0.95]],
  setNew: [[10]],
  setRemind: [["09:00"]],
  setDir: [["tt_ru"], ["ru_tt"], ["both"]],
  setAuto: [[true], [false]],
  pushDaily: [[12, 3]],
  pushEvening: [[5]],
  pushStep: [[4]],
  posName: POS_CODES.map((c): [string] => [c]),
  levelTitle: [[1], [6], [20]],
  levelUp: [[3, 4, 54, 100], [5, 6, null, 101], [19, 20, 79, 100], [3, 5, 54, null]],
  levelsDone: [[80], [null]],
  levelsPassed: [["1–3, 5"]],
  levelsSkipped: [["1–3, 5"]],
  levelProgress: [[4, 37, 100], [6, 0, 100]],
  levelsAhead: [[16]],
  levelsCoverage: [[54]],
  openSkippedBtn: [["1–6"]],
};

/** Every text a key can produce: the string itself, or the function applied to each sample. */
function texts(d: Dict, k: Key): string[] {
  const v = d[k];
  if (typeof v === "string") return [v];
  return (SAMPLE_ARGS[k as FnKey] as unknown[][]).map((args) => (v as (...a: unknown[]) => string)(...args));
}
const KEYS = Object.keys(ru) as Key[];

describe("i18n dictionaries", () => {
  it("dict() returns the dictionary of the language", () => {
    expect(dict("ru")).toBe(ru);
    expect(dict("tt")).toBe(tt);
    expect(tt).not.toBe(ru);
  });

  it("has sample arguments for every function key and for nothing else", () => {
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual(KEYS.filter((k) => typeof ru[k] === "function").sort());
  });

  it("has a Tatar text for every key, different from Russian", () => {
    const same = KEYS.filter((k) => {
      const r = texts(ru, k), t = texts(tt, k);
      return r.some((text, i) => text === t[i] && /[а-яё]{3}/i.test(text));
    });
    expect(same).toEqual([]);
  });

  it("writes Tatar texts with Tatar letters only", () => {
    // Names that stay in Latin script. Everything else Latin is a look-alike or a leftover.
    const LATIN_OK = /AI|Anki|Tatoeba|CC BY 2\.0 FR|corpus\.tatar|speech\.tatar|UTC/g;
    // Tags, commands, emoji (with the variation selector) and symbols that isTatarText does not know.
    const NOT_TEXT = /<[^>]+>|\/\w+|\p{Extended_Pictographic}|[️\n·≈%№~+→↑<„“]/gu;
    for (const k of KEYS) {
      for (const text of texts(tt, k)) {
        const letters = text.replace(NOT_TEXT, "").replace(LATIN_OK, "");
        expect(isTatarText(letters), `${k}: ${letters}`).toBe(true);
      }
    }
  });

  it("has the same HTML tags in Russian and Tatar, and balanced", () => {
    const TAG = /<\/?[a-z-]+>/g;
    for (const k of KEYS) {
      const r = texts(ru, k), t = texts(tt, k);
      r.forEach((rt, i) => {
        const rTags = (rt.match(TAG) ?? []).sort(), tTags = (t[i]!.match(TAG) ?? []).sort();
        expect(tTags, `${k}[${i}] tags`).toEqual(rTags);
      });
      for (const text of [...r, ...t]) {
        const open: string[] = [];
        for (const m of text.match(TAG) ?? []) {
          const name = m.replace(/[<>/]/g, "");
          if (m.startsWith("</")) expect(open.pop(), `${k}: ${text}`).toBe(name);
          else open.push(name);
        }
        expect(open, `${k}: ${text}`).toEqual([]);
      }
    }
  });

  it("has the report answers", () => {
    for (const d of [ru, tt]) { expect(d.reportSent.length).toBeGreaterThan(3); expect(d.reportAlready.length).toBeGreaterThan(3); expect(d.reportSent.length).toBeLessThanOrEqual(200); expect(d.reportAlready.length).toBeLessThanOrEqual(200); }
  });

  it("asks for a shorter text and names the limit", () => {
    expect(ru.tooLong(80)).toMatch(/длинн/i);
    expect(ru.tooLong(80)).toContain("80");
    expect(ru.tooLong(200)).toContain("200");
    expect(tt.tooLong(80)).toContain("80");
    expect(tt.tooLong(200)).toContain("200");
    for (const d of [ru, tt]) expect(d.tooLong(200).length).toBeLessThanOrEqual(120);
  });

  it("has the note under an AI-made preview", () => {
    expect(ru.aiNote).toContain("перевод сделан AI, проверьте");
    expect(tt.aiNote).toContain("AI");
    expect(tt.aiNote).not.toBe(ru.aiNote);
  });

  it("keeps the Russian texts free of the English bot", () => {
    const all = KEYS.flatMap((k) => texts(ru, k)).join("\n");
    expect(all).not.toMatch(/англ|English|Hi!|resilient|Повтор<|\bEN\b|\bRU\b|\bTT\b/);
    expect(ru.welcome).toContain("<b>Кабатла</b>");
    expect(ru.welcome).toContain("татарские слова");
    expect(tt.welcome).toContain("<b>Кабатла</b>");
  });

  it("builds Tatar ordinals", () => {
    expect([1, 6, 9, 10, 16, 19, 20].map((n) => tt.levelTitle(n))).toEqual(
      ["1 нче дәрәҗә", "6 нчы дәрәҗә", "9 нчы дәрәҗә", "10 нчы дәрәҗә", "16 нчы дәрәҗә", "19 нчы дәрәҗә", "20 нче дәрәҗә"]);
    expect(ru.levelTitle(3)).toBe("Уровень 3");
  });

  it("announces a new level with the coverage, and the end of the levels once", () => {
    expect(ru.levelUp(3, 4, 54, 100)).toBe("Все 100 слов уровня 3 в работе. Открываю уровень 4. Пройденные слова покрывают ≈54% обычного текста.");
    expect(ru.levelUp(3, 4, null, 100)).toBe("Все 100 слов уровня 3 в работе. Открываю уровень 4.");
    // The number of words is the level's own, with the Russian form of «слово» that goes with it.
    expect([1, 2, 5, 11, 21, 22, 101, 111, 112].map((n) => ru.levelUp(3, 4, null, n).split(" уровня")[0])).toEqual(
      ["Все 1 слово", "Все 2 слова", "Все 5 слов", "Все 11 слов", "Все 21 слово", "Все 22 слова", "Все 101 слово", "Все 111 слов", "Все 112 слов"]);
    expect(tt.levelUp(3, 4, null, 101)).toContain("барлык 101 сүзе дә");
    // Without a deck of the finished level there is no number to name.
    expect(ru.levelUp(3, 5, 54, null)).toBe("Открываю уровень 5. Пройденные слова покрывают ≈54% обычного текста.");
    expect(tt.levelUp(3, 5, null, null)).toBe("5 нче дәрәҗәне ачам.");
    expect(ru.levelsDone(null)).toBe("Все 2 000 слов в работе! 🎉 Дальше — повторения по расписанию. Свои слова можно добавлять в любой момент.");
    expect(ru.levelsDone(80)).toBe(`${ru.levelsDone(null)} Пройденные слова покрывают ≈80% обычного текста.`);
    expect(tt.levelUp(5, 6, 61, 100)).toMatch(/^5 нче дәрәҗә.*6 нчы дәрәҗә.*≈61%/);
    expect(tt.levelUp(5, 6, null, 100)).not.toContain("%");
    expect(tt.levelsDone(80)).toBe(`${tt.levelsDone(null)}${tt.levelUp(5, 6, 80, 100).slice(tt.levelUp(5, 6, null, 100).length)}`);
    expect(tt.levelsDone(80)).toContain("2 000");
  });

  it("names the levels screen and its button", () => {
    expect([ru.decksBtn, tt.decksBtn]).toEqual(["📚 Уровни", "📚 Дәрәҗәләр"]);
    expect([ru.levelsTitle, tt.levelsTitle]).toEqual(["📚 <b>Уровни</b>", "📚 <b>Дәрәҗәләр</b>"]);
    expect(ru.levelProgress(4, 37, 100)).toBe("▶️ Уровень 4 · 37 из 100");
    expect(tt.levelProgress(6, 37, 100)).toBe("▶️ 6 нчы дәрәҗә · 37/100");
    expect(ru.openSkippedBtn("1–6")).toBe("Открыть пропущенные (1–6)");
    for (const d of [ru, tt]) expect(Object.keys(d).filter((k) => /^deck|Decks$/.test(k) && k !== "decksBtn")).toEqual([]);
  });

  it("the empty state points to /levels and to own words, not to adding a deck", () => {
    expect(ru.nothingToLearn).toBe("Пока учить нечего. Откройте уровень в /levels или напишите боту своё слово.");
    expect(tt.nothingToLearn).toBe("Әлегә өйрәнерлек сүзләр юк. /levels командасы белән дәрәҗә ачыгыз яки ботка үз сүзегезне языгыз.");
    for (const d of [ru, tt]) {
      expect(d.nothingToLearn).toContain("/levels");
      expect(d.nothingToLearn).not.toMatch(/колод|тупланма/i);
    }
  });

  it("names parts of speech in the interface language", () => {
    expect(ru.posName("n")).toBe("сущ."); expect(tt.posName("v")).toBe("фигыль"); expect(ru.posName("zzz")).toBe("zzz");
    expect(POS_CODES.map((c) => ru.posName(c))).toEqual(["сущ.", "гл.", "прил.", "нареч.", "мест.", "числ.", "послелог", "союз", "частица", "межд.", "фраза"]);
    expect(POS_CODES.map((c) => tt.posName(c))).toEqual(["исем", "фигыль", "сыйфат", "рәвеш", "алмашлык", "сан", "бәйлек", "теркәгеч", "кисәкчә", "ымлык", "гыйбарә"]);
    expect(tt.posName("zzz")).toBe("zzz");
    for (const d of [ru, tt]) for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(d.posName(code)).toBe(code);
  });

  it("names the language and the direction in settings", () => {
    expect(ru.setLang).toBe("🌐 Язык: Русский");
    expect(tt.setLang).toBe("🌐 Тел: Татарча");
    expect((["tt_ru", "ru_tt", "both"] as const).map((d) => ru.setDir(d))).toEqual(
      ["↔️ Направление: татарский → русский", "↔️ Направление: русский → татарский", "↔️ Направление: оба"]);
    expect((["tt_ru", "ru_tt", "both"] as const).map((d) => tt.setDir(d))).toEqual(
      ["↔️ Юнәлеш: татарча → русча", "↔️ Юнәлеш: русча → татарча", "↔️ Юнәлеш: икесе дә"]);
  });

  it("help names the sources and the add hint shows a Tatar word", () => {
    for (const d of [ru, tt]) {
      expect(d.help).toContain("corpus.tatar");
      expect(d.help).toContain("Tatoeba (CC BY 2.0 FR)");
      expect(d.helpAdd).toContain("<code>рәхмәт</code>");
    }
    expect(ru.help).toContain("озвучка");
  });

  it("describes the bot and its commands in both languages", () => {
    const cmds: Key[] = ["cmdStart", "cmdLearn", "cmdLevels", "cmdGen", "cmdStats", "cmdSettings", "cmdUndo", "cmdHelp"];
    for (const d of [ru, tt]) {
      for (const k of cmds) expect((d[k] as string).length, k).toBeGreaterThanOrEqual(3);
      for (const k of cmds) expect((d[k] as string).length, k).toBeLessThanOrEqual(256);
      expect(d.botAbout.length).toBeLessThanOrEqual(512);
    }
    expect(ru.botAbout).toContain("татарские слова");
  });
});
