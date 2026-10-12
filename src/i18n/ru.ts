/** Russian UI strings. Functions take already-escaped HTML fragments. */
const POS: Record<string, string> = {
  n: "сущ.", v: "гл.", adj: "прил.", adv: "нареч.", pron: "мест.", num: "числ.",
  post: "послелог", conj: "союз", part: "частица", intj: "межд.", phr: "фраза",
};

/** The eight groups of parts of speech of the settings, by the key of the group (levels/scale.ts), in the plural. */
const POS_GROUPS: Record<string, string> = {
  n: "существительные", v: "глаголы", adj: "прилагательные", adv: "наречия", pron: "местоимения", num: "числительные", func: "служебные слова", phr: "фразы",
};

/** The three orders of new words by their code (levels/scale.ts): the name, and what the order does. */
const MODES: Record<string, [name: string, about: string]> = {
  guided: ["Бот ведёт по темам", "темы идут по порядку, основные слова подмешиваются; можно перескочить на другую тему"],
  topic: ["Сам выбираю тему", "слова только из выбранной темы"],
  freq: ["По частоте", "от самых нужных к редким, вперемешку"],
};
/** A text by its code; an unknown code is shown as is. */
const byCode = <T>(map: Record<string, T>, code: string): T | undefined => (Object.hasOwn(map, code) ? map[code] : undefined);

