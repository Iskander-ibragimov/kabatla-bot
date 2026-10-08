import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { commands } from "../../scripts/lib/commands";
import { renderAbout, renderOnboarding, renderPractice } from "../../src/bot/screens";
import { renderLead } from "../../src/bot/views";
import { Repo, type User } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { formatInterval } from "../../src/srs/interval";
import { HINT } from "../../src/tutorial/hints";
import { nextOccurrence, startOnboarding } from "../../src/users/service";
import { harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { recountProgress, seedCatalog, seedGuidedOrder, seedLearner, seedTopics } from "../helpers/seed";

/** 06:00 UTC: 09:00 in Moscow. */
const T = Date.UTC(2026, 8, 30, 6);
type Markup = { inline_keyboard?: { text: string; callback_data: string; style?: string }[][] };
const buttons = (m: Markup) => (m.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);

/**
 * The bot over a database that counts its calls, for the user with the Telegram id 42. `text` and `press` run one
 * update and give its Telegram calls, the number of its D1 calls and the text of its toast; every update is held to
 * the budget: 8 D1 calls, 3 Telegram calls. A press goes to the message the bot sent last unless another is named.
 */
function bot() {
  const db = countingDb(env.DB);
  const h = harness(db, { now: T });
  const update = async (run: () => Promise<unknown>) => {
    const before = h.tg.calls.length;
    db.calls = 0;
    await run();
    const calls = h.tg.calls.slice(before);
    expect(db.calls, "D1 calls").toBeLessThanOrEqual(8);
    expect(calls.length, calls.map((c) => c.method).join(",")).toBeLessThanOrEqual(3);
    return { calls, methods: calls.map((c) => c.method), d1: db.calls, toast: calls.find((c) => c.method === "answerCallbackQuery")?.payload.text };
  };
  const press = (data: string, messageId = h.tg.lastMessageId()) => update(() => h.press(data, messageId));
  /**
   * Presses the grade button `rating` of the card on screen. Besides the update it gives `shown`, the interval the
   * button showed («Хорошо · 10 минут»: «10 минут»), and `given`, the interval the grade gave the card, written the
   * same way. The ladder moves no interval, so they are the same.
   */
  const grade = async (rating: 1 | 2 | 3 | 4) => {
    const button = (h.lastMarkup().inline_keyboard ?? []).flat().find((b) => new RegExp(`^g:\\d+:\\d+:${rating}$`).test(b.callback_data))!;
    const u = await press(button.callback_data);
    const card = (await env.DB.prepare("SELECT c.due, u.lang FROM cards c JOIN users u ON u.id = c.user_id WHERE c.id = ?").bind(Number(button.callback_data.split(":")[1])).first<{ due: number; lang: "ru" | "tt" }>())!;
    return { ...u, shown: button.text.split(" · ")[1]!, given: formatInterval(card.due - T, card.lang) };
  };
  const user = async () => (await new Repo(env.DB).getUserByTg(42))!;
  return { h, text: (s: string) => update(() => h.text(s)), press, grade, user };
}
type Update = Awaited<ReturnType<ReturnType<typeof bot>["press"]>>;
/** The update changed the message in place and answered the tap: nothing was sent. */
const edited = (u: Pick<Update, "calls" | "methods">, messageId = 100) => {
  expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
  expect(u.calls[0]!.payload.message_id).toBe(messageId);
};
/** Everything the bot holds of learners, row by row. An update that writes nothing leaves it as it was. */
const held = async () => Object.fromEntries(await Promise.all(
  ["users", "cards", "review_log", "sessions", "user_progress", "previews", "usage_daily"].map(async (table) => [table, (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results]),
));

/**
 * A1 covers 45% of a text and has five words: «мин», «син» of «Основа», then the greetings «сәлам», «рәхмәт»,
 * «исәнмесез». A2 has one word, «сәяхәт»; B1, B2 and C1 have none. In the guided order a greeting comes first, then a
 * basic word, in turn: сәлам, мин, рәхмәт, син, исәнмесез.
 */
async function catalog(db: D1Database) {
  await seedTopics(db);
  await seedCatalog(db, [
    { level: 1, word: "мин", topic: 0 }, { level: 1, word: "син", topic: 0 },
    { level: 1, word: "сәлам", topic: 1 }, { level: 1, word: "рәхмәт", topic: 1 }, { level: 1, word: "исәнмесез", topic: 1 },
    { level: 2, word: "сәяхәт", topic: 15 },
  ]);
  await seedGuidedOrder(db);
  await db.prepare("UPDATE decks SET coverage_pct = 45 WHERE level_no = 1").run();
}
const LEVELS_RU = (a1: boolean, a2: boolean) => [
  [`${a1 ? "☑" : "☐"} A1 · 5 слов · ≈45 % текста`, "ob:lv:1"], [`${a2 ? "☑" : "☐"} A2 · 1 слово`, "ob:lv:2"],
  ["☐ B1 · скоро", "ob:lv:3"], ["☐ B2 · скоро", "ob:lv:4"], ["☐ C1 · скоро", "ob:lv:5"], ["Начать", "ob:go"],
];
const COUNTERS = "🔵 10 · 🔴 0 · 🟢 0";

/* The practice card, word for word (spec §4.2 in Russian, §6 in Tatar). */
const ABOUT_RU = "Кабатла учит татарские слова карточками. Слово возвращается тогда, когда вы начинаете его забывать: сначала через минуты, потом через дни и месяцы. Так оно остаётся в памяти надолго.";
/** The word and its translation, hidden the way a real card hides it. */
const WORD = "<b>китап</b>\n<tg-spoiler><b>книга</b></tg-spoiler>";
const TASK_RU = "Вспомните перевод, откройте скрытый текст и нажмите по очереди все четыре кнопки — покажу, что делает каждая.";
const LADDER_RU = "Лесенка слова: 1 минута → 10 минут → 1 день → 3 дня → 7 дней → 14 дней → 1 месяц → 2 месяца → 4 месяца → 6 месяцев";
const EXPLAINED_RU: Record<number, string> = {
  1: "✅ «Снова» — не вспомнили. Слово возвращается в начало лесенки: придёт через 1 минуту и будет подниматься заново.",
  2: "✅ «Трудно» — вспомнили с трудом. Слово остаётся на своей ступеньке и придёт через тот же срок; у нового слова это 5 минут.",
  3: "✅ «Хорошо» — вспомнили. Слово поднимается на ступеньку: придёт через 10 минут, потом через 1 день, 3 дня, 7 дней — всё реже.",
  4: "✅ «Легко» — знаете уверенно. Слово перепрыгивает ступеньку: придёт сразу через 1 день.",
};
const DONE_RU = "🎉 Готово, вы попробовали все четыре кнопки.\nОценивайте честно: вспомнили — вверх по лесенке, забыли — с начала. Вернуться к этому обучению — команда /howto.";
const LABELS_RU = ["Снова · 1 минута", "Трудно · 5 минут", "Хорошо · 10 минут", "Легко · 1 день"];
/** The card with `n` buttons tried; `last` is the button pressed last, whose explanation stands above the word. */
const CARD_RU = (n: number, last?: number) => [
  `🎓 Тренировка · ${n} из 4`, "Прогресс не считается.", "", ...(last ? [EXPLAINED_RU[last]!, `Осталось кнопок: ${4 - n}`, ""] : []), WORD, "", TASK_RU, "", LADDER_RU,
].join("\n");
/** The screen after the fourth button: what it did, and the end of the practice. */
const FINAL_RU = (last: number) => `${EXPLAINED_RU[last]}\n\n${DONE_RU}`;

const ABOUT_TT = "Кабатла татар сүзләрен карточкалар ярдәмендә өйрәтә. Сүз сез аны оныта башлаган вакытта кире кайта: башта берничә минуттан, аннары көннәр һәм айлар узгач. Шулай ул хәтердә озакка кала.";
const TASK_TT = "Тәрҗемәсен искә төшерегез, яшерелгән текстны ачыгыз һәм дүрт төймәнең һәрберсенә чиратлап басыгыз — һәрберсенең нәрсә эшләгәнен күрсәтермен.";
const LADDER_TT = "Сүз баскычы: 1 минут → 10 минут → 1 көн → 3 көн → 7 көн → 14 көн → 1 ай → 2 ай → 4 ай → 6 ай";
const EXPLAINED_TT: Record<number, string> = {
  1: "✅ «Яңадан» — искә төшермәдегез. Сүз баскычның башына кайта: кайтканчы 1 минут бар, аннары яңадан күтәрелә.",
  2: "✅ «Авыр» — авырлык белән искә төшердегез. Сүз үз баскычында кала һәм шул ук вакыттан соң кайта; яңа сүз өчен кайтканчы 5 минут бар.",
  3: "✅ «Яхшы» — искә төшердегез. Сүз бер баскычка күтәрелә: кайтканчы 10 минут бар, аннары 1 көн, 3 көн, 7 көн — сирәгрәк.",
  4: "✅ «Җиңел» — яхшы беләсез. Сүз бер баскыч аша сикерә: кайтканчы 1 көн бар.",
};
const DONE_TT = "🎉 Булды, дүрт төймәне дә сынап карадыгыз.\nҮзегезгә гадел бәя куегыз: искә төшерсәгез — баскыч буйлап өскә, онытсагыз — башыннан. Бу өйрәтүгә кире кайту — /howto.";
const LABELS_TT = ["Яңадан · 1 минут", "Авыр · 5 минут", "Яхшы · 10 минут", "Җиңел · 1 көн"];
const CARD_TT = (n: number, last?: number) => [
  `🎓 Күнегү · ${n}/4`, "Алгарыш саналмый.", "", ...(last ? [EXPLAINED_TT[last]!, `Калган төймәләр: ${4 - n}.`, ""] : []), WORD, "", TASK_TT, "", LADDER_TT,
].join("\n");

/** The buttons of the card on which the buttons of `mask` are tried: the four grades, the tried ones marked, then `last`. */
const keys = (labels: string[], mask: number, ...last: string[][]) => [...labels.map((label, i) => [mask & (1 << i) ? `✅ ${label}` : label, `pr:${mask}:${i + 1}`]), ...last];
const SKIP_RU = ["Пропустить", "ob:n2"], NEXT_RU = ["Дальше", "ob:n2"], LEARN_RU = ["▶ Учить", "learn"];
const ORDERS = [1, 2, 3, 4].flatMap((a) => [1, 2, 3, 4].flatMap((b) => [1, 2, 3, 4].flatMap((c) => [1, 2, 3, 4].map((d) => [a, b, c, d])))).filter((o) => new Set(o).size === 4);

/** Goes through the introduction in Russian up to the first card, with the levels as they are checked at first: A1. The practice is skipped. */
async function introduced(b: ReturnType<typeof bot>) {
  await b.text("/start");
  for (const answer of ["ob:ru", "ob:n1", "ob:n2", "ob:go"]) await b.press(answer, 100);
}
/** Goes through the introduction up to the practice card, in the message 100. */
async function atPractice(b: ReturnType<typeof bot>, lang: "ru" | "tt" = "ru") {
  await b.text("/start");
  for (const answer of [`ob:${lang}`, "ob:n1"]) await b.press(answer, 100);
}

describe("the introduction", () => {
  it("/start → the language → the screen about the bot → the practice card → the four buttons → «Дальше» → the levels → «Начать»: the first real card, with the intervals the practice showed", async () => {
    await catalog(env.DB);
    const b = bot();
    const start = await b.text("/start");
    expect(start.methods).toEqual(["sendMessage"]);
    expect(b.h.lastText()).toBe(ru.welcome);
    expect(buttons(b.h.lastMarkup())).toEqual([["Русский", "ob:ru"], ["Татарча", "ob:tt"]]);

    const lang = await b.press("ob:ru");
    edited(lang);
    expect(b.h.lastText()).toBe(ABOUT_RU);
    expect(buttons(b.h.lastMarkup())).toEqual([["Попробовать", "ob:n1"]]);
    expect(await b.user()).toMatchObject({ lang: "ru", onboardingStep: "intro1" });

    const tryIt = await b.press("ob:n1");
    edited(tryIt);
    expect(b.h.lastText()).toBe(CARD_RU(0));
    expect(b.h.lastText()).toContain("Тренировка · 0 из 4");
    expect(b.h.lastText()).toContain("<tg-spoiler><b>книга</b></tg-spoiler>");
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, 0, SKIP_RU));
    // The buttons stand as on a real card, two in a row, and the way out is a row of its own.
    expect((b.h.lastMarkup().inline_keyboard ?? []).map((row) => row.length)).toEqual([2, 2, 1]);
    expect(tryIt.calls[0]!.payload).toMatchObject({ parse_mode: "HTML" });
    expect((await b.user()).onboardingStep).toBe("practice");
    const practiced = (b.h.lastMarkup() as Markup).inline_keyboard!.flat().slice(0, 4);

    const row = await b.user();
    const presses: Update[] = [];
    let mask = 0;
    for (const rating of [3, 1, 4, 2]) {
      const u = await b.press(`pr:${mask}:${rating}`);
      edited(u);
      presses.push(u);
      mask |= 1 << (rating - 1);
      if (mask !== 15) {
        expect(b.h.lastText()).toBe(CARD_RU(presses.length, rating));
        expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, mask, SKIP_RU));
      }
    }
    // After the fourth button: what it did, and the end of the practice, with one way on.
    expect(b.h.lastText()).toBe(FINAL_RU(2));
    expect(buttons(b.h.lastMarkup())).toEqual([NEXT_RU]);
    // The practice wrote nothing: the learner stands where «Попробовать» left them.
    expect(await b.user()).toEqual(row);

    const next = await b.press("ob:n2");
    edited(next);
    expect(b.h.lastText()).toBe("Что учить? Отметьте один или несколько уровней. Напоминание — каждый день в 09:00 по Москве, 10 новых слов в день. Всё это меняется в /settings.");
    expect(buttons(b.h.lastMarkup())).toEqual(LEVELS_RU(true, false));
    expect((b.h.lastMarkup().inline_keyboard ?? []).every((row) => row.length === 1)).toBe(true);
    expect(await b.user()).toMatchObject({ onboardingStep: "levels", levels: 0b1 });

    const go = await b.press("ob:go");
    // The buttons leave the message of the introduction; the card is a message of its own; nothing says «Готово».
    expect(go.methods).toEqual(["editMessageReplyMarkup", "sendMessage", "answerCallbackQuery"]);
    expect(go.calls[0]!.payload).toMatchObject({ message_id: 100 });
    expect(go.calls[0]!.payload.reply_markup).toBeUndefined();
    // A card is sent as HTML and never grows a link preview, whatever its source link.
    expect(go.calls[1]!.payload).toMatchObject({ parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(go.toast).toBeUndefined();
    expect(b.h.lastText().startsWith(`Вспомните перевод, откройте скрытый текст и оцените себя.\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    const real = (b.h.lastMarkup() as Markup).inline_keyboard!.flat().slice(0, 4);
    expect(real.map((x) => x.callback_data)).toEqual([expect.stringMatching(/^g:\d+:0:1$/), expect.stringMatching(/:2$/), expect.stringMatching(/:3$/), expect.stringMatching(/:4$/)]);
    // The first real card reads what the practice card read, button for button, in the same colours.
    expect(real.map((x) => x.text)).toEqual(LABELS_RU);
    expect(real.map((x) => [x.text, x.style])).toEqual(practiced.map((x) => [x.text, x.style]));
    expect(await b.user()).toMatchObject({
      onboardingStep: null, hintsSeen: HINT.update, levels: 0b1, posGroups: 255, newMode: "guided", topicNo: null, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180,
      nextDailyAt: nextOccurrence(180, "09:00", T), nextEveningAt: nextOccurrence(180, "20:00", T),
    });
    // D1 calls: the user; the step, and for «Уровни» the counters of the levels; a practice press reads the user and
    // nothing else; the finish is the user, the guarded write, the user again, the queue, its read positions, the new
    // card and the session.
    expect([start.d1, lang.d1, tryIt.d1, ...presses.map((p) => p.d1), next.d1, go.d1]).toEqual([3, 2, 2, 1, 1, 1, 1, 3, 7]);
  });

  it("the levels are checked and unchecked on the step «Уровни», by the rules of the settings, and the first card is of the levels checked", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    for (const answer of ["ob:ru", "ob:n1", "ob:n2"]) await b.press(answer);

    const add = await b.press("ob:lv:2");
    edited(add);
    expect(add.d1).toBe(4);
    expect(b.h.lastText()).toBe(ru.obLevels);
    expect(buttons(b.h.lastMarkup())).toEqual(LEVELS_RU(true, true));
    expect((await b.user()).levels).toBe(0b11);
    const before = await b.user();
    for (const empty of ["ob:lv:3", "ob:lv:4", "ob:lv:5"]) {
      const soon = await b.press(empty, 100);
      expect(soon.calls.map((c) => [c.method, c.payload.text]), empty).toEqual([["answerCallbackQuery", "В этом уровне пока нет слов"]]);
    }
    expect(await b.user()).toEqual(before);
    edited(await b.press("ob:lv:1"));
    expect(buttons(b.h.lastMarkup())).toEqual(LEVELS_RU(false, true));
    const last = await b.press("ob:lv:2");
    expect(last.calls.map((c) => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", "Нужен хотя бы один уровень"]]);
    expect(last.d1).toBe(2);
    expect(await b.user()).toMatchObject({ onboardingStep: "levels", levels: 0b10 });

    await b.press("ob:go");
    expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәяхәт</b>\n`)).toBe(true);
    expect(await b.user()).toMatchObject({ onboardingStep: null, levels: 0b10 });
  });

  it("is in Tatar for a learner who chose it: the screen about the bot, the practice card, the levels and the hint of the first card", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    edited(await b.press("ob:tt"));
    expect(b.h.lastText()).toBe(ABOUT_TT);
    expect(buttons(b.h.lastMarkup())).toEqual([["Сынап карау", "ob:n1"]]);
    edited(await b.press("ob:n1"));
    // The Tatar interface shows the same card: the Tatar word, the Russian translation under the spoiler.
    expect(b.h.lastText()).toBe(CARD_TT(0));
    expect(b.h.lastText()).toContain("Күнегү · 0/4");
    expect(b.h.lastText()).toContain("<tg-spoiler><b>книга</b></tg-spoiler>");
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_TT, 0, ["Үткәреп җибәрү", "ob:n2"]));

    const before = await held();
    const good = await b.press("pr:0:3");
    edited(good);
    expect(good.d1).toBe(1);
    expect(await held()).toEqual(before);
    expect(b.h.lastText()).toBe(CARD_TT(1, 3));
    for (const part of ["Күнегү · 1/4", "кайтканчы 10 минут бар, аннары 1 көн, 3 көн, 7 көн — сирәгрәк.", "Калган төймәләр: 3."]) expect(b.h.lastText()).toContain(part);
    expect(buttons(b.h.lastMarkup())[2]).toEqual(["✅ Яхшы · 10 минут", "pr:4:3"]);

    // In Tatar the interval stands before «бар» and takes no ending: the minute of «Яңадан» is the word of its button.
    edited(await b.press("pr:4:1"));
    expect(b.h.lastText()).toBe(CARD_TT(2, 1));
    expect(b.h.lastText()).toContain("кайтканчы 1 минут бар");
    edited(await b.press("pr:5:2"));
    expect(b.h.lastText()).toBe(CARD_TT(3, 2));
    edited(await b.press("pr:7:4"));
    expect(b.h.lastText()).toBe(`${EXPLAINED_TT[4]}\n\n${DONE_TT}`);
    expect(buttons(b.h.lastMarkup())).toEqual([["Алга таба", "ob:n2"]]);
    expect(await held()).toEqual(before);

    await b.press("ob:n2");
    expect(b.h.lastText()).toBe(tt.obLevels);
    expect(buttons(b.h.lastMarkup())).toEqual([
      ["☑ A1 · 5 сүз · текстның ≈45 %", "ob:lv:1"], ["☐ A2 · 1 сүз", "ob:lv:2"], ["☐ B1 · тиздән", "ob:lv:3"], ["☐ B2 · тиздән", "ob:lv:4"], ["☐ C1 · тиздән", "ob:lv:5"], ["Башлау", "ob:go"],
    ]);
    await b.press("ob:go");
    expect(b.h.lastText().startsWith(`${tt.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    expect(buttons(b.h.lastMarkup()).slice(0, 4).map(([text]) => text)).toEqual(LABELS_TT);
    // A grade says nothing about its button: the next card starts with its counters.
    const graded = await b.grade(3);
    expect(b.h.lastText().startsWith("🔵 9 · 🔴 1 · 🟢 0\n<b>мин</b>\n")).toBe(true);
    expect([graded.shown, graded.given]).toEqual(["10 минут", "10 минут"]);
  });

  it("a second tap on «Попробовать» does not skip the practice: the card stays, and the tap is answered like any answer the step does not take", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    await b.press("ob:ru");
    edited(await b.press("ob:n1"));
    expect(b.h.lastText()).toBe(CARD_RU(0));
    const late = await b.press("ob:n1");
    edited(late);
    expect(late.calls[0]!.payload).toMatchObject({ text: CARD_RU(0), reply_markup: { inline_keyboard: [[{ callback_data: "pr:0:1" }, { callback_data: "pr:0:2" }], [{ callback_data: "pr:0:3" }, { callback_data: "pr:0:4" }], [{ text: "Пропустить", callback_data: "ob:n2" }]] } });
    expect(late.toast).toBe(ru.chooseAbove);
    expect((await b.user()).onboardingStep).toBe("practice");
    // Two taps that arrive together both show the practice card.
    await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: "intro1" });
    const before = b.h.tg.calls.length;
    await Promise.all([b.h.press("ob:n1", 100), b.h.press("ob:n1", 100)]);
    expect(b.h.tg.calls.slice(before).filter((c) => c.method === "editMessageText").map((c) => c.payload.text)).toEqual([CARD_RU(0), CARD_RU(0)]);
    expect((await b.user()).onboardingStep).toBe("practice");
    edited(await b.press("ob:n2"));
    expect(b.h.lastText()).toBe(ru.obLevels);
  });

  it("/start on a step sends the screen of that step again", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    const again = async () => { const u = await b.text("/start"); expect(u.methods).toEqual(["sendMessage"]); return [b.h.lastText(), buttons(b.h.lastMarkup())]; };
    expect(await again()).toEqual([ru.welcome, [["Русский", "ob:ru"], ["Татарча", "ob:tt"]]]);
    await b.press("ob:ru");
    expect(await again()).toEqual([ABOUT_RU, [["Попробовать", "ob:n1"]]]);
    await b.press("ob:n1", 100);
    expect(await again()).toEqual([CARD_RU(0), keys(LABELS_RU, 0, SKIP_RU)]);
    // The buttons tried live in the message: a card sent again starts with none.
    await b.press("pr:0:3", 100);
    expect(await again()).toEqual([CARD_RU(0), keys(LABELS_RU, 0, SKIP_RU)]);
    await b.press("ob:n2", 100);
    expect(await again()).toEqual([ru.obLevels, LEVELS_RU(true, false)]);
    await b.press("ob:go");
    await b.text("/start");
    expect(b.h.lastText()).toBe(ru.alreadySetUp);
  });

  it("two «Начать» at once finish once: one card, and the other tap is answered as a stale button", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    for (const answer of ["ob:ru", "ob:n1", "ob:n2"]) await b.press(answer);
    const before = b.h.tg.calls.length;
    await Promise.all([b.h.press("ob:go", 100), b.h.press("ob:go", 100)]);
    const calls = b.h.tg.calls.slice(before);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text).sort()).toEqual([ru.staleButton, undefined].sort());
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first<{ n: number }>())!.n).toBe(1);
  });

  it("with an empty catalog the levels are all «скоро», and «Начать» ends on the screen that says there is nothing to learn yet", async () => {
    const b = bot();
    await b.text("/start");
    for (const answer of ["ob:ru", "ob:n1", "ob:n2"]) await b.press(answer, 100);
    expect(buttons(b.h.lastMarkup()).map(([text]) => text)).toEqual(["☑ A1 · скоро", "☐ A2 · скоро", "☐ B1 · скоро", "☐ B2 · скоро", "☐ C1 · скоро", "Начать"]);
    const go = await b.press("ob:go", 100);
    expect(go.methods).toEqual(["editMessageReplyMarkup", "answerCallbackQuery", "sendMessage"]);
    expect(b.h.lastText()).toBe(ru.nothingToLearn);
    expect((await b.user()).onboardingStep).toBeNull();
  });

  describe("answers the introduction does not take", () => {
    /** The buttons of the introduction that is gone: «Знаю», «Не знаю», the words a day, the hour, the time zone. */
    const OLD = ["ob:1", "ob:0", "ob:10", "ob:09:00", "ob:180"];

    it("an old button pressed on a step after the language is answered with «Выберите вариант кнопкой выше», its message becomes the screen of the step, and nothing is written", async () => {
      await catalog(env.DB);
      const b = bot();
      await b.text("/start");
      const repo = new Repo(env.DB);
      // The language step answers with its own screen as a new message: «a learner who has not chosen a language yet» below.
      const steps: [answer: string, foreign: string[]][] = [["ob:ru", ["ob:ru", "ob:n2", "ob:next", "ob:go", "ob:lv:1"]], ["ob:n1", ["ob:tt", "ob:n1", "ob:next", "ob:go"]], ["ob:n2", ["ob:ru", "ob:n1", "ob:n2", "ob:next", "ob:lv:9"]]];
      for (const [answer, foreign] of steps) {
        await b.press(answer, 100);
        const user = await b.user();
        const screen = renderOnboarding(await startOnboarding(repo, user), "ru");
        // Message 77 is an old message of the introduction, with buttons this step does not have.
        for (const data of [...OLD, ...foreign]) {
          const u = await b.press(data, 77);
          expect(u.methods, `${user.onboardingStep} ${data}`).toEqual(["editMessageText", "answerCallbackQuery"]);
          expect(u.calls[0]!.payload).toMatchObject({ message_id: 77, text: screen.text, reply_markup: { inline_keyboard: screen.keyboard } });
          expect(u.toast, data).toBe(ru.chooseAbove);
        }
        expect(await b.user()).toEqual(user);
      }
    });

    it("typed text, a command and a button of the settings on a step after the language are answered the same way and change nothing", async () => {
      await catalog(env.DB);
      const b = bot();
      await b.text("/start");
      for (const answer of ["ob:ru", "ob:n1", "ob:n2"]) {
        await b.press(answer, 100);
        const user = await b.user();
        // «Как это работает» is a command like the others: on a step it answers as /learn does there.
        for (const typed of ["14:35", "рәхмәт", "/learn", "/levels", "/settings", "/stats", "/undo", "/howto"]) {
          const u = await b.text(typed);
          expect(u.calls.map((c) => [c.method, c.payload.text]), typed).toEqual([["sendMessage", ru.chooseAbove]]);
        }
        // «Показать обучение заново» and its two screens are gone; their buttons in old messages are buttons of the settings here, like the rest.
        for (const data of ["set:tut", "tut:2", "tut:ok", "hub", "lv:t:2", "learn"]) {
          const u = await b.press(data, 100);
          expect(u.calls.map((c) => c.payload.text), data).toEqual([ru.chooseAbove]);
        }
        // The rows of /settings that change a value at a tap are buttons of the settings like the others: the tap is answered, and the row is only read.
        for (const data of ["set:lang", "set:ret", "set:new", "set:rem", "set:dir", "set:auto"]) {
          const u = await b.press(data, 100);
          expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.chooseAbove]]);
          expect(u.d1, data).toBe(1);
        }
        expect(await b.user()).toEqual(user);
      }
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first<{ n: number }>())!.n).toBe(0);
    });

    it("after the introduction every button of it, old or new, is a stale button and changes nothing", async () => {
      await catalog(env.DB);
      const b = bot();
      await introduced(b);
      const user = await b.user();
      for (const data of [...OLD, "ob:ru", "ob:tt", "ob:n1", "ob:n2", "ob:next", "ob:lv:2", "ob:lv:1", "ob:go"]) {
        const u = await b.press(data, 100);
        expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
        expect(u.d1).toBe(1);
      }
      expect(await b.user()).toEqual(user);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first<{ n: number }>())!.n).toBe(1);
    });

    it("a learner who stood in the middle of the old introduction is on «Уровни»: «Знаю» shows that step, «Начать» gives the first card", async () => {
      await catalog(env.DB);
      const b = bot();
      await b.text("/start");
      const repo = new Repo(env.DB);
      // What the migration leaves of such a learner: the step, and the answers given before it.
      await repo.updateUser((await b.user()).id, { onboardingStep: "levels", lang: "tt", newPerDay: 20, remindAt: "19:00" });
      const know = await b.press("ob:1", 55);
      expect(know.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
      expect(know.calls[0]!.payload).toMatchObject({ message_id: 55, text: tt.obLevels });
      expect(know.toast).toBe(tt.chooseAbove);
      await b.press("ob:go", 55);
      expect(b.h.lastText().startsWith(`${tt.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
      // The step said 09:00 and 10 words a day: that is what the learner has.
      expect(await b.user()).toMatchObject({ onboardingStep: null, hintsSeen: HINT.update, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180 });
    });

    it.each(["placement", "goal", "remind", "tz"])("a step of the old introduction left in the row (%s) is the language step: no update fails, and the learner goes on", async (stored) => {
      await catalog(env.DB);
      const b = bot();
      await b.text("/start");
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: stored, onboardingData: JSON.stringify({ i: 3, known: 2 }) });
      for (const data of ["ob:1", "ob:10", "ob:09:00", "ob:180", "ob:n1", "ob:n2", "ob:go"]) {
        const u = await b.press(data, 100);
        expect(u.methods, data).toEqual(["sendMessage", "answerCallbackQuery"]);
        expect(u.calls[0]!.payload, data).toMatchObject({ text: ru.welcome });
        expect(u.toast, data).toBeUndefined();
      }
      expect((await b.text("14:35")).calls.map((c) => [c.method, c.payload.text])).toEqual([["sendMessage", ru.welcome]]);
      await b.text("/start");
      expect(b.h.lastText()).toBe(ru.welcome);
      edited(await b.press("ob:ru"), b.h.tg.lastMessageId());
      expect(b.h.lastText()).toBe(ru.intro1);
      expect((await b.user()).onboardingStep).toBe("intro1");
    });
  });
});

