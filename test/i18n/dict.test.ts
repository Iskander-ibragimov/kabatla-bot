import { describe, expect, it } from "vitest";
import { isTatarText } from "../../src/content/tatar";
import { dict } from "../../src/i18n";
import { ru, type Dict } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";

type Key = keyof Dict;
type FnKey = { [K in Key]: Dict[K] extends string ? never : K }[Key];

const POS_CODES = ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"];
const POS_GROUPS = ["n", "v", "adj", "adv", "pron", "num", "func", "phr"];
const MODES = ["guided", "topic", "freq"];

const STATS = { streak: 5, learned: 37, known: 20, learning: 14, fresh: 429, memory: 812, total: 950, r30: 400, retention: "92%", forecast: "3 · 5 · 0 · 12 · 7 · 1 · 4" };

/**
 * Sample arguments for every function key; several tuples where the text has branches.
 * Free-text arguments are Tatar-safe on purpose, so that the letter check looks at the template only.
 */
const SAMPLE_ARGS: { [K in FnKey]: Parameters<Dict[K]>[] } = {
  rung: [[1], [5], [10]],
  reviewNo: [[4]],
  doneToday: [[24, 3]],
  doneNextLearning: [["8 минут"]],
  donePostponed: [[1], [4]],
  streak: [[5]],
  fixLevelBtn: [["A2"], ["C1"]],
  addAll: [[3]],
  foundN: [[3]],
  levelWords: [[1], [2], [5], [11], [21], [22], [112], [400], [850]],
  practiceTitle: [[1], [3]],
  practiceAgain: [["1 минут"]],
  practiceHard: [["5 минут"]],
  practiceGood: [["10 минут", "1 көн, 3 көн, 7 көн"]],
  practiceEasy: [["1 көн", "10 минут"]],
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
  statsText: [[{ ...STATS, levels: "A1, A2", coverage: 54 }], [{ ...STATS, levels: "A1", coverage: null }], [{ ...STATS, levels: "B1, B2, C1", coverage: 61 }]],
  setNew: [[10]],
  setRemind: [["09:00"]],
  setTz: [["UTC+3"], ["UTC+5:30"]],
  setDir: [["tt_ru"], ["ru_tt"], ["both"]],
  setAuto: [[true], [false]],
  pushDaily: [[12, 3]],
  pushEvening: [[5]],
  pushStep: [[4]],
  posName: POS_CODES.map((c): [string] => [c]),
  outOf: [[137, 400], [0, 3]],
  levelStarted: [[137, 400], [0, 3]],
  levelWillBe: [[500]],
  levelCoverage: [[45]],
  modeName: MODES.map((m): [string] => [m]),
  modeAbout: MODES.map((m): [string] => [m]),
  hubTopicNow: [["«Гаилә һәм якыннар»: 12/40"]],
  hubPos: [["исемнәр, фигыльләр"]],
  posGroupName: POS_GROUPS.map((g): [string] => [g]),
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
    const LATIN_OK = /AI|Anki|Tatoeba|CC BY 2\.0 FR|corpus\.tatar|speech\.tatar|UTC|A1|A2|B1|B2|C1/g;
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

  it("names the levels screen and its button, and has no text of the levels by hundreds", () => {
    expect([ru.decksBtn, tt.decksBtn]).toEqual(["📚 Уровни", "📚 Дәрәҗәләр"]);
    expect([ru.levelsTitle, tt.levelsTitle]).toEqual(["📚 <b>Уровни</b>", "📚 <b>Дәрәҗәләр</b>"]);
    for (const d of [ru, tt]) expect(Object.keys(d).filter((k) => /^deck|Decks$/.test(k) && k !== "decksBtn")).toEqual([]);
    const gone = ["levelUp", "levelsDone", "levelsPassed", "levelsSkipped", "levelProgress", "levelsAhead", "openSkippedBtn", "doneTotals", "levelTitle", "levelsCoverage"];
    expect(KEYS.filter((k) => gone.includes(k))).toEqual([]);
    const all = KEYS.flatMap((k) => [...texts(ru, k), ...texts(tt, k)]).join("\n");
    expect(all).not.toMatch(/2 000|20 уровн|20 дәрәҗә/);
  });

  it("the parts of a level line of /levels", () => {
    expect([ru.outOf(137, 400), ru.levelWillBe(500), ru.levelCoverage(45), ru.levelSoon]).toEqual(["137 из 400", "(будет 500)", "≈45 % текста", "скоро"]);
    expect([tt.outOf(137, 400), tt.levelWillBe(500), tt.levelCoverage(45), tt.levelSoon]).toEqual(["137/400", "(500 булачак)", "текстның ≈45 %", "тиздән"]);
    expect([ru.levelStarted(0, 850), tt.levelStarted(0, 850)]).toEqual(["начато 0 из 850", "башланган 0/850"]);
  });

  it("names the three orders of new words and says what each does", () => {
    expect(MODES.map((m) => `${ru.modeName(m)} — ${ru.modeAbout(m)}`)).toEqual([
      "Бот ведёт по темам — темы идут по порядку, основные слова подмешиваются; можно перескочить на другую тему",
      "Сам выбираю тему — слова только из выбранной темы",
      "По частоте — от самых нужных к редким, вперемешку",
    ]);
    expect(MODES.map((m) => tt.modeName(m))).toEqual(["Бот темалар буенча алып бара", "Теманы үзем сайлыйм", "Ешлык буенча"]);
    for (const d of [ru, tt]) {
      expect(d.modeName("zzz")).toBe("zzz");
      expect(d.modeAbout("constructor")).toBe("");
    }
  });

  it("names the groups of parts of speech in the plural", () => {
    expect(POS_GROUPS.map((g) => ru.posGroupName(g))).toEqual(["существительные", "глаголы", "прилагательные", "наречия", "местоимения", "числительные", "служебные слова", "фразы"]);
    expect(POS_GROUPS.map((g) => tt.posGroupName(g))).toEqual(["исемнәр", "фигыльләр", "сыйфатлар", "рәвешләр", "алмашлыклар", "саннар", "ярдәмлек сүзләр", "гыйбарәләр"]);
    for (const d of [ru, tt]) for (const key of ["zzz", "toString", "__proto__"]) expect(d.posGroupName(key)).toBe(key);
  });

  it("the screen about the bot and the step of the levels, word for word in Russian, and the buttons of the introduction", () => {
    expect(ru.intro1).toBe("Кабатла учит татарские слова карточками. Слово возвращается тогда, когда вы начинаете его забывать: сначала через минуты, потом через дни и месяцы. Так оно остаётся в памяти надолго.\n\nСейчас попробуем на трёх словах — это займёт полминуты.");
    expect(ru.obLevels).toBe("Что учить? Отметьте один или несколько уровней. Напоминание — каждый день в 09:00 по Москве, 10 новых слов в день. Всё это меняется в /settings.");
    expect([ru.tryBtn, ru.skipBtn, ru.nextBtn, ru.obGoBtn]).toEqual(["Попробовать", "Пропустить", "Дальше", "Начать"]);
    expect([tt.tryBtn, tt.skipBtn, tt.nextBtn, tt.obGoBtn]).toEqual(["Сынап карау", "Үткәреп җибәрү", "Алга таба", "Башлау"]);
    // The Tatar step names the same defaults and the same command.
    for (const part of ["09:00", "10", "/settings"]) expect(tt.obLevels).toContain(part);
  });

  it("the texts of the three-word practice, word for word: Russian by the practice spec §2, Tatar in the same voice", () => {
    expect([ru.practiceTitle(1), ru.practiceTitle(3), ru.practiceNote, ru.practiceDone]).toEqual([
      "🎓 Тренировка · слово 1 из 3",
      "🎓 Тренировка · слово 3 из 3",
      "Так выглядит карточка. Вспомните перевод, откройте скрытый текст и нажмите одну кнопку — как честно вспомнили.",
      "🎉 Готово! Так и идёт обучение: бот показывает слова по одному, вы честно оцениваете, и каждое слово возвращается тогда, когда его пора повторить — трудные чаще, лёгкие реже.\nВернуться к этой тренировке — /howto.",
    ]);
    // The intervals of a new word, as the card gets them: after «через» in the form that follows it.
    expect([ru.practiceAgain("1 минуту"), ru.practiceHard("5 минут"), ru.practiceGood("10 минут", "1 день, 3 дня, 7 дней"), ru.practiceEasy("1 день", "10 минут")]).toEqual([
      "✅ Вы нажали «Снова» — не вспомнили. Слово вернулось бы через 1 минуту и начало бы лесенку заново.",
      "✅ Вы нажали «Трудно» — вспомнили с трудом. Слово вернулось бы через 5 минут на той же ступеньке.",
      "✅ Вы нажали «Хорошо» — вспомнили. Слово вернулось бы через 10 минут, потом через 1 день, 3 дня, 7 дней — всё реже.",
      "✅ Вы нажали «Легко» — знаете уверенно. Слово вернулось бы не через 10 минут, а сразу через 1 день.",
    ]);
    expect([tt.practiceTitle(2), tt.practiceNote, tt.practiceDone]).toEqual([
      "🎓 Күнегү · сүз 2/3",
      "Карточка шундый күренә. Тәрҗемәсен искә төшерегез, яшерелгән текстны ачыгыз һәм бер генә төймәгә басыгыз — искә төшерүегезне гадел бәяләп.",
      "🎉 Булды! Өйрәнү шулай бара: бот сүзләрне берәм-берәм күрсәтә, сез үзегезгә гадел бәя куясыз, һәм һәр сүз кабатлау вакыты җиткәч кайта — авырлары ешрак, җиңелләре сирәгрәк.\nБу күнегүгә кире кайту — /howto.",
    ]);
    const ttExplained = [tt.practiceAgain("1 минут"), tt.practiceHard("5 минут"), tt.practiceGood("10 минут", "1 көн, 3 көн, 7 көн"), tt.practiceEasy("1 көн", "10 минут")];
    expect(ttExplained).toEqual([
      "✅ Сез «Яңадан» төймәсенә бастыгыз — искә төшермәдегез. Сүз кайтканчы 1 минут узар иде, һәм ул баскычны яңадан башлар иде.",
      "✅ Сез «Авыр» төймәсенә бастыгыз — авырлык белән искә төшердегез. Сүз кайтканчы 5 минут узар иде, ул шул ук баскычта калыр иде.",
      "✅ Сез «Яхшы» төймәсенә бастыгыз — искә төшердегез. Сүз кайтканчы 10 минут узар иде, аннары 1 көн, 3 көн, 7 көн — барган саен сирәгрәк.",
      "✅ Сез «Җиңел» төймәсенә бастыгыз — яхшы беләсез. Сүз кайтканчы 10 минут түгел, ә бер юлы 1 көн узар иде.",
    ]);
    // Each explanation names its button as the button is named, in both languages.
    for (const [d, lead] of [[ru, "✅ Вы нажали «"], [tt, "✅ Сез «"]] as const) {
      const explained = [d.practiceAgain("x"), d.practiceHard("x"), d.practiceGood("x", "y"), d.practiceEasy("x", "g")];
      expect(explained.map((text, i) => text.startsWith(`${lead}${[d.again, d.hard, d.good, d.easy][i]}»`))).toEqual([true, true, true, true]);
      expect(d.practiceDone).toContain("/howto");
    }
    // In Tatar the interval stands before «узар иде» and takes no ending, so it is the same words as on the button; «Җиңел» names that of «Яхшы» before its own.
    expect(ttExplained.map((text, i) => text.includes(`${["кайтканчы 1 минут", "кайтканчы 5 минут", "кайтканчы 10 минут", "кайтканчы 10 минут түгел, ә бер юлы 1 көн"][i]} узар иде`))).toEqual([true, true, true, true]);
  });

  it("the screen about the bot says the practice is three words, in both languages", () => {
    expect(ru.intro1.endsWith("\n\nСейчас попробуем на трёх словах — это займёт полминуты.")).toBe(true);
    expect(tt.intro1.endsWith("\n\nХәзер өч сүздә сынап карыйбыз — ярты минут кына.")).toBe(true);
  });

  it("counts the words of a level: «1 слово», «2 слова», «5 слов»; Tatar has one form", () => {
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 400, 500, 850].map((n) => ru.levelWords(n))).toEqual([
      "1 слово", "2 слова", "4 слова", "5 слов", "11 слов", "12 слов", "14 слов", "21 слово", "22 слова", "25 слов", "101 слово", "111 слов", "112 слов", "400 слов", "500 слов", "850 слов",
    ]);
    expect([1, 2, 5, 400].map((n) => tt.levelWords(n))).toEqual(["1 сүз", "2 сүз", "5 сүз", "400 сүз"]);
  });

  it("the hint of the first card and the update notice, word for word in Russian", () => {
    expect([ru.hintFront, ru.updateNotice]).toEqual([
      "Вспомните перевод, откройте скрытый текст и оцените себя.",
      "Бот обновился: уровни A1–C1, темы и порядок слов — в /levels",
    ]);
    for (const d of [ru, tt]) expect(d.updateNotice).toContain("/levels");
  });

  it("has no text of the introduction that is gone: the test of ten words and the three questions, the second screen, the hints of the four buttons, the settings row that showed it again", () => {
    const gone = [
      "placementQ", "knowBtn", "dontKnowBtn", "goalQ", "goalBtn", "remindQ", "tzQ", "finished", "easyHint",
      "intro2", "gotItBtn", "setTutorial", "hintAgain", "hintHard", "hintGood", "hintEasy", "hintOrder",
      "practiceTask", "practiceLadder", "practiceLeft",
    ];
    expect(KEYS.filter((k) => gone.includes(k))).toEqual([]);
    expect(Object.keys(tt).filter((k) => gone.includes(k))).toEqual([]);
    // None of their words is left in a text either.
    const all = KEYS.flatMap((k) => [...texts(ru, k), ...texts(tt, k)]).join("\n");
    expect(all).not.toMatch(/Показать обучение заново|Өйрәтүне яңадан күрсәтү|Понятно|Аңлашылды|Порядок в занятии|Шөгыльдәге тәртип|„Снова“|„Яңадан“/);
  });

  it("the toasts of the checkboxes", () => {
    expect([ru.needLevel, ru.levelEmpty, ru.needPos]).toEqual(["Нужен хотя бы один уровень", "В этом уровне пока нет слов", "Нужна хотя бы одна часть речи"]);
    expect([tt.needLevel, tt.levelEmpty, tt.needPos]).toEqual(["Кимендә бер дәрәҗә кирәк", "Бу дәрәҗәдә әлегә сүзләр юк", "Кимендә бер сүз төркеме кирәк"]);
    // A toast is at most 200 characters.
    for (const d of [ru, tt]) for (const k of ["needLevel", "levelEmpty", "needPos", "staleButton", "chooseAbove"] as const) expect(d[k].length).toBeLessThanOrEqual(200);
  });

  it("says why no new word came and names the button that mends it", () => {
    expect([ru.emptyNoTopic, ru.emptyTopic, ru.emptyPos, ru.emptyLevels, ru.emptyAllDone]).toEqual([
      "Новых слов по вашим настройкам нет: тема не выбрана.",
      "Новых слов по вашим настройкам нет: тема закончилась.",
      "Новых слов по вашим настройкам нет: в отмеченных частях речи слова кончились.",
      "Новых слов по вашим настройкам нет: отмеченные уровни пройдены.",
      "Все слова каталога в работе 🎉",
    ]);
    expect([ru.fixTopicBtn, ru.fixPosBtn, ru.fixLevelBtn("A2")]).toEqual(["Выбрать тему", "Включить все части речи", "Добавить уровень A2"]);
    expect([tt.fixTopicBtn, tt.fixPosBtn, tt.fixLevelBtn("A2")]).toEqual(["Тема сайлау", "Барлык сүз төркемнәрен кабызу", "A2 дәрәҗәсен өстәү"]);
    expect([tt.emptyNoTopic, tt.emptyTopic]).toEqual(["Көйләүләрегез буенча яңа сүзләр юк: тема сайланмаган.", "Көйләүләрегез буенча яңа сүзләр юк: тема бетте."]);
    expect([ru.learnBtn, tt.learnBtn]).toEqual(["▶ Учить", "▶ Өйрәнү"]);
  });

  it("the empty state points to /levels and to own words, not to adding a deck", () => {
    expect(ru.nothingToLearn).toBe("Пока учить нечего. Отметьте уровень в /levels или напишите боту своё слово.");
    expect(tt.nothingToLearn).toBe("Әлегә өйрәнерлек сүзләр юк. /levels командасы белән дәрәҗә билгеләгез яки ботка үз сүзегезне языгыз.");
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

  it("names the rung of the ladder under a card, and has no text of the memory in days or of the load the old scheduler had", () => {
    expect([1, 5, 10].map((n) => [ru.rung(n), tt.rung(n)])).toEqual([["ступень 1 из 10", "баскыч 1/10"], ["ступень 5 из 10", "баскыч 5/10"], ["ступень 10 из 10", "баскыч 10/10"]]);
    expect(KEYS.filter((k) => ["memory", "setMode"].includes(k))).toEqual([]);
    for (const d of [ru, tt]) for (const k of KEYS) if (typeof d[k] === "string") expect(d[k], k).not.toMatch(/Нагрузка|Йөкләнеш/);
  });

  it("names the language, the time zone and the direction in settings", () => {
    expect([ru.setTz("UTC+3"), tt.setTz("UTC+3")]).toEqual(["🕒 Часовой пояс: UTC+3", "🕒 Сәгать поясы: UTC+3"]);
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
    expect(ru.help).toContain("темы — по спецификациям уровней проекта „Мин татарча беләм!“ (КФУ)");
    expect(tt.help).toContain("темалар — „Мин татарча беләм!“ проекты дәрәҗәләренең спецификацияләре буенча (КФУ)");
    expect(ru.help).toContain("/levels — уровни, темы, порядок слов");
    // «Как это работает» has a line of its own, after the levels, as in the menu.
    expect(ru.help).toContain("/levels — уровни, темы, порядок слов\n/howto — как это работает\n/gen тема");
    expect(tt.help).toContain("/levels — дәрәҗәләр, темалар, сүзләр тәртибе\n/howto — бу ничек эшли\n/gen тема");
  });

  it("describes the bot and its commands in both languages", () => {
    const cmds: Key[] = ["cmdStart", "cmdLearn", "cmdLevels", "cmdHowto", "cmdGen", "cmdStats", "cmdSettings", "cmdUndo", "cmdHelp"];
    // Every command of the dictionary is listed here.
    expect(KEYS.filter((k) => k.startsWith("cmd")).sort()).toEqual([...cmds].sort());
    expect([ru.cmdHowto, tt.cmdHowto]).toEqual(["Как это работает", "Бу ничек эшли"]);
    for (const d of [ru, tt]) {
      for (const k of cmds) expect((d[k] as string).length, k).toBeGreaterThanOrEqual(3);
      for (const k of cmds) expect((d[k] as string).length, k).toBeLessThanOrEqual(256);
      expect(d.botAbout.length).toBeLessThanOrEqual(512);
    }
    expect(ru.botAbout).toContain("татарские слова");
    expect(ru.botAbout).toBe("Учу татарские слова по методу интервальных повторений, как Anki: слова по уровням A1–C1 и темам, свои слова со ссылками, AI-колоды и одно напоминание в день.");
    expect(tt.botAbout).toContain("A1–C1 дәрәҗәләре һәм темалар буенча сүзләр");
  });
});