export const ru = {
  again: "Снова",
  hard: "Трудно",
  good: "Хорошо",
  easy: "Легко",
  speak: "🔊",
  undo: "↩️ Отменить",
  stageNew: "🌱 Новое",
  stageLearning: "🌿 Учу",
  stageKnown: "🌳 Знаю",
  stageLearned: "🏆 Выучено",
  /** The rung of the ladder of intervals a word stands on, 1…10 (srs/ladder.ts). */
  rung: (n: number) => `ступень ${n} из 10`,
  reviewNo: (n: number) => `повтор №${n}`,
  doneTitle: "✅ <b>На сейчас всё!</b>",
  doneToday: (reviews: number, learned: number) => `Сегодня: ${reviews} повт. · +${learned} выучено`,
  /** `after`: when the nearest of them is due, in the form after «через»: «1 минуту», «5 минут», «1 день». */
  doneNextLearning: (after: string) => `Карточки на закреплении вернутся через ${after}. Я напомню.`,
  donePostponed: (n: number) => `Трудные слова отложены на завтра: ${n} — после сна они запоминаются лучше.`,
  streak: (d: number) => `🔥 Серия: ${d} дн.`,
  /** Last line of the done screen when no new word came although the day allows more, and the button under it that mends it. */
  emptyNoTopic: "Новых слов по вашим настройкам нет: тема не выбрана.",
  emptyTopic: "Новых слов по вашим настройкам нет: тема закончилась.",
  emptyPos: "Новых слов по вашим настройкам нет: в отмеченных частях речи слова кончились.",
  emptyLevels: "Новых слов по вашим настройкам нет: отмеченные уровни пройдены.",
  emptyAllDone: "Все слова каталога в работе 🎉",
  fixTopicBtn: "Выбрать тему",
  fixPosBtn: "Включить все части речи",
  /** `code`: the level the button checks, like "A2". */
  fixLevelBtn: (code: string) => `Добавить уровень ${code}`,
  addWords: "➕ Добавить слова",
  decksBtn: "📚 Уровни",
  add: "✅ Добавить",
  addAll: (n: number) => `✅ Добавить все (${n})`,
  edit: "✏️ Изменить",
  cancel: "✖️",
  foundN: (n: number) => `Нашёл ${n}:`,
  /** Last line of a preview that has a card made by the AI. */
  aiNote: "🤖 <i>перевод сделан AI, проверьте</i>",
  welcome: "Привет! Я <b>Кабатла</b> 👋\nПомогу выучить татарские слова методом интервальных повторений, как в Anki.\n\nНа каком языке общаться?",
  /* The introduction: the screen about the bot, the practice card, then the levels to study. /howto shows the first two again. */
  intro1: "Кабатла учит татарские слова карточками. Слово возвращается тогда, когда вы начинаете его забывать: сначала через минуты, потом через дни и месяцы. Так оно остаётся в памяти надолго.",
  /** The button of the screen about the bot: on to the practice card. */
  tryBtn: "Попробовать",
  /*
   * The practice card (tutorial/practice.ts, bot/screens.ts): a card with the word «китап» whose four grade buttons the
   * learner presses to read what each does. `n`: the buttons tried so far, of four.
   */
  practiceTitle: (n: number) => `🎓 Тренировка · ${n} из 4`,
  practiceNote: "Прогресс не считается.",
  practiceTask: "Вспомните перевод, откройте скрытый текст и нажмите по очереди все четыре кнопки — покажу, что делает каждая.",
  /** `rungs`: the intervals of the ten rungs, «1 минута → 10 минут → …». */
  practiceLadder: (rungs: string) => `Лесенка слова: ${rungs}`,
  /*
   * What the pressed button does. `interval`: the one that stands on the button, for a new word; after «через» it is
   * in the form that follows it, «1 минуту». `then`: the intervals of the three rungs above, «1 день, 3 дня, 7 дней».
   */
  practiceAgain: (interval: string) => `✅ «Снова» — не вспомнили. Слово возвращается в начало лесенки: придёт через ${interval} и будет подниматься заново.`,
  practiceHard: (interval: string) => `✅ «Трудно» — вспомнили с трудом. Слово остаётся на своей ступеньке и придёт через тот же срок; у нового слова это ${interval}.`,
  practiceGood: (interval: string, then: string) => `✅ «Хорошо» — вспомнили. Слово поднимается на ступеньку: придёт через ${interval}, потом через ${then} — всё реже.`,
  /** `good`: the interval of «Хорошо» on the same card, which «Легко» is told against; also after «через». */
  practiceEasy: (interval: string, good: string) => `✅ «Легко» — знаете уверенно. Слово перепрыгивает ступеньку: придёт не через ${good}, а через ${interval}.`,
  /** Under the explanation: the buttons not tried yet. */
  practiceLeft: (n: number) => `Осталось кнопок: ${n}`,
  /** After the fourth button. */
  practiceDone: "🎉 Готово, вы попробовали все четыре кнопки.\nОценивайте честно: вспомнили — вверх по лесенке, забыли — с начала. Вернуться к этому обучению — команда /howto.",
  /** The last row of the practice card in the introduction, before all four buttons are tried; after them it is `nextBtn`. */
  skipBtn: "Пропустить",
  nextBtn: "Дальше",
  /** The step «Уровни»; under it a button for every level, with its checkbox, and the button that finishes. It names the defaults of users/service.ts. */
  obLevels: "Что учить? Отметьте один или несколько уровней. Напоминание — каждый день в 09:00 по Москве, 10 новых слов в день. Всё это меняется в /settings.",
  obGoBtn: "Начать",
  /** «400 слов»: the cards a level has, on its button of the step «Уровни». */
  levelWords: (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "слово" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "слова" : "слов"}`,
  /* Hints: the first lines of a card or of the screen that ends a session (tutorial/hints.ts). This one stands on every card until the first grade. */
  hintFront: "Вспомните перевод, откройте скрытый текст и оцените себя.",
  /** Shown once, above a card, to a learner who knew the bot before the levels A1–C1. */
  updateNotice: "Бот обновился: уровни A1–C1, темы и порядок слов — в /levels",
  chooseAbove: "Выберите вариант кнопкой выше ↑",
  alreadySetUp: "Вы уже настроены 🙂 /learn — повторять, /help — все команды.",
  staleButton: "Эта кнопка уже неактуальна",
  nothingToUndo: "Нечего отменять",
  undone: "Оценка отменена",
  /** Shown above the «Уровни» button when the learner has no cards and the checked levels have no word to give. */
  nothingToLearn: "Пока учить нечего. Отметьте уровень в /levels или напишите боту своё слово.",
  learnBtn: "▶ Учить",
  searching: "🔎 Ищу слова…",
  askWords: (host: string) => `🔗 Ссылку ${host} запомнил. Пришлите слова из неё — прикреплю ссылку к каждому.\n<i>Жду 10 минут.</i>`,
  dupLine: (word: string, deck: string, linked: boolean) => `ℹ️ «${word}» уже учите в колоде «${deck}»${linked ? " — прикрепил ссылку 🔗, прогресс сохранён" : ""}.`,
  manualAsk: (word: string) => `🤖 Не получилось перевести «${word}» автоматически. Пришлите перевод сообщением — я создам карточку.`,
  notTranslated: (list: string) => `Не удалось перевести: ${list}. Пришлите их позже или по одному.`,
  /** Answer to a typed line (a word or phrase) or a hand-typed translation that is longer than `max` characters. */
  tooLong: (max: number) => `Слишком длинно: в одной строке может быть до ${max} символов. Пришлите текст короче.`,
  /** Answer to a message with words sent after `max` such messages in one day. */
  addLimit: (max: number) => `Сегодня вы уже прислали ${max} сообщений со словами — это дневной лимит. Завтра можно снова.`,
  added: (words: string) => `✅ Добавлено в «Мои слова»: ${words}`,
  notAdded: "Не добавляю.",
  editAsk: (word: string) => `Пришлите свой перевод для «${word}»`,
  previewExpired: "Это превью устарело — пришлите слова ещё раз.",
  genUsage: "Напишите тему после команды, например:\n<code>/gen в гостях</code>",
  genWorking: (topic: string) => `🤖 Собираю колоду «${topic}»…`,
  genLimit: "Сегодня лимит AI-колод исчерпан (3 из 3). Завтра будет снова.",
  genFailed: "Не получилось собрать колоду — попробуйте позже.",
  genTitle: (topic: string, n: number) => `🤖 <b>Колода «${topic}»</b> · ${n} слов`,
  genLeft: (n: number) => `<i>Осталось генераций сегодня: ${n} из 3</i>`,
  addDeckGenBtn: "✅ Добавить колоду",
  genAdded: (title: string, n: number) => `✅ Колода «${title}» добавлена · ${n} слов`,
  genCancelled: "Генерация отменена.",
  /** `levels`: the codes of the checked levels, like "A1, A2". */
  statsText: (s: { levels: string; coverage: number | null; streak: number; learned: number; known: number; learning: number; fresh: number; memory: number; total: number; r30: number; retention: string; forecast: string }) =>
    `📊 <b>Прогресс</b> · за всё время\n\n🎓 Уровни: ${s.levels}${s.coverage == null ? "" : ` · покрытие текста ≈${s.coverage}%`}\n🏆 Выучено: ${s.learned}\n🌳 Знаю: ${s.known}\n🌿 Учу: ${s.learning}\n🌱 Новых впереди: ${s.fresh}\n\n🧠 Сумма памяти: ${s.memory} дн.\n<i>сколько дней в сумме держатся все начатые слова</i>\n🔥 Серия: ${s.streak} дн.\n🔁 Повторов всего: ${s.total} · за 30 дн.: ${s.r30}\n🎯 Удержание за 30 дн.: ${s.retention}\n\n🗓 Прогноз на 7 дней: ${s.forecast}`,
  settingsTitle: "⚙️ <b>Настройки</b>\nНажмите на пункт, чтобы изменить.",
  setLang: "🌐 Язык: Русский",
  setNew: (n: number) => `🆕 Новых в день: ${n}`,
  setRemind: (t: string) => `⏰ Напоминание: ${t}`,
  /** `tz`: the offset, like "UTC+3". */
  setTz: (tz: string) => `🕒 Часовой пояс: ${tz}`,
  setDir: (d: string) => `↔️ Направление: ${d === "both" ? "оба" : d === "ru_tt" ? "русский → татарский" : "татарский → русский"}`,
  setAuto: (on: boolean) => `🔊 Автоозвучка: ${on ? "вкл" : "выкл"}`,
  /** The row of the settings that opens /levels. */
  setHub: "📚 Уровни, темы, порядок слов",
  /** The screen of the time zones; each button under it is a zone with the time it is there now. */
  tzText: "🕒 <b>Часовой пояс</b>\nВыберите строку с вашим текущим временем.",
  help: "<b>Команды</b>\n/learn — повторять\n/levels — уровни, темы, порядок слов\n/howto — как это работает\n/gen тема — AI-колода\n/stats — прогресс\n/settings — настройки\n/undo — отменить оценку\n\nЧтобы добавить своё слово, просто напишите его в чат. Можно списком до 20 строк. Ссылка в том же сообщении прикрепится к карточке.\n\n<i>Источники: частота слов — письменный корпус corpus.tatar; темы — по спецификациям уровней проекта „Мин татарча беләм!“ (КФУ); примеры — в том числе из Tatoeba (CC BY 2.0 FR); озвучка — сервис speech.tatar.</i>",
  helpAdd: "Напишите слово или фразу в чат, например <code>рәхмәт</code>. Можно несколько строк сразу, а ссылку на источник — в том же сообщении.",
  maintenance: "⏳ Технический перерыв до 03:00 МСК: исчерпан дневной лимит бесплатного сервера. Прогресс сохранён.",
  unknownCommand: "Не знаю такой команды. /help",
  pushDaily: (n: number, mins: number) => `⏰ <b>Пора повторить</b>\n${n} карточек · ~${mins} мин`,
  pushEvening: (streak: number) => `🔥 Серия <b>${streak} дн.</b> под угрозой. Хватит пары минут.`,
  pushStep: (n: number) => `🧠 Карточек на закреплении: ${n} — это 1 минута.`,
  startBtn: "▶ Начать",
  saveStreakBtn: "▶ Спасти серию",
  continueBtn: "▶ Продолжить",
  /** Part of speech by its catalog code; an unknown code is shown as is. */
  posName: (code: string) => Object.hasOwn(POS, code) ? POS[code]! : code,
  reportSent: "Жалоба отправлена, спасибо",
  reportAlready: "Вы уже сообщали об этой карточке",
  /* /levels: the hub and the screens its buttons open. A level is named by its code, A1…C1, in both languages. */
  levelsTitle: "📚 <b>Уровни</b>",
  /** «137 из 400»: the words started of those a level or a topic has. */
  outOf: (n: number, total: number) => `${n} из ${total}`,
  /** On a level line of /levels: «начато 0 из 850» — the words started of those the level has. */
  levelStarted: (n: number, total: number) => `начато ${n} из ${total}`,
  /** After the words of a level that is still being filled: the cards it will hold. */
  levelWillBe: (size: number) => `(будет ${size})`,
  /** The share of an ordinary text that the words up to and including the level cover (shown when levels are chosen at the start). */
  levelCoverage: (pct: number) => `≈${pct} % текста`,
  /** In place of the numbers of a level that has no card yet. */
  levelSoon: "скоро",
  /** The order of new words by its code, and what it does (the line under the name on «Порядок слов»). */
  modeName: (mode: string) => byCode(MODES, mode)?.[0] ?? mode,
  modeAbout: (mode: string) => byCode(MODES, mode)?.[1] ?? "",
  /** After the name of the guided order: the topic it stands in. `topic`: «Семья и близкие»: 12 из 40. */
  hubTopicNow: (topic: string) => `сейчас ${topic}`,
  /** After «Сам выбираю тему» while no topic is chosen. */
  hubNoTopic: "тема не выбрана",
  /** Shown only when not every part of speech is checked. `list`: the names of the checked groups. */
  hubPos: (list: string) => `🧩 Части речи: ${list}`,
  /** A group of parts of speech by its key, in the plural and in lower case; an unknown key is shown as is. */
  posGroupName: (key: string) => byCode(POS_GROUPS, key) ?? key,
  hubLevelsBtn: "Уровни",
  hubPosBtn: "Части речи",
  hubModeBtn: "Порядок слов",
  hubTopicsBtn: "Темы",
  /** The button of every screen opened from the hub: back to the hub. */
  doneBtn: "Готово",
  /** Under the title of the checkboxes of the levels. */
  levelChecksHint: "Новые слова берутся из отмеченных уровней. Начатые слова повторяются в любом случае.",
  posTitle: "🧩 <b>Части речи</b>",
  posChecksHint: "Новые слова берутся только из отмеченных частей речи. Начатые слова повторяются в любом случае.",
  modesTitle: "🧭 <b>Порядок новых слов</b>",
  /** The screen of the topics; each button under it is a topic with the words started of those it has. */
  topicsText: "🗂 <b>Темы</b>\nНажмите на тему — новые слова пойдут из неё. Числа: сколько слов начато из имеющихся.",
  noTopicBtn: "Не выбирать",
  /** Toasts of the checkboxes: the last level, a level without cards, the last part of speech. */
  needLevel: "Нужен хотя бы один уровень",
  levelEmpty: "В этом уровне пока нет слов",
  needPos: "Нужна хотя бы одна часть речи",
  /** Command descriptions and the bot description, registered by scripts/set-webhook.ts. */
  cmdStart: "Начать",
  cmdLearn: "Повторять слова",
  cmdLevels: "Уровни, темы, порядок слов",
  cmdHowto: "Как это работает",
  cmdGen: "AI-колода по теме",
  cmdStats: "Прогресс",
  cmdSettings: "Настройки",
  cmdUndo: "Отменить оценку",
  cmdHelp: "Помощь",
  botAbout: "Учу татарские слова по методу интервальных повторений, как Anki: слова по уровням A1–C1 и темам, свои слова со ссылками, AI-колоды и одно напоминание в день.",
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends (...a: infer A) => string ? (...a: A) => string : string };
export type Dict = Widen<typeof ru>;