describe("the practice card of the introduction", () => {
  it("«Хорошо»: one edit and one answer, one read of the database and no row written; the count, what the button did, the buttons left, and the mark on the button", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    expect(before.users).toHaveLength(1);
    expect([before.cards, before.review_log, before.sessions, before.user_progress]).toEqual([[], [], [], []]);

    const good = await b.press("pr:0:3");
    expect(good.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(good.calls[0]!.payload).toMatchObject({ message_id: 100, parse_mode: "HTML" });
    expect(good.toast).toBeUndefined();
    expect(good.d1).toBe(1);
    expect(await held()).toEqual(before);
    expect(b.h.lastText()).toBe(CARD_RU(1, 3));
    for (const part of ["Тренировка · 1 из 4", "придёт через 10 минут, потом через 1 день, 3 дня, 7 дней — всё реже.", "Осталось кнопок: 3"]) expect(b.h.lastText()).toContain(part);
    // The explanation stands above the word, and the count of the buttons left under the explanation.
    expect(b.h.lastText().indexOf(EXPLAINED_RU[3]!)).toBeLessThan(b.h.lastText().indexOf("<b>китап</b>"));
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, 4, SKIP_RU));
    expect(buttons(b.h.lastMarkup())[2]).toEqual(["✅ Хорошо · 10 минут", "pr:4:3"]);
  });

  it("each button says what it does to the word, with its own interval; «Снова» has «через 1 минуту»", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    const again = await b.press("pr:0:1");
    edited(again);
    expect(b.h.lastText()).toBe(CARD_RU(1, 1));
    // The button reads «1 минута»; after «через» the explanation has «1 минуту».
    expect(buttons(b.h.lastMarkup())[0]).toEqual(["✅ Снова · 1 минута", "pr:1:1"]);
    expect(b.h.lastText()).toContain("придёт через 1 минуту и будет подниматься заново.");
    expect(b.h.lastText()).not.toContain("через 1 минута");
    edited(await b.press("pr:1:2"));
    expect(b.h.lastText()).toBe(CARD_RU(2, 2));
    expect(b.h.lastText()).toContain("у нового слова это 5 минут.");
    edited(await b.press("pr:3:4"));
    expect(b.h.lastText()).toBe(CARD_RU(3, 4));
    expect(b.h.lastText()).toContain("придёт сразу через 1 день.");
    expect(b.h.lastText()).toContain("Осталось кнопок: 1");
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, 11, SKIP_RU));
    expect(await held()).toEqual(before);
  });

  it("a button pressed again shows its explanation again: the count stays, and «message is not modified» of Telegram is no error", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const first = await b.press("pr:0:3");
    const before = await held();
    // The same button: the same text and buttons, which Telegram refuses to write twice.
    b.h.tg.failNext("editMessageText", 400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
    const twice = await b.press("pr:4:3");
    expect(twice.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(twice.calls[0]!.payload).toEqual(first.calls[0]!.payload);
    expect(twice.toast).toBeUndefined();
    expect(twice.d1).toBe(1);
    expect(b.h.lastText()).toBe(CARD_RU(1, 3));

    // A tried button after another one: its explanation comes back, the count does not grow.
    await b.press("pr:4:1");
    expect(b.h.lastText()).toBe(CARD_RU(2, 1));
    const back = await b.press("pr:5:3");
    edited(back);
    expect(b.h.lastText()).toBe(CARD_RU(2, 3));
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, 5, SKIP_RU));
    expect(await held()).toEqual(before);
  });

  it("a message Telegram cannot edit is sent again, still within three calls", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    b.h.tg.failNext("editMessageText", 400, "Bad Request: message to edit not found");
    const u = await b.press("pr:0:3");
    expect(u.methods).toEqual(["editMessageText", "sendMessage", "answerCallbackQuery"]);
    expect(u.calls[1]!.payload).toMatchObject({ text: CARD_RU(1, 3) });
    expect(u.d1).toBe(1);
  });

  it("the four buttons in any order end on the final screen with «Дальше»; each press is one read and writes nothing", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    expect(ORDERS).toHaveLength(24);
    for (const order of ORDERS) {
      // /start on the step sends the card again, with no button tried.
      await b.text("/start");
      let mask = 0;
      for (const [i, rating] of order.entries()) {
        const data = buttons(b.h.lastMarkup()).find(([, d]) => d!.endsWith(`:${rating}`))![1]!;
        expect(data, order.join("")).toBe(`pr:${mask}:${rating}`);
        const u = await b.press(data);
        expect([u.methods, u.d1], order.join("")).toEqual([["editMessageText", "answerCallbackQuery"], 1]);
        mask |= 1 << (rating - 1);
        if (i < 3) expect([b.h.lastText(), buttons(b.h.lastMarkup())], order.join("")).toEqual([CARD_RU(i + 1, rating), keys(LABELS_RU, mask, SKIP_RU)]);
      }
      expect([b.h.lastText(), buttons(b.h.lastMarkup())], order.join("")).toEqual([FINAL_RU(order[3]!), [NEXT_RU]]);
    }
    expect(await held()).toEqual(before);
    edited(await b.press("ob:n2"), b.h.tg.lastMessageId());
    expect(b.h.lastText()).toBe(ru.obLevels);
    expect((await b.user()).onboardingStep).toBe("levels");
  });

  it("«Пропустить» of the fresh card goes on to the levels, and so does it after some buttons", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    expect(buttons(b.h.lastMarkup()).at(-1)).toEqual(SKIP_RU);
    const skip = await b.press("ob:n2");
    edited(skip);
    expect(skip.d1).toBe(3);
    expect(b.h.lastText()).toBe(ru.obLevels);
    expect(buttons(b.h.lastMarkup())).toEqual(LEVELS_RU(true, false));
    expect(await b.user()).toMatchObject({ onboardingStep: "levels", hintsSeen: 0 });

    await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: "practice" });
    await b.press("pr:0:2", 100);
    expect(buttons(b.h.lastMarkup()).at(-1)).toEqual(SKIP_RU);
    edited(await b.press("ob:n2", 100));
    expect(b.h.lastText()).toBe(ru.obLevels);
  });

  it("a learner stored on the step `intro2`, the second screen the introduction had, gets the practice card and goes on from it", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    await b.press("ob:ru");
    const repo = new Repo(env.DB);
    await repo.updateUser((await b.user()).id, { onboardingStep: "intro2" });
    const start = await b.text("/start");
    expect(start.methods).toEqual(["sendMessage"]);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(0), keys(LABELS_RU, 0, SKIP_RU)]);
    const row = await b.user();
    // The card is the introduction's for this learner: its last row is «Пропустить».
    edited(await b.press("pr:0:4"), b.h.tg.lastMessageId());
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(1, 4), keys(LABELS_RU, 8, SKIP_RU)]);
    // An answer the step does not take shows the practice card, as on the step `practice`.
    const stray = await b.press("ob:n1", 77);
    expect(stray.calls[0]!.payload).toMatchObject({ message_id: 77, text: CARD_RU(0) });
    expect(stray.toast).toBe(ru.chooseAbove);
    // Nothing of this rewrote the stored step.
    expect(await b.user()).toEqual(row);
    expect(row.onboardingStep).toBe("intro2");
    // «Дальше» of the old second screen, in its old message, is the answer this step takes: the levels.
    edited(await b.press("ob:n2", 100));
    expect(b.h.lastText()).toBe(ru.obLevels);
    expect((await b.user()).onboardingStep).toBe("levels");
  });
});

