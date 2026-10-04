/** Russian UI strings. Functions take already-escaped HTML fragments. */
const POS: Record<string, string> = {
  n: "сущ.", v: "гл.", adj: "прил.", adv: "нареч.", pron: "мест.", num: "числ.",
  post: "послелог", conj: "союз", part: "частица", intj: "межд.", phr: "фраза",
};

/** «слово» in the form that goes with a number: 1 слово, 2 слова, 5 слов, 21 слово, 111 слов. */
const wordsForm = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "слово" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "слова" : "слов");

/** Closing sentence of the level messages; left out while the coverage is unknown. */
const covered = (pct: number | null) => (pct == null ? "" : ` Пройденные слова покрывают ≈${pct}% обычного текста.`);

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
  memory: (d: number) => `память ~${d} дн.`,
  reviewNo: (n: number) => `повтор №${n}`,
  unitMin: "мин",
  unitHour: "ч",
  unitDay: "дн.",
  unitMonth: "мес.",
  decimal: ",",
  doneTitle: "✅ <b>На сейчас всё!</b>",
  doneToday: (reviews: number, learned: number) => `Сегодня: ${reviews} повт. · +${learned} выучено`,
  doneTotals: (l: number, k: number, g: number, n: number) => `Всего: 🏆 ${l} · 🌳 ${k} · 🌿 ${g} · 🌱 ${n}`,
  doneNextLearning: (after: string) => `Карточки на закреплении вернутся через ${after}. Я напомню.`,
  streak: (d: number) => `🔥 Серия: ${d} дн.`,
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
  placementQ: (i: number, word: string) => `Проверим уровень · ${i}/10\n\nЗнаете слово?\n\n<b>${word}</b>`,
  knowBtn: "Знаю",
  dontKnowBtn: "Не знаю",
  goalQ: (level: number) => `Начнём с уровня <b>${level}</b>.\n\nСколько новых слов в день?`,
  goalBtn: (n: number) => (n === 5 ? "5 · легко" : n === 10 ? "10 · норм" : "20 · много"),
  remindQ: "Во сколько присылать напоминание?",
  tzQ: "Сколько у вас сейчас времени? Так я узнаю часовой пояс.\n<i>Если нет вашего варианта, напишите время, например 14:35.</i>",
  finished: (time: string, tz: string) => `Готово! Каждый день в <b>${time}</b> (${tz}) пришлю напоминание, если есть что повторить.`,
  easyHint: "Если слово знаете, жмите „Легко“",
  chooseAbove: "Выберите вариант кнопкой выше ↑",
  alreadySetUp: "Вы уже настроены 🙂 /learn — повторять, /help — все команды.",
  staleButton: "Эта кнопка уже неактуальна",
  nothingToUndo: "Нечего отменять",
  undone: "Оценка отменена",
  /** Shown above the «Уровни» button when the learner has no cards and no open level with words. */
  nothingToLearn: "Пока учить нечего. Откройте уровень в /levels или напишите боту своё слово.",
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
  statsText: (s: { level: number; coverage: number | null; streak: number; learned: number; known: number; learning: number; fresh: number; memory: number; total: number; r30: number; retention: string; forecast: string }) =>
    `📊 <b>Прогресс</b> · за всё время\n\n🎓 ${s.level > 20 ? "Все 20 уровней пройдены" : `Уровень ${s.level}`}${s.coverage == null ? "" : ` · покрытие текста ≈${s.coverage}%`}\n🏆 Выучено: ${s.learned}\n🌳 Знаю: ${s.known}\n🌿 Учу: ${s.learning}\n🌱 Новых впереди: ${s.fresh}\n\n🧠 Сумма памяти: ${s.memory} дн.\n<i>сколько дней в сумме держатся все начатые слова</i>\n🔥 Серия: ${s.streak} дн.\n🔁 Повторов всего: ${s.total} · за 30 дн.: ${s.r30}\n🎯 Удержание за 30 дн.: ${s.retention}\n\n🗓 Прогноз на 7 дней: ${s.forecast}`,
  settingsTitle: "⚙️ <b>Настройки</b>\nНажмите на пункт, чтобы изменить.",
  setLang: "🌐 Язык: Русский",
  setMode: (r: number) => `🎯 Режим: ${r === 0.85 ? "Лёгкий" : r === 0.95 ? "Интенсив" : "Оптимальный"} · ${Math.round(r * 100)}%`,
  setNew: (n: number) => `🆕 Новых в день: ${n}`,
  setRemind: (t: string) => `⏰ Напоминание: ${t}`,
  setDir: (d: string) => `↔️ Направление: ${d === "both" ? "оба" : d === "ru_tt" ? "русский → татарский" : "татарский → русский"}`,
  setAuto: (on: boolean) => `🔊 Автоозвучка: ${on ? "вкл" : "выкл"}`,
  help: "<b>Команды</b>\n/learn — повторять\n/levels — уровни\n/gen тема — AI-колода\n/stats — прогресс\n/settings — настройки\n/undo — отменить оценку\n\nЧтобы добавить своё слово, просто напишите его в чат. Можно списком до 20 строк. Ссылка в том же сообщении прикрепится к карточке.\n\n<i>Источники: частота слов — письменный корпус corpus.tatar; примеры — в том числе из Tatoeba (CC BY 2.0 FR); озвучка — сервис speech.tatar.</i>",
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
  levelTitle: (n: number) => `Уровень ${n}`,
  /** First line of the card that follows the opening of level `to`. `total`: the words of level `from`, null when the catalog has no deck of it. */
  levelUp: (from: number, to: number, pct: number | null, total: number | null) =>
    `${total ? `Все ${total} ${wordsForm(total)} уровня ${from} в работе. ` : ""}Открываю уровень ${to}.${covered(pct)}`,
  /** Said once, when the words of level 20 have all been shown. */
  levelsDone: (pct: number | null) => `Все 2 000 слов в работе! 🎉 Дальше — повторения по расписанию. Свои слова можно добавлять в любой момент.${covered(pct)}`,
  /** Lines and the button of /levels; `list` and `range` are level numbers like "1–3, 5". */
  levelsTitle: "📚 <b>Уровни</b>",
  levelsPassed: (list: string) => `✅ Пройдено: ${list}`,
  /** Levels below the current one that were never opened. */
  levelsSkipped: (list: string) => `⏭ Пропущено: ${list}`,
  levelProgress: (n: number, seen: number, total: number) => `▶️ Уровень ${n} · ${seen} из ${total}`,
  levelsAhead: (n: number) => `🔒 Впереди: ${n}`,
  levelsCoverage: (pct: number) => `📖 Покрытие текста ≈${pct}%`,
  openSkippedBtn: (range: string) => `Открыть пропущенные (${range})`,
  /** Command descriptions and the bot description, registered by scripts/set-webhook.ts. */
  cmdStart: "Начать",
  cmdLearn: "Повторять слова",
  cmdLevels: "Уровни",
  cmdGen: "AI-колода по теме",
  cmdStats: "Прогресс",
  cmdSettings: "Настройки",
  cmdUndo: "Отменить оценку",
  cmdHelp: "Помощь",
  botAbout: "Учу татарские слова по методу интервальных повторений, как Anki: 2 000 самых частых слов в 20 уровнях, свои слова со ссылками, AI-колоды и одно напоминание в день.",
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends (...a: infer A) => string ? (...a: A) => string : string };
export type Dict = Widen<typeof ru>;