/*
 * Every learner starts again with the levels A1–C1, and the first thing a returning learner does is seldom /start: a
 * button of an old message, /learn, a word. The bot knows nobody yet, so whatever comes is answered with the language
 * screen, as a new message.
 */
describe("a learner who has not chosen a language yet", () => {
  const LANG_SCREEN = { text: ru.welcome, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Русский", callback_data: "ob:ru" }, { text: "Татарча", callback_data: "ob:tt" }]] } };
  const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  /** What the bot holds of learners: the rows of the users, and everything a learner's action could have made. */
  const rows = async () => Object.fromEntries(await Promise.all(["users", "cards", "sessions", "previews", "review_log", "decks WHERE kind <> 'catalog'"].map(async (t) => [t.split(" ")[0]!, await count(t)])));
  const NOTHING_BUT_THE_ROW = { users: 1, cards: 0, sessions: 0, previews: 0, review_log: 0, decks: 0 };
  /** A new learner as the bot stores one before any answer. */
  const NEW_ROW = { onboardingStep: "lang", lang: "ru", levels: 0b1, newPerDay: 10, remindAt: "09:00", retention: 0.9, direction: "tt_ru", autoplay: false, pendingEdit: null };
  /** One message, the language screen, sent and not edited; a tap is answered after it, with no words. */
  const languageScreen = (u: Update, tap: boolean, why: string) => {
    expect(u.methods, why).toEqual(tap ? ["sendMessage", "answerCallbackQuery"] : ["sendMessage"]);
    expect(u.calls[0]!.payload, why).toMatchObject(LANG_SCREEN);
    expect(u.toast, why).toBeUndefined();
  };

  const FIRST: [what: string, kind: "tap" | "text", update: string][] = [
    ["«▶ Учить» of an old message", "tap", "learn"],
    ["/learn", "text", "/learn"],
    ["a typed word", "text", "рәхмәт"],
    ["a grade button of an old card", "tap", "g:5:0:3"],
    ["a row of the old settings that changed a value at a tap", "tap", "set:new"],
    ["a row of the settings the bot no longer has", "tap", "set:new:10"],
    ["«Язык» of the old settings", "tap", "set:lang"],
    ["/levels", "text", "/levels"],
    ["/settings", "text", "/settings"],
    ["«Отменить» of an old card", "tap", "u"],
    ["a button of the old introduction", "tap", "ob:1"],
    ["/help", "text", "/help"],
    ["/howto", "text", "/howto"],
    ["«Попробовать» of an old «Как это работает»", "tap", "pr:start"],
    ["a button of an old practice card", "tap", "pr:5:2"],
    ["«Показать обучение заново» of the old settings", "tap", "set:tut"],
  ];
  it.each(FIRST)("%s from a learner the bot does not know: the language screen as one new message, a row on the language step and nothing else; then the language is chosen as after /start", async (what, kind, update) => {
    await catalog(env.DB);
    expect(await count("users")).toBe(0);
    const b = bot();
    // Message 77 is a message of the bot as it was before the levels A1–C1.
    const first = kind === "tap" ? await b.press(update, 77) : await b.text(update);
    languageScreen(first, kind === "tap", what);
    // D1 calls: the row is looked for, written and read. Nothing else is asked of the database.
    expect(first.d1).toBe(3);
    expect(await rows()).toEqual(NOTHING_BUT_THE_ROW);
    expect(await b.user()).toMatchObject(NEW_ROW);

    // The same once more, before a language is chosen: the screen again, and nothing else.
    const second = kind === "tap" ? await b.press(update, 77) : await b.text(update);
    languageScreen(second, kind === "tap", what);
    expect(second.d1).toBe(1);
    expect(await rows()).toEqual(NOTHING_BUT_THE_ROW);
    expect(await b.user()).toMatchObject(NEW_ROW);

    // «Русский» of the screen sent last goes on as it does after /start: the screen about the bot, in that message.
    const screen = b.h.tg.lastMessageId();
    const chosen = await b.press("ob:ru", screen);
    edited(chosen, screen);
    expect(b.h.lastText()).toBe(ru.intro1);
    expect(buttons(b.h.lastMarkup())).toEqual([["Попробовать", "ob:n1"]]);
    expect(await b.user()).toMatchObject({ ...NEW_ROW, onboardingStep: "intro1" });
    expect(await rows()).toEqual(NOTHING_BUT_THE_ROW);
  });

  it("a learner who left the language screen of /start unanswered gets it again for anything but a language; «Татарча» of an old screen is still the choice", async () => {
    await catalog(env.DB);
    const b = bot();
    const start = await b.text("/start");
    expect(start.methods).toEqual(["sendMessage"]);
    const row = await b.user();
    for (const [, kind, update] of FIRST) {
      const u = kind === "tap" ? await b.press(update, 77) : await b.text(update);
      languageScreen(u, kind === "tap", update);
      expect(u.d1, update).toBe(1);
    }
    expect(await b.user()).toEqual(row);
    expect(await rows()).toEqual(NOTHING_BUT_THE_ROW);
    // The first screen of all, sent by /start, still takes the answer.
    edited(await b.press("ob:tt", 100), 100);
    expect(b.h.lastText()).toBe(tt.intro1);
    expect(await b.user()).toMatchObject({ lang: "tt", onboardingStep: "intro1" });
  });
});

describe("/howto, «Как это работает»", () => {
  /** A learner in the middle of A1 and A2, with settings of their own, who has seen the hint of the first card and the update notice. */
  async function studying(patch: Partial<User> = {}) {
    await catalog(env.DB);
    const { repo, user } = await seedLearner(env.DB, {
      now: T, tgId: 42,
      patch: { hintsSeen: 127, levels: 0b11, posGroups: 0b1011, newMode: "topic", topicNo: 1, newPerDay: 20, remindAt: "19:00", tzOffsetMin: 300, direction: "both", autoplay: false, retention: 0.95, streak: 4, lastStudyDay: "2026-09-29", ...patch },
    });
    const note = (await env.DB.prepare("SELECT id FROM notes WHERE word = 'сәлам'").first<{ id: number }>())!.id;
    await repo.insertCard(user.id, note, "tt_ru", gradedMem(T));
    await recountProgress(env.DB, user.id);
    return { repo, user };
  }

  it("sends the screen about the bot with «Попробовать»; then the practice card, the four buttons and the final screen end with «▶ Учить»; the whole run writes nothing", async () => {
    const { user } = await studying();
    const before = await held();
    expect([before.cards.length, before.user_progress.length]).toEqual([1, 1]);
    const b = bot();

    const about = await b.text("/howto");
    expect(about.methods).toEqual(["sendMessage"]);
    expect(about.d1).toBe(1);
    expect(about.calls[0]!.payload).toMatchObject({ parse_mode: "HTML" });
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([ABOUT_RU, [["Попробовать", "pr:start"]]]);

    const card = await b.press("pr:start");
    edited(card);
    expect(card.d1).toBe(1);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(0), keys(LABELS_RU, 0, LEARN_RU)]);
    expect((b.h.lastMarkup().inline_keyboard ?? []).map((row) => row.length)).toEqual([2, 2, 1]);

    let mask = 0;
    for (const [i, rating] of [2, 4, 1, 3].entries()) {
      const u = await b.press(`pr:${mask}:${rating}`);
      edited(u);
      expect(u.d1).toBe(1);
      mask |= 1 << (rating - 1);
      if (i < 3) expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(i + 1, rating), keys(LABELS_RU, mask, LEARN_RU)]);
    }
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([FINAL_RU(3), [LEARN_RU]]);

    // Nothing of the learner changed: not the progress, not the settings, not the step of the introduction.
    expect(await held()).toEqual(before);
    expect(await b.user()).toEqual(user);
    expect((await env.DB.prepare("SELECT onboarding_step AS step, hints_seen AS seen FROM users").first())).toEqual({ step: null, seen: 127 });

    // «▶ Учить» opens the session: a real card, as a message of its own.
    const learn = await b.press("learn");
    expect(learn.methods).toEqual(["sendMessage", "answerCallbackQuery"]);
    expect(b.h.lastText()).toMatch(/^🔵 \d+ · 🔴 \d+ · 🟢 \d+\n<b>/);
  });

  it("is in Tatar for a tt learner", async () => {
    await studying({ lang: "tt" });
    const b = bot();
    await b.text("/howto");
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([ABOUT_TT, [["Сынап карау", "pr:start"]]]);
    await b.press("pr:start");
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_TT(0), keys(LABELS_TT, 0, ["▶ Өйрәнү", "learn"])]);
    for (const [mask, rating] of [[0, 1], [1, 2], [3, 3], [7, 4]]) await b.press(`pr:${mask}:${rating}`);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([`${EXPLAINED_TT[4]}\n\n${DONE_TT}`, [["▶ Өйрәнү", "learn"]]]);
  });

  it("on a step of the introduction it answers as /learn does there; before a language is chosen it gives the language screen", async () => {
    await catalog(env.DB);
    const b = bot();
    const unknown = await b.text("/howto");
    expect(unknown.calls.map((c) => [c.method, c.payload.text])).toEqual([["sendMessage", ru.welcome]]);
    await b.press("ob:ru");
    for (const step of ["intro1", "practice", "intro2", "levels"]) {
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: step });
      const row = await b.user();
      const [howto, learn] = [await b.text("/howto"), await b.text("/learn")];
      expect(howto.calls.map((c) => [c.method, c.payload]), step).toEqual(learn.calls.map((c) => [c.method, c.payload]));
      expect(howto.calls.map((c) => [c.method, c.payload.text]), step).toEqual([["sendMessage", ru.chooseAbove]]);
      expect([howto.d1, learn.d1], step).toEqual([1, 1]);
      expect(await b.user()).toEqual(row);
    }
  });

  it("a practice button of the introduction's message pressed after the introduction works as a replay and writes nothing; its «Пропустить» is then a stale button", async () => {
    await catalog(env.DB);
    const b = bot();
    await introduced(b);
    const before = await held();
    // Message 100 was the introduction; the learner pressed «Хорошо» there before, and it stood so in another chat window.
    const late = await b.press("pr:4:1", 100);
    edited(late, 100);
    expect(late.d1).toBe(1);
    // The card is the replay's: «▶ Учить» in place of «Пропустить».
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(2, 1), keys(LABELS_RU, 5, LEARN_RU)]);
    for (const [mask, rating] of [[5, 2], [7, 4]]) edited(await b.press(`pr:${mask}:${rating}`, 100), 100);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([FINAL_RU(4), [LEARN_RU]]);

    for (const data of ["ob:n2", "ob:n1"]) {
      const stale = await b.press(data, 100);
      expect(stale.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
      expect(stale.d1).toBe(1);
    }
    expect(await held()).toEqual(before);
    expect((await b.user()).onboardingStep).toBeNull();
  });

  it("on a step of the introduction other than the practice, a practice button of an older message is a replay too: it shows the card, writes nothing and keeps the step", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    await b.press("ob:ru");
    for (const step of ["intro1", "levels"]) {
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: step });
      const before = await held();
      // Message 77 is a practice card sent earlier, by a /start on the practice step.
      const start = await b.press("pr:start", 77);
      edited(start, 77);
      expect([b.h.lastText(), buttons(b.h.lastMarkup())], step).toEqual([CARD_RU(0), keys(LABELS_RU, 0, LEARN_RU)]);
      const u = await b.press("pr:0:3", 77);
      edited(u, 77);
      expect([start.d1, u.d1], step).toEqual([1, 1]);
      expect([b.h.lastText(), buttons(b.h.lastMarkup())], step).toEqual([CARD_RU(1, 3), keys(LABELS_RU, 4, LEARN_RU)]);
      expect(await held()).toEqual(before);
    }
  });

  it("data that is no practice button is answered as a stale button", async () => {
    await studying();
    const before = await held();
    const b = bot();
    for (const data of ["pr:16:1", "pr:3:5", "pr:x:1", "pr:3", "pr:3:1:1", "pr:", "pr:go"]) {
      const u = await b.press(data, 100);
      expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
      expect(u.d1, data).toBe(1);
    }
    expect(await held()).toEqual(before);
  });

  it("«Показать обучение заново» is gone: its buttons in old messages are answered as stale, and nothing is written, the hints among it", async () => {
    await studying();
    const before = await held();
    const b = bot();
    for (const data of ["set:tut", "tut:2", "tut:ok"]) {
      const u = await b.press(data, 100);
      expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
      expect(u.d1, data).toBe(1);
    }
    expect(await held()).toEqual(before);
    expect((await b.user()).hintsSeen).toBe(127);
    // The settings have no such row: the last one opens the levels.
    await b.text("/settings");
    expect(buttons(b.h.lastMarkup()).map(([, data]) => data)).toEqual(["set:lang", "set:new", "set:rem", "set:tz", "set:dir", "set:auto", "set:hub"]);
  });

  it("the screens, rendered: the introduction and the replay differ in their buttons alone", () => {
    for (const lang of ["ru", "tt"] as const) {
      const d = lang === "ru" ? ru : tt;
      expect(renderAbout(lang, false)).toEqual({ text: d.intro1, keyboard: [[{ text: d.tryBtn, callback_data: "ob:n1" }]] });
      expect(renderAbout(lang, true)).toEqual({ text: d.intro1, keyboard: [[{ text: d.tryBtn, callback_data: "pr:start" }]] });
      expect(renderOnboarding({ kind: "intro" }, lang)).toEqual(renderAbout(lang, false));
      expect(renderOnboarding({ kind: "practice" }, lang)).toEqual(renderPractice(0, null, lang, false));
      for (let mask = 0; mask <= 15; mask++) {
        for (const last of [null, 1, 2, 3, 4] as const) {
          const [intro, replay] = [renderPractice(mask, last, lang, false), renderPractice(mask, last, lang, true)];
          expect(replay.text, `${lang} ${mask} ${last}`).toBe(intro.text);
          expect(replay.keyboard.slice(0, -1)).toEqual(intro.keyboard.slice(0, -1));
          expect(intro.keyboard.at(-1)!.map((x) => x.callback_data)).toEqual(["ob:n2"]);
          expect(replay.keyboard.at(-1)).toEqual([{ text: d.learnBtn, callback_data: "learn", style: "primary" }]);
          expect(intro.keyboard.at(-1)![0]!.text).toBe(mask === 15 ? d.nextBtn : d.skipBtn);
          // The final screen has no grade button; before it there are always the four.
          expect(intro.keyboard.flat().filter((x) => x.callback_data.startsWith("pr:"))).toHaveLength(mask === 15 ? 0 : 4);
        }
      }
    }
    expect(renderPractice(0, null, "ru", false).text).toBe(CARD_RU(0));
    expect(renderPractice(15, null, "ru", true).text).toBe(DONE_RU);
    expect(renderPractice(15, null, "tt", true).text).toBe(DONE_TT);
    for (const last of [1, 2, 3, 4] as const) {
      expect(renderPractice(1 << (last - 1), last, "ru", false).text).toBe(CARD_RU(1, last));
      expect(renderPractice(1 << (last - 1), last, "tt", false).text).toBe(CARD_TT(1, last));
      expect(renderPractice(15, last, "ru", false).text).toBe(FINAL_RU(last));
    }
  });

  it("is in the menu of the bot: nine commands, «Как это работает» after the levels, in both languages", () => {
    const names = ["start", "learn", "levels", "howto", "gen", "stats", "settings", "undo", "help"];
    expect(commands(ru).map((c) => c.command)).toEqual(names);
    expect(commands(tt).map((c) => c.command)).toEqual(names);
    expect(commands(ru)).toHaveLength(9);
    expect(commands(ru)[3]).toEqual({ command: "howto", description: "Как это работает" });
    expect(commands(tt)[3]).toEqual({ command: "howto", description: "Бу ничек эшли" });
    // Telegram takes a description of 1 to 256 characters.
    for (const c of [...commands(ru), ...commands(tt)]) expect(c.description.length, c.command).toBeGreaterThanOrEqual(3);
    // /help names it too.
    expect(ru.help).toContain("/howto — как это работает");
    expect(tt.help).toContain("/howto — бу ничек эшли");
  });
});

describe("hints", () => {
  it("a grade on a real card says nothing about its button, whichever it is; only the first card carries a hint", async () => {
    await catalog(env.DB);
    const b = bot();
    await introduced(b);
    const startsWith = (lead: string, word: string) => expect(b.h.lastText().split(`\n<b>${word}</b>\n`)[0]!.replace(/🔵.*$/, ""), b.h.lastText()).toBe(lead ? `${lead}\n\n` : "");
    startsWith(ru.hintFront, "сәлам");
    expect((await b.user()).hintsSeen).toBe(HINT.update);

    const good = await b.grade(3);
    expect(good.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect([good.shown, good.given]).toEqual(["10 минут", "10 минут"]);
    startsWith("", "мин");
    // The grade marks the hint of the first card as seen, and the update notice, which a new learner never sees.
    expect((await b.user()).hintsSeen).toBe(HINT.update | HINT.front);

    const goodAgain = await b.grade(3);
    startsWith("", "рәхмәт");
    const again = await b.grade(1);
    expect([again.shown, again.given]).toEqual(["1 минута", "1 минута"]);
    startsWith("", "син");
    const hard = await b.grade(2);
    expect([hard.shown, hard.given]).toEqual(["5 минут", "5 минут"]);
    startsWith("", "исәнмесез");
    const easy = await b.grade(4);
    // The words of A1 are all started: the card that comes is one that is due again.
    expect([easy.shown, easy.given]).toEqual(["1 день", "1 день"]);
    expect(b.h.lastText().startsWith("🔵 0 · ")).toBe(true);
    expect((await b.user()).hintsSeen).toBe(HINT.update | HINT.front);
    // Measured: a grade is 6 D1 calls and 3 Telegram calls here.
    expect([good.d1, goodAgain.d1, again.d1, hard.d1, easy.d1]).toEqual([6, 6, 6, 6, 6]);
    for (const g of [good, goodAgain, again, hard, easy]) expect(g.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);

    // No message of the session explains a button or the order of a session, and the update notice never comes to a new learner.
    const cards = b.h.tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text ?? ""));
    expect(cards.filter((x) => x.startsWith(ru.hintFront))).toHaveLength(1);
    for (const gone of ["„", "слово вернётся", "Порядок в занятии", "Бот обновился", "«Хорошо»", "«Снова»"]) expect(cards.filter((x) => x.includes(gone)), gone).toEqual([]);
  });

  it("the hint of the first card stands on every card until the first grade", async () => {
    await catalog(env.DB);
    const b = bot();
    await introduced(b);
    for (let i = 0; i < 2; i++) {
      await b.text("/learn");
      expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    }
    await b.grade(3);
    await b.text("/learn");
    expect(b.h.lastText().startsWith("🔵 9 · 🔴 1 · 🟢 0\n<b>мин</b>\n")).toBe(true);
  });

  it("the practice does not count as a grade: after it the first real card still carries its hint", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    for (const [mask, rating] of [[0, 1], [1, 2], [3, 3], [7, 4]]) await b.press(`pr:${mask}:${rating}`, 100);
    for (const answer of ["ob:n2", "ob:go"]) await b.press(answer, 100);
    expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    expect((await b.user()).hintsSeen).toBe(HINT.update);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>())!.n).toBe(0);
  });

  it("the screen that ends the session after the first grade carries no line about the button", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сәлам", topic: 1 }]);
    const b = bot();
    await introduced(b);
    const easy = await b.grade(4);
    expect(easy.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(b.h.lastText()).toBe([ru.doneTitle, ru.doneToday(1, 0), ru.streak(1), "", ru.emptyAllDone].join("\n"));
    expect(easy.d1).toBeLessThanOrEqual(8);
  });

  it("an undone grade does not bring the hint of the first card back", async () => {
    await catalog(env.DB);
    const b = bot();
    await introduced(b);
    await b.grade(3);
    await b.press("u");
    expect(b.h.lastText().startsWith(`${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    await b.grade(3);
    expect(b.h.lastText().startsWith("🔵 9 · 🔴 1 · 🟢 0\n<b>мин</b>\n")).toBe(true);
  });

  it("the texts of the two hints, in both languages", () => {
    expect([renderLead({ kind: "front" }, "ru"), renderLead({ kind: "update" }, "ru")]).toEqual([
      "Вспомните перевод, откройте скрытый текст и оцените себя.",
      "Бот обновился: уровни A1–C1, темы и порядок слов — в /levels",
    ]);
    expect([renderLead({ kind: "front" }, "tt"), renderLead({ kind: "update" }, "tt")]).toEqual([tt.hintFront, tt.updateNotice]);
  });
});

describe("a learner who knew the bot before the levels A1–C1", () => {
  /**
   * The row holds `hints_seen` 63: the hint of the first card and the five bits of the hints the bot no longer has
   * (the four buttons and the order of a session); the update notice is not seen. «сәлам» is started and comes back in three days.
   */
  async function earlier(patch: Partial<User> = {}) {
    await catalog(env.DB);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42, patch: { hintsSeen: 63, ...patch } });
    const note = (await env.DB.prepare("SELECT id FROM notes WHERE word = 'сәлам'").first<{ id: number }>())!.id;
    await repo.insertCard(user.id, note, "tt_ru", gradedMem(T));
    await recountProgress(env.DB, user.id);
    return { repo, user };
  }

  it("sees the update notice above the next card, no hint after a grade, and the notice never again", async () => {
    const { repo, user } = await earlier();
    const b = bot();
    await b.text("/learn");
    expect(b.h.lastText().startsWith(`Бот обновился: уровни A1–C1, темы и порядок слов — в /levels\n\n🔵 10 · 🔴 0 · 🟢 0\n<b>мин</b>\n`)).toBe(true);
    await b.grade(3);
    expect(b.h.lastText().startsWith("🔵 9 · 🔴 1 · 🟢 0\n<b>рәхмәт</b>\n")).toBe(true);
    // The bits of the hints that are gone stay as they were stored: the grade adds its two and takes none away.
    expect((await repo.getUser(user.id))!.hintsSeen).toBe(127);
    for (const rating of [1, 2, 4] as const) {
      await b.grade(rating);
      expect(b.h.lastText()).toMatch(/^🔵/);
    }
    await b.text("/learn");
    expect(b.h.lastText()).toMatch(/^🔵/);
    expect(b.h.tg.calls.filter((c) => String(c.payload.text ?? "").includes("Бот обновился"))).toHaveLength(1);
  });

  it("with nothing to study sees the notice above the screen that ends the session; a new learner's hint of the first card never stands there", async () => {
    await earlier({ levels: 0b10 });
    await env.DB.prepare("UPDATE notes SET level = NULL WHERE word = 'сәяхәт'").run();
    const b = bot();
    await b.text("/learn");
    expect(b.h.lastText().startsWith(`${ru.updateNotice}\n\n${ru.doneTitle}\n`)).toBe(true);
    await env.DB.prepare("UPDATE users SET hints_seen = ?").bind(HINT.update).run();
    await b.text("/learn");
    expect(b.h.lastText().startsWith(`${ru.doneTitle}\n`)).toBe(true);
    await env.DB.prepare("UPDATE users SET hints_seen = 0").run();
    await b.text("/learn");
    expect(b.h.lastText().startsWith(`${ru.updateNotice}\n\n${ru.doneTitle}\n`)).toBe(true);
  });

  it("is in Tatar for a tt learner", async () => {
    await earlier({ lang: "tt" });
    const b = bot();
    await b.text("/learn");
    expect(b.h.lastText().startsWith("Бот яңартылды: A1–C1 дәрәҗәләре, темалар һәм сүзләр тәртибе — /levels командасында\n\n🔵 10 · 🔴 0 · 🟢 0\n<b>мин</b>\n")).toBe(true);
  });

  it.each([2, 4, 8, 16, 32, 62, 126, 127, 255])("a row whose `hints_seen` holds bits of the hints that are gone (%i) studies, opens /howto and the settings without an error, and keeps those bits", async (stored) => {
    const { repo, user } = await earlier({ hintsSeen: stored });
    const b = bot();
    await b.text("/learn");
    expect(b.h.lastText()).toContain("\n<b>мин</b>\n");
    await b.grade(3);
    expect(b.h.lastText()).toMatch(/^🔵 9 · 🔴 1 · 🟢 0\n<b>рәхмәт<\/b>\n/);
    expect((await repo.getUser(user.id))!.hintsSeen).toBe(stored | HINT.front | HINT.update);
    await b.text("/howto");
    expect(b.h.lastText()).toBe(ABOUT_RU);
    await b.text("/settings");
    expect(b.h.lastText()).toBe(ru.settingsTitle);
    expect((await repo.getUser(user.id))!.hintsSeen).toBe(stored | HINT.front | HINT.update);
  });
});
