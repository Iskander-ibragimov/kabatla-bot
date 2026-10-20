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
  /** Presses a button of a practice card on screen, which sends the next screen as a new message in place of that one. */
  const step = async (data: string) => {
    const old = h.tg.lastMessageId();
    const u = await press(data, old);
    replaced(u, old);
    return u;
  };
  return { h, text: (s: string, entities?: unknown[]) => update(() => h.text(s, entities)), press, step, grade, user };
}
type Update = Awaited<ReturnType<ReturnType<typeof bot>["press"]>>;
/** The update changed the message in place and answered the tap: nothing was sent. */
const edited = (u: Pick<Update, "calls" | "methods">, messageId = 100) => {
  expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
  expect(u.calls[0]!.payload.message_id).toBe(messageId);
};
/**
 * The update sent its screen as a new message, quietly, removed the message whose button was pressed and answered the
 * tap: a practice card that follows a press is never an edit, which would keep a revealed spoiler revealed.
 */
const replaced = (u: Pick<Update, "calls" | "methods">, old: number) => {
  expect(u.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
  expect(u.calls[0]!.payload).toMatchObject({ parse_mode: "HTML", disable_notification: true });
  expect(u.calls[1]!.payload.message_id).toBe(old);
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

/* The practice, word for word (the practice spec §2 in Russian; Tatar in the same voice). */
const ABOUT_RU = "Кабатла учит татарские слова карточками. Слово возвращается тогда, когда вы начинаете его забывать: сначала через минуты, потом через дни и месяцы. Так оно остаётся в памяти надолго.\n\nСейчас попробуем на трёх словах — это займёт полминуты.";
/** The three words and their translations, hidden the way a real card hides them; the same in both interface languages. */
const PAIRS = [["китап", "книга"], ["су", "вода"], ["әни", "мама"]] as const;
const WORD = (k: number) => `<b>${PAIRS[k - 1]![0]}</b>\n<tg-spoiler><b>${PAIRS[k - 1]![1]}</b></tg-spoiler>`;
const NOTE_RU = "Так выглядит карточка. Вспомните перевод, откройте скрытый текст и нажмите одну кнопку — как честно вспомнили.";
const EXPLAINED_RU: Record<number, string> = {
  1: "✅ Вы нажали «Снова» — не вспомнили. Слово вернулось бы через 1 минуту и начало бы лесенку заново.",
  2: "✅ Вы нажали «Трудно» — вспомнили с трудом. Слово вернулось бы через 5 минут на той же ступеньке.",
  3: "✅ Вы нажали «Хорошо» — вспомнили. Слово вернулось бы через 10 минут, потом через 1 день, 3 дня, 7 дней — всё реже.",
  4: "✅ Вы нажали «Легко» — знаете уверенно. Слово вернулось бы не через 10 минут, а сразу через 1 день.",
};
const DONE_RU = "🎉 Готово! Так и идёт обучение: бот показывает слова по одному, вы честно оцениваете, и каждое слово возвращается тогда, когда его пора повторить — трудные чаще, лёгкие реже.\nВернуться к этой тренировке — /howto.";
const LABELS_RU = ["Снова · 1 минута", "Трудно · 5 минут", "Хорошо · 10 минут", "Легко · 1 день"];
/** The card of the word `k` of three; `last` is the button pressed on the word before, whose explanation stands above the card. */
const CARD_RU = (k: number, last?: number) => [...(last ? [EXPLAINED_RU[last]!, ""] : []), `🎓 Тренировка · слово ${k} из 3`, NOTE_RU, "", WORD(k)].join("\n");
/** The screen after the third word: what its button did, and the end of the practice. */
const FINAL_RU = (last: number) => `${EXPLAINED_RU[last]}\n\n${DONE_RU}`;

const ABOUT_TT = "Кабатла татар сүзләрен карточкалар ярдәмендә өйрәтә. Сүз сез аны оныта башлаган вакытта кире кайта: башта берничә минуттан, аннары көннәр һәм айлар узгач. Шулай ул хәтердә озакка кала.\n\nХәзер өч сүздә сынап карыйбыз — ярты минут кына.";
const NOTE_TT = "Карточка шундый күренә. Тәрҗемәсен искә төшерегез, яшерелгән текстны ачыгыз һәм бер генә төймәгә басыгыз — искә төшерүегезне гадел бәяләп.";
const EXPLAINED_TT: Record<number, string> = {
  1: "✅ Сез «Яңадан» төймәсенә бастыгыз — искә төшермәдегез. Сүз кайтканчы 1 минут узар иде, һәм ул баскычны яңадан башлар иде.",
  2: "✅ Сез «Авыр» төймәсенә бастыгыз — авырлык белән искә төшердегез. Сүз кайтканчы 5 минут узар иде, ул шул ук баскычта калыр иде.",
  3: "✅ Сез «Яхшы» төймәсенә бастыгыз — искә төшердегез. Сүз кайтканчы 10 минут узар иде, аннары 1 көн, 3 көн, 7 көн — барган саен сирәгрәк.",
  4: "✅ Сез «Җиңел» төймәсенә бастыгыз — яхшы беләсез. Сүз кайтканчы 10 минут түгел, ә бер юлы 1 көн узар иде.",
};
const DONE_TT = "🎉 Булды! Өйрәнү шулай бара: бот сүзләрне берәм-берәм күрсәтә, сез үзегезгә гадел бәя куясыз, һәм һәр сүз кабатлау вакыты җиткәч кайта — авырлары ешрак, җиңелләре сирәгрәк.\nБу күнегүгә кире кайту — /howto.";
const LABELS_TT = ["Яңадан · 1 минут", "Авыр · 5 минут", "Яхшы · 10 минут", "Җиңел · 1 көн"];
const CARD_TT = (k: number, last?: number) => [...(last ? [EXPLAINED_TT[last]!, ""] : []), `🎓 Күнегү · сүз ${k}/3`, NOTE_TT, "", WORD(k)].join("\n");

/** The buttons of the card of the word `k`: the four grades as on a real card with a new word, then `last`. */
const keys = (labels: string[], k: number, ...last: string[][]) => [...labels.map((label, i) => [label, `pr:s${k}:${i + 1}`]), ...last];
const SKIP_RU = ["Пропустить", "ob:n2"], NEXT_RU = ["Дальше", "ob:n2"], LEARN_RU = ["▶ Учить", "learn"];
const RATINGS = [1, 2, 3, 4] as const;
/** Every way through the three words: one button on each, 64 in all. */
const RUNS = RATINGS.flatMap((a) => RATINGS.flatMap((b) => RATINGS.map((c) => [a, b, c])));

/** The answers after «Уровни» that finish the introduction: «Начать», the reminder at 09:00, the zone of Moscow. */
const FINISH = ["ob:go", "ob:09:00", "ob:tz:180"];
/** Goes through the introduction in Russian up to the first card, with the levels as they are checked at first: A1. The practice is skipped. */
async function introduced(b: ReturnType<typeof bot>) {
  await b.text("/start");
  for (const answer of ["ob:ru", "ob:n1", "ob:n2", ...FINISH]) await b.press(answer, 100);
}
/** Goes through the introduction up to the practice card, in the message 100. */
async function atPractice(b: ReturnType<typeof bot>, lang: "ru" | "tt" = "ru") {
  await b.text("/start");
  for (const answer of [`ob:${lang}`, "ob:n1"]) await b.press(answer, 100);
}

describe("the introduction", () => {
  it("/start → the language → the screen about the bot → the practice of three words, one button each → «Дальше» → the levels → «Начать» → the reminder hour → the time zone: «Готово» and the first real card, with the intervals the practice showed", async () => {
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
    expect(b.h.lastText()).toBe(CARD_RU(1));
    expect(b.h.lastText()).toContain("Тренировка · слово 1 из 3");
    expect(b.h.lastText()).toContain("<b>китап</b>\n<tg-spoiler><b>книга</b></tg-spoiler>");
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, 1, SKIP_RU));
    // The buttons stand as on a real card, two in a row, and the way out is a row of its own.
    expect((b.h.lastMarkup().inline_keyboard ?? []).map((row) => row.length)).toEqual([2, 2, 1]);
    expect(tryIt.calls[0]!.payload).toMatchObject({ parse_mode: "HTML" });
    expect((await b.user()).onboardingStep).toBe("practice");
    const practiced = (b.h.lastMarkup() as Markup).inline_keyboard!.flat().slice(0, 4);

    const row = await b.user();
    const presses: Update[] = [];
    for (const [i, rating] of [3, 1, 4].entries()) {
      const old = b.h.tg.lastMessageId();
      const u = await b.press(`pr:s${i + 1}:${rating}`);
      replaced(u, old);
      presses.push(u);
      if (i < 2) {
        expect(b.h.lastText()).toBe(CARD_RU(i + 2, rating));
        expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, i + 2, SKIP_RU));
      }
    }
    // After the third word: what its button did, and the end of the practice, with one way on.
    expect(b.h.lastText()).toBe(FINAL_RU(4));
    expect(buttons(b.h.lastMarkup())).toEqual([NEXT_RU]);
    // The practice wrote nothing: the learner stands where «Попробовать» left them.
    expect(await b.user()).toEqual(row);

    // «Дальше» answers the step in the message of the final screen.
    const final = b.h.tg.lastMessageId();
    const next = await b.press("ob:n2");
    edited(next, final);
    expect(b.h.lastText()).toBe("Что учить? Отметьте один или несколько уровней. 10 новых слов в день — это меняется в /settings.");
    expect(buttons(b.h.lastMarkup())).toEqual(LEVELS_RU(true, false));
    expect((b.h.lastMarkup().inline_keyboard ?? []).every((row) => row.length === 1)).toBe(true);
    expect(await b.user()).toMatchObject({ onboardingStep: "levels", levels: 0b1 });

    // «Начать» asks the hour of the daily reminder, in the same message.
    const go = await b.press("ob:go");
    edited(go, final);
    expect(b.h.lastText()).toBe("Во сколько присылать напоминание?");
    expect(buttons(b.h.lastMarkup())).toEqual([["08:00", "ob:08:00"], ["09:00", "ob:09:00"], ["12:00", "ob:12:00"], ["19:00", "ob:19:00"], ["21:00", "ob:21:00"]]);
    expect((b.h.lastMarkup().inline_keyboard ?? []).map((row) => row.length)).toEqual([3, 2]);
    expect(await b.user()).toMatchObject({ onboardingStep: "reminder" });
    // Then the time zone, by the time it is now there (06:00 UTC).
    const hour = await b.press("ob:09:00");
    edited(hour, final);
    expect(b.h.lastText()).toBe("Сколько у вас сейчас времени? Так я узнаю часовой пояс.\n<i>Если нет вашего варианта, напишите время, например 14:35.</i>");
    expect(buttons(b.h.lastMarkup())).toEqual([["08:00", "ob:tz:120"], ["09:00", "ob:tz:180"], ["10:00", "ob:tz:240"], ["11:00", "ob:tz:300"], ["13:00", "ob:tz:420"], ["16:00", "ob:tz:600"]]);
    expect(await b.user()).toMatchObject({ onboardingStep: "zone", remindAt: "09:00" });

    const zone = await b.press("ob:tz:180");
    // The message of the introduction says «Готово» and loses its buttons; the card is a message of its own.
    expect(zone.methods).toEqual(["editMessageText", "sendMessage", "answerCallbackQuery"]);
    expect(zone.calls[0]!.payload).toMatchObject({ message_id: final, text: "Готово! Каждый день в <b>09:00</b> (МСК) пришлю напоминание, если есть что повторить или ждут новые слова. Время можно поменять в /settings.\n\nПервое слово — ниже ↓" });
    expect(zone.calls[0]!.payload.reply_markup).toBeUndefined();
    // A card is sent as HTML and never grows a link preview, whatever its source link.
    expect(zone.calls[1]!.payload).toMatchObject({ parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(zone.toast).toBeUndefined();
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
    // nothing else; «Начать» and the hour are the user and the guarded write; the finish is the user, the guarded
    // write, the user again, the queue, its read positions, the new card and the session.
    expect([start.d1, lang.d1, tryIt.d1, ...presses.map((p) => p.d1), next.d1, go.d1, hour.d1, zone.d1]).toEqual([3, 2, 2, 1, 1, 1, 3, 2, 2, 7]);
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

    for (const answer of FINISH) await b.press(answer);
    expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәяхәт</b>\n`)).toBe(true);
    expect(await b.user()).toMatchObject({ onboardingStep: null, levels: 0b10 });
  });

  it("is in Tatar for a learner who chose it: the screen about the bot, the practice card, the levels, the reminder hour, the time zone, «Әзер» and the hint of the first card", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    edited(await b.press("ob:tt"));
    expect(b.h.lastText()).toBe(ABOUT_TT);
    expect(buttons(b.h.lastMarkup())).toEqual([["Сынап карау", "ob:n1"]]);
    edited(await b.press("ob:n1"));
    // The Tatar interface shows the same card: the Tatar word, the Russian translation under the spoiler.
    expect(b.h.lastText()).toBe(CARD_TT(1));
    expect(b.h.lastText()).toContain("Күнегү · сүз 1/3");
    expect(b.h.lastText()).toContain("<b>китап</b>\n<tg-spoiler><b>книга</b></tg-spoiler>");
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_TT, 1, ["Үткәреп җибәрү", "ob:n2"]));

    const before = await held();
    const good = await b.step("pr:s1:3");
    expect(good.d1).toBe(1);
    expect(await held()).toEqual(before);
    // The same words in the Tatar interface, with the Russian translations, as on a real card.
    expect(b.h.lastText()).toBe(CARD_TT(2, 3));
    for (const part of ["Күнегү · сүз 2/3", "кайтканчы 10 минут узар иде, аннары 1 көн, 3 көн, 7 көн — барган саен сирәгрәк.", "<b>су</b>\n<tg-spoiler><b>вода</b></tg-spoiler>"]) expect(b.h.lastText()).toContain(part);
    expect(buttons(b.h.lastMarkup())[2]).toEqual(["Яхшы · 10 минут", "pr:s2:3"]);

    // In Tatar the interval stands before «узар иде» and takes no ending: the minute of «Яңадан» is the word of its button.
    await b.step("pr:s2:1");
    expect(b.h.lastText()).toBe(CARD_TT(3, 1));
    expect(b.h.lastText()).toContain("кайтканчы 1 минут узар иде");
    expect(b.h.lastText()).toContain("<b>әни</b>\n<tg-spoiler><b>мама</b></tg-spoiler>");
    await b.step("pr:s3:4");
    expect(b.h.lastText()).toBe(`${EXPLAINED_TT[4]}\n\n${DONE_TT}`);
    expect(buttons(b.h.lastMarkup())).toEqual([["Алга таба", "ob:n2"]]);
    expect(await held()).toEqual(before);

    await b.press("ob:n2");
    expect(b.h.lastText()).toBe(tt.obLevels);
    expect(buttons(b.h.lastMarkup())).toEqual([
      ["☑ A1 · 5 сүз · текстның ≈45 %", "ob:lv:1"], ["☐ A2 · 1 сүз", "ob:lv:2"], ["☐ B1 · тиздән", "ob:lv:3"], ["☐ B2 · тиздән", "ob:lv:4"], ["☐ C1 · тиздән", "ob:lv:5"], ["Башлау", "ob:go"],
    ]);
    await b.press("ob:go");
    expect(b.h.lastText()).toBe("Сәгать ничәдә искә төшерим?");
    await b.press("ob:21:00");
    expect(b.h.lastText()).toBe("Сездә хәзер сәгать ничә? Шулай сәгать поясыгызны белермен.\n<i>Үз вариантыгыз булмаса, вакытны языгыз, мәсәлән 14:35.</i>");
    const zone = await b.press("ob:tz:300");
    expect(zone.calls[0]!.payload.text).toBe("Әзер! Кабатлыйсы яки яңа сүзләр булса, көн саен искә төшерермен. Вакыты: <b>21:00</b> (UTC+5). Аны /settings командасы белән үзгәртеп була.\n\nБеренче сүз — астарак ↓");
    expect(await b.user()).toMatchObject({ onboardingStep: null, remindAt: "21:00", tzOffsetMin: 300 });
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
    expect(b.h.lastText()).toBe(CARD_RU(1));
    const late = await b.press("ob:n1");
    edited(late);
    expect(late.calls[0]!.payload).toMatchObject({ text: CARD_RU(1), reply_markup: { inline_keyboard: [[{ callback_data: "pr:s1:1" }, { callback_data: "pr:s1:2" }], [{ callback_data: "pr:s1:3" }, { callback_data: "pr:s1:4" }], [{ text: "Пропустить", callback_data: "ob:n2" }]] } });
    expect(late.toast).toBe(ru.chooseAbove);
    expect((await b.user()).onboardingStep).toBe("practice");
    // Two taps that arrive together both show the practice card.
    await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: "intro1" });
    const before = b.h.tg.calls.length;
    await Promise.all([b.h.press("ob:n1", 100), b.h.press("ob:n1", 100)]);
    expect(b.h.tg.calls.slice(before).filter((c) => c.method === "editMessageText").map((c) => c.payload.text)).toEqual([CARD_RU(1), CARD_RU(1)]);
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
    expect(await again()).toEqual([CARD_RU(1), keys(LABELS_RU, 1, SKIP_RU)]);
    // The word reached lives in the message: a card sent again starts from the first word.
    await b.press("pr:s1:3", 100);
    expect(await again()).toEqual([CARD_RU(1), keys(LABELS_RU, 1, SKIP_RU)]);
    await b.press("ob:n2", 100);
    expect(await again()).toEqual([ru.obLevels, LEVELS_RU(true, false)]);
    await b.press("ob:go", 100);
    expect(await again()).toEqual([ru.obRemindQ, [["08:00", "ob:08:00"], ["09:00", "ob:09:00"], ["12:00", "ob:12:00"], ["19:00", "ob:19:00"], ["21:00", "ob:21:00"]]]);
    await b.press("ob:12:00", 100);
    expect(await again()).toEqual([ru.obTzQ, [["08:00", "ob:tz:120"], ["09:00", "ob:tz:180"], ["10:00", "ob:tz:240"], ["11:00", "ob:tz:300"], ["13:00", "ob:tz:420"], ["16:00", "ob:tz:600"]]]);
    await b.press("ob:tz:180", 100);
    await b.text("/start");
    expect(b.h.lastText()).toBe(ru.alreadySetUp);
  });

  it("two time zones at once finish once: one card, and the other tap is answered as a stale button", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    for (const answer of ["ob:ru", "ob:n1", "ob:n2", "ob:go", "ob:09:00"]) await b.press(answer);
    const before = b.h.tg.calls.length;
    await Promise.all([b.h.press("ob:tz:180", 100), b.h.press("ob:tz:240", 100)]);
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
    for (const answer of ["ob:go", "ob:09:00"]) await b.press(answer, 100);
    const zone = await b.press("ob:tz:180", 100);
    expect(zone.methods).toEqual(["editMessageText", "answerCallbackQuery", "sendMessage"]);
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
      // On the hour an old button of an hour is an answer, as the buttons of the step are; on the zone even that is not.
      const steps: [answer: string, foreign: string[], old: string[]][] = [
        ["ob:ru", ["ob:ru", "ob:n2", "ob:next", "ob:go", "ob:lv:1"], OLD], ["ob:n1", ["ob:tt", "ob:n1", "ob:next", "ob:go"], OLD], ["ob:n2", ["ob:ru", "ob:n1", "ob:n2", "ob:next", "ob:lv:9"], OLD],
        ["ob:go", ["ob:ru", "ob:n2", "ob:go", "ob:lv:1", "ob:09:30", "ob:tz:240"], ["ob:1", "ob:0", "ob:10", "ob:180"]], ["ob:09:00", ["ob:ru", "ob:go", "ob:lv:1", "ob:21:00", "ob:tz:60", "ob:tz:330"], OLD],
      ];
      for (const [answer, foreign, old] of steps) {
        await b.press(answer, 100);
        const user = await b.user();
        const screen = renderOnboarding(await startOnboarding(repo, user, T), "ru");
        // Message 77 is an old message of the introduction, with buttons this step does not have.
        for (const data of [...old, ...foreign]) {
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
        // A button, «▶ Учить» of an old message among them, is answered in the tap: no message is sent, and the button does not keep spinning.
        for (const data of ["hub", "lv:t:2", "learn"]) {
          const u = await b.press(data, 100);
          expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.chooseAbove]]);
          expect(u.d1, data).toBe(1);
        }
        // «Показать обучение заново» and its two screens are gone: their buttons in old messages are buttons the bot no longer has, here as after the introduction.
        for (const data of ["set:tut", "tut:2", "tut:ok", "tut:", "tut:9"]) {
          const u = await b.press(data, 100);
          expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
          expect(u.d1, data).toBe(1);
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

    it("on the time-zone step the time typed is the answer: «Готово» and the first card as new messages; other text is answered with why it was not taken, and the question is not sent again", async () => {
      await catalog(env.DB);
      const b = bot();
      await b.text("/start");
      for (const answer of ["ob:ru", "ob:n1", "ob:n2", "ob:go", "ob:19:00"]) await b.press(answer, 100);
      const user = await b.user();
      // 06:00 UTC: 07:00 is UTC+1 and 01:00 is UTC−5, zones the bot does not have.
      const answers: [typed: string, reply: string][] = [
        ["рәхмәт", ru.obTimeUnclear], ["в 14:35", ru.obTimeUnclear], ["25:00", ru.obTimeUnclear], ["UTC+1", ru.obTimeUnclear],
        ["07:00", ru.obZoneMissing], ["01:00", ru.obZoneMissing], ["/learn", ru.chooseAbove],
      ];
      for (const [typed, reply] of answers) {
        const u = await b.text(typed);
        expect(u.calls.map((c) => [c.method, c.payload.text]), typed).toEqual([["sendMessage", reply]]);
        expect(u.calls[0]!.payload.reply_markup, typed).toBeUndefined();
      }
      expect(await b.user()).toEqual(user);
      expect([ru.obTimeUnclear, ru.obZoneMissing]).toEqual(["Не понял время. Напишите, например, 14:35, или выберите кнопку.", "Такого часового пояса в боте нет — выберите ближайший кнопкой."]);
      // In Tatar the same answers.
      await new Repo(env.DB).updateUser(user.id, { lang: "tt" });
      expect((await b.text("рәхмәт")).calls.map((c) => c.payload.text)).toEqual([tt.obTimeUnclear]);
      expect((await b.text("07:00")).calls.map((c) => c.payload.text)).toEqual([tt.obZoneMissing]);
      await new Repo(env.DB).updateUser(user.id, { lang: "ru" });
      // 06:00 UTC: 11:00 is UTC+5.
      const typed = await b.text("11:00");
      expect(typed.methods).toEqual(["sendMessage", "sendMessage"]);
      expect(typed.calls[0]!.payload.text).toBe("Готово! Каждый день в <b>19:00</b> (UTC+5) пришлю напоминание, если есть что повторить или ждут новые слова. Время можно поменять в /settings.\n\nПервое слово — ниже ↓");
      expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
      expect(await b.user()).toMatchObject({ onboardingStep: null, remindAt: "19:00", tzOffsetMin: 300, nextDailyAt: nextOccurrence(300, "19:00", T) });
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

    it("a learner who stood on «Уровни» (or in the middle of the old introduction) goes on through the reminder hour and the time zone: «Знаю» shows that step, «Начать» asks the hour", async () => {
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
      edited(await b.press("ob:go", 55), 55);
      expect(b.h.lastText()).toBe(tt.obRemindQ);
      await b.press("ob:08:00", 55);
      await b.press("ob:tz:180", 55);
      expect(b.h.lastText().startsWith(`${tt.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
      // The step said 10 words a day; the hour and the zone are the ones chosen.
      expect(await b.user()).toMatchObject({ onboardingStep: null, hintsSeen: HINT.update, newPerDay: 10, remindAt: "08:00", tzOffsetMin: 180 });
    });

    it.each(["placement", "goal", "remind", "tz"])("a step of the old introduction left in the row (%s) is the language step: no update fails, and the learner goes on", async (stored) => {
      await catalog(env.DB);
      const b = bot();
      await b.text("/start");
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: stored, onboardingData: JSON.stringify({ i: 3, known: 2 }) });
      for (const data of ["ob:1", "ob:10", "ob:09:00", "ob:180", "ob:tz:180", "ob:n1", "ob:n2", "ob:go"]) {
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
  it("the practice is three cards: китап, су, әни; each press sends the next as a new message in place of the old one, reads the database once and writes nothing", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    expect(before.users).toHaveLength(1);
    expect([before.cards, before.review_log, before.sessions, before.user_progress]).toEqual([[], [], [], []]);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(1), keys(LABELS_RU, 1, SKIP_RU)]);

    // A revealed spoiler stays revealed in an edited message: the translation of су must not stand open, so its card is a message of its own.
    const good = await b.press("pr:s1:3");
    replaced(good, 100);
    expect(good.calls[0]!.payload.message_id).toBeUndefined();
    expect(good.toast).toBeUndefined();
    expect(good.d1).toBe(1);
    expect(await held()).toEqual(before);
    expect(b.h.lastText()).toBe(CARD_RU(2, 3));
    for (const part of ["Тренировка · слово 2 из 3", "<b>су</b>", "<tg-spoiler><b>вода</b></tg-spoiler>"]) expect(b.h.lastText()).toContain(part);
    // The explanation of the press stands above the next card.
    expect(b.h.lastText().indexOf(EXPLAINED_RU[3]!)).toBeLessThan(b.h.lastText().indexOf("🎓"));
    expect(buttons(b.h.lastMarkup())).toEqual(keys(LABELS_RU, 2, SKIP_RU));

    const again = await b.step("pr:s2:1");
    expect(again.d1).toBe(1);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(3, 1), keys(LABELS_RU, 3, SKIP_RU)]);
    expect(b.h.lastText()).toContain("<b>әни</b>\n<tg-spoiler><b>мама</b></tg-spoiler>");

    const easy = await b.step("pr:s3:4");
    expect(easy.d1).toBe(1);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([FINAL_RU(4), [NEXT_RU]]);
    expect(await held()).toEqual(before);
  });

  it("each button's explanation names its own interval; «Снова» has «через 1 минуту»", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    for (const rating of RATINGS) {
      // The data of a button carries all the card needs: the same button gives the same screen whatever stood before.
      await b.step(`pr:s1:${rating}`);
      expect(b.h.lastText()).toBe(CARD_RU(2, rating));
      expect(b.h.lastText().startsWith(`${EXPLAINED_RU[rating]}\n\n`)).toBe(true);
      await b.step(`pr:s3:${rating}`);
      expect(b.h.lastText()).toBe(FINAL_RU(rating));
    }
    // The button reads «1 минута»; after «через» the explanation has «1 минуту».
    expect(EXPLAINED_RU[1]).toContain("через 1 минуту и начало бы лесенку заново.");
    expect(b.h.tg.calls.some((c) => String(c.payload.text ?? "").includes("через 1 минута"))).toBe(false);
    expect(await held()).toEqual(before);
  });

  it("a press of an old practice button of the four-button card shows the practice from its first word", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    for (const data of ["pr:0:3", "pr:15:2", "pr:5:1"]) {
      await b.step("pr:s1:3");
      // The old card may have its translation of китап revealed: the first word comes as a new message too.
      const old = await b.step(data);
      expect([old.toast, old.d1], data).toEqual([undefined, 1]);
      expect([b.h.lastText(), buttons(b.h.lastMarkup())], data).toEqual([CARD_RU(1), keys(LABELS_RU, 1, SKIP_RU)]);
    }
    expect(await held()).toEqual(before);
  });

  it("a double tap shows the same screen again, and writes nothing", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const first = await b.press("pr:s1:3", 100);
    const before = await held();
    // The second tap comes from the message the first one removed: the same screen, again in a message of its own.
    const twice = await b.press("pr:s1:3", 100);
    replaced(twice, 100);
    expect(twice.calls[0]!.payload).toEqual(first.calls[0]!.payload);
    expect(twice.toast).toBeUndefined();
    expect(twice.d1).toBe(1);
    expect(b.h.lastText()).toBe(CARD_RU(2, 3));
    expect(await held()).toEqual(before);
  });

  it("a message Telegram cannot delete loses its buttons; nothing fails", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    b.h.tg.failNext("deleteMessage", 400, "Bad Request: message can't be deleted for everyone");
    const sent = b.h.tg.calls.length;
    await b.h.press("pr:s1:3", 100);
    const calls = b.h.tg.calls.slice(sent);
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "editMessageReplyMarkup", "answerCallbackQuery"]);
    expect(calls[2]!.payload).toMatchObject({ message_id: 100 });
    expect(calls[2]!.payload.reply_markup).toBeUndefined();
    expect(calls[0]!.payload).toMatchObject({ text: CARD_RU(2, 3) });
  });

  it("every way through the three words ends on the final screen with «Дальше»; each press is one read and writes nothing", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const before = await held();
    expect(RUNS).toHaveLength(64);
    for (const run of RUNS) {
      // /start on the step sends the card again, from the first word.
      await b.text("/start");
      for (const [i, rating] of run.entries()) {
        const data = buttons(b.h.lastMarkup()).find(([, d]) => d!.endsWith(`:${rating}`))![1]!;
        expect(data, run.join("")).toBe(`pr:s${i + 1}:${rating}`);
        const u = await b.step(data);
        expect(u.d1, run.join("")).toBe(1);
        if (i < 2) expect([b.h.lastText(), buttons(b.h.lastMarkup())], run.join("")).toEqual([CARD_RU(i + 2, rating), keys(LABELS_RU, i + 2, SKIP_RU)]);
      }
      expect([b.h.lastText(), buttons(b.h.lastMarkup())], run.join("")).toEqual([FINAL_RU(run[2]!), [NEXT_RU]]);
    }
    expect(await held()).toEqual(before);
    edited(await b.press("ob:n2"), b.h.tg.lastMessageId());
    expect(b.h.lastText()).toBe(ru.obLevels);
    expect((await b.user()).onboardingStep).toBe("levels");
  });

  it("«Пропустить» on any word goes to the levels, and so does «Дальше» of the final screen", async () => {
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

    for (const pressed of [["pr:s1:2"], ["pr:s1:2", "pr:s2:3"], ["pr:s1:2", "pr:s2:3", "pr:s3:1"]]) {
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: "practice" });
      for (const data of pressed) await b.step(data);
      expect(buttons(b.h.lastMarkup()).at(-1), pressed.join()).toEqual(pressed.length === 3 ? NEXT_RU : SKIP_RU);
      edited(await b.press("ob:n2"), b.h.tg.lastMessageId());
      expect(b.h.lastText(), pressed.join()).toBe(ru.obLevels);
    }
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
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(1), keys(LABELS_RU, 1, SKIP_RU)]);
    const row = await b.user();
    // The card is the introduction's for this learner: its last row is «Пропустить».
    await b.step("pr:s1:4");
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(2, 4), keys(LABELS_RU, 2, SKIP_RU)]);
    // An answer the step does not take shows the practice card, as on the step `practice`.
    const stray = await b.press("ob:n1", 77);
    expect(stray.calls[0]!.payload).toMatchObject({ message_id: 77, text: CARD_RU(1) });
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
    ["a button of a practice card", "tap", "pr:s2:3"],
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

  it("sends the screen about the bot with «Попробовать»; then the three cards of the practice and the final screen end with «▶ Учить»; the whole run writes nothing", async () => {
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
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(1), keys(LABELS_RU, 1, LEARN_RU)]);
    expect((b.h.lastMarkup().inline_keyboard ?? []).map((row) => row.length)).toEqual([2, 2, 1]);

    for (const [i, rating] of [2, 4, 3].entries()) {
      const u = await b.step(`pr:s${i + 1}:${rating}`);
      expect(u.d1).toBe(1);
      if (i < 2) expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(i + 2, rating), keys(LABELS_RU, i + 2, LEARN_RU)]);
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
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_TT(1), keys(LABELS_TT, 1, ["▶ Өйрәнү", "learn"])]);
    for (const data of ["pr:s1:1", "pr:s2:2", "pr:s3:4"]) await b.step(data);
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
    const late = await b.press("pr:s1:1", 100);
    replaced(late, 100);
    expect(late.d1).toBe(1);
    // The card is the replay's: «▶ Учить» in place of «Пропустить».
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(2, 1), keys(LABELS_RU, 2, LEARN_RU)]);
    // A button of the old four-button card, in another old message, starts the replay again from the first word.
    replaced(await b.press("pr:4:1", 77), 77);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([CARD_RU(1), keys(LABELS_RU, 1, LEARN_RU)]);
    for (const data of ["pr:s1:1", "pr:s2:2", "pr:s3:4"]) await b.step(data);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([FINAL_RU(4), [LEARN_RU]]);

    for (const data of ["ob:n2", "ob:n1"]) {
      const stale = await b.press(data, 100);
      expect(stale.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
      expect(stale.d1).toBe(1);
    }
    expect(await held()).toEqual(before);
    expect((await b.user()).onboardingStep).toBeNull();
  });

  it("on a step of the introduction other than the practice, a practice button of an older message is no replay: its message becomes the screen of the step, and nothing is written", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    await b.press("ob:ru");
    const screens: Record<string, [text: string, keyboard: string[][], d1: number]> = {
      // D1 calls: the user; the step «Уровни» also reads the counters of the levels for its screen.
      intro1: [ABOUT_RU, [["Попробовать", "ob:n1"]], 1],
      levels: [ru.obLevels, LEVELS_RU(true, false), 2],
    };
    for (const [step, [text, keyboard, d1]] of Object.entries(screens)) {
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: step });
      const before = await held();
      // Message 77 is a practice card sent earlier (a /start on the practice step), or the «Как это работает» of another time.
      for (const data of ["pr:start", "pr:0:3", "pr:7:4", "pr:15:1", "pr:s1:3", "pr:s3:4"]) {
        const u = await b.press(data, 77);
        edited(u, 77);
        expect([b.h.lastText(), buttons(b.h.lastMarkup())], `${step} ${data}`).toEqual([text, keyboard]);
        expect([u.toast, u.d1], `${step} ${data}`).toEqual([ru.chooseAbove, d1]);
      }
      expect(await held()).toEqual(before);
    }
    // No message of this run offered «▶ Учить», which opens nothing during the introduction.
    expect(b.h.tg.calls.filter((c) => JSON.stringify(c.payload.reply_markup ?? "").includes('"learn"'))).toEqual([]);
  });

  it("«Пропустить» and then a grade button of the same message: the levels stay on screen, and the introduction goes on from them", async () => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    edited(await b.press("ob:n2", 100));
    expect(b.h.lastText()).toBe(ru.obLevels);
    const before = await held();
    // The tap on «Хорошо» was made while the card was still on screen and arrives after the step has changed.
    const late = await b.press("pr:s1:3", 100);
    edited(late, 100);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([ru.obLevels, LEVELS_RU(true, false)]);
    expect([late.toast, late.d1]).toEqual([ru.chooseAbove, 2]);
    expect(await held()).toEqual(before);
    expect((await b.user()).onboardingStep).toBe("levels");
    // The message is still the step: a level is checked in it, and «Начать» gives the first card.
    edited(await b.press("ob:lv:2", 100));
    expect(buttons(b.h.lastMarkup())).toEqual(LEVELS_RU(true, true));
    for (const answer of FINISH) await b.press(answer, 100);
    expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
  });

  it.each([["«Пропустить» first", ["ob:n2", "pr:s1:3"]], ["the grade button first", ["pr:s1:3", "ob:n2"]]])("«Пропустить» and a grade button that arrive together (%s): the learner is on the levels, and the message is the levels or the introduction's card, never a replay", async (_order, pair) => {
    await catalog(env.DB);
    const b = bot();
    await atPractice(b);
    const sent = b.h.tg.calls.length;
    await Promise.all(pair.map((data) => b.h.press(data, 100)));
    const calls = b.h.tg.calls.slice(sent);
    // Each of the two updates answered its tap once, and the message 100 shows the levels or was replaced by the next card.
    expect(calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "editMessageText").length).toBeGreaterThanOrEqual(1);
    expect((await b.user()).onboardingStep).toBe("levels");
    expect(await held()).toMatchObject({ cards: [], review_log: [], sessions: [], user_progress: [] });
    const shown = [b.h.lastText(), buttons(b.h.lastMarkup())];
    // Whichever screen came last, it leads on: the levels, or the card with «Пропустить», whose tap now shows the levels.
    expect([[ru.obLevels, LEVELS_RU(true, false)], [CARD_RU(2, 3), keys(LABELS_RU, 2, SKIP_RU)]]).toContainEqual(shown);
    if (shown[0] !== ru.obLevels) {
      const card = b.h.tg.lastMessageId();
      const skip = await b.press("ob:n2", card);
      edited(skip, card);
      expect(skip.toast).toBe(ru.chooseAbove);
    }
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([ru.obLevels, LEVELS_RU(true, false)]);
    for (const answer of FINISH) await b.press(answer, 100);
    expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
  });

  it("«▶ Учить» of an old message pressed during the introduction is answered in the tap; /learn typed there is answered with a message, as before", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    await b.press("ob:ru");
    for (const step of ["intro1", "practice", "intro2", "levels"]) {
      await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: step });
      const row = await b.user();
      const tap = await b.press("learn", 77);
      expect(tap.calls.map((c) => [c.method, c.payload.text]), step).toEqual([["answerCallbackQuery", ru.chooseAbove]]);
      expect(tap.d1, step).toBe(1);
      for (const typed of ["/learn", "/undo", "/levels", "/settings", "/stats", "/gen кунакта", "/howto"]) {
        const u = await b.text(typed);
        expect(u.calls.map((c) => [c.method, c.payload.text]), `${step} ${typed}`).toEqual([["sendMessage", ru.chooseAbove]]);
      }
      expect(await b.user()).toEqual(row);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first<{ n: number }>())!.n).toBe(0);
  });

  it("/howto with the bot's name, and with words after it, is the command: the screen about the bot, and no word is looked up", async () => {
    await studying();
    const before = await held();
    const b = bot();
    // Telegram marks the name of the bot as a part of the command.
    for (const [typed, length] of [["/howto@povtor_bot", 17], ["/howto китап", 6], ["/howto@povtor_bot китап вакыт", 17], ["/howto https://example.com/a китап", 6]] as const) {
      const u = await b.text(typed, [{ type: "bot_command", offset: 0, length }]);
      expect(u.calls.map((c) => [c.method, c.payload.text]), typed).toEqual([["sendMessage", ABOUT_RU]]);
      expect(buttons(b.h.lastMarkup()), typed).toEqual([["Попробовать", "pr:start"]]);
      expect(u.d1, typed).toBe(1);
    }
    expect(before.previews).toEqual([]);
    expect(await held()).toEqual(before);
    expect(b.h.tg.calls.filter((c) => c.payload.text === ru.searching)).toEqual([]);
  });

  it("data that is no practice button is answered as a stale button", async () => {
    await studying();
    const before = await held();
    const b = bot();
    for (const data of ["pr:16:1", "pr:3:5", "pr:x:1", "pr:3", "pr:3:1:1", "pr:", "pr:go", "pr:s4:1", "pr:s0:1", "pr:s1:5", "pr:s1", "pr:s1:1:1"]) {
      const u = await b.press(data, 100);
      expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
      expect(u.d1, data).toBe(1);
    }
    expect(await held()).toEqual(before);
  });

  it("«Показать обучение заново» is gone: after the introduction its buttons in old messages are answered as stale, and nothing is written, the hints among it", async () => {
    await studying();
    const before = await held();
    const b = bot();
    for (const data of ["set:tut", "tut:2", "tut:ok", "tut:", "tut:9"]) {
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
      expect(renderOnboarding({ kind: "practice" }, lang)).toEqual(renderPractice(1, null, lang, false));
      for (const next of [1, 2, 3, 4] as const) {
        for (const last of [null, 1, 2, 3, 4] as const) {
          const [intro, replay] = [renderPractice(next, last, lang, false), renderPractice(next, last, lang, true)];
          expect(replay.text, `${lang} ${next} ${last}`).toBe(intro.text);
          expect(replay.keyboard.slice(0, -1)).toEqual(intro.keyboard.slice(0, -1));
          expect(intro.keyboard.at(-1)!.map((x) => x.callback_data)).toEqual(["ob:n2"]);
          expect(replay.keyboard.at(-1)).toEqual([{ text: d.learnBtn, callback_data: "learn", style: "primary" }]);
          expect(intro.keyboard.at(-1)![0]!.text).toBe(next === 4 ? d.nextBtn : d.skipBtn);
          // The final screen has no grade button; before it there are always the four, of the word on the card.
          const grades = intro.keyboard.flat().filter((x) => x.callback_data.startsWith("pr:")).map((x) => x.callback_data);
          expect(grades).toEqual(next === 4 ? [] : RATINGS.map((r) => `pr:s${next}:${r}`));
        }
      }
    }
    expect(renderPractice(1, null, "ru", false).text).toBe(CARD_RU(1));
    expect(renderPractice(4, null, "ru", true).text).toBe(DONE_RU);
    expect(renderPractice(4, null, "tt", true).text).toBe(DONE_TT);
    for (const last of RATINGS) {
      for (const next of [2, 3] as const) {
        expect(renderPractice(next, last, "ru", false).text).toBe(CARD_RU(next, last));
        expect(renderPractice(next, last, "tt", false).text).toBe(CARD_TT(next, last));
      }
      expect(renderPractice(4, last, "ru", false).text).toBe(FINAL_RU(last));
      expect(renderPractice(4, last, "tt", false).text).toBe(`${EXPLAINED_TT[last]}\n\n${DONE_TT}`);
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
    for (const data of ["pr:s1:1", "pr:s2:2", "pr:s3:3"]) await b.step(data);
    for (const answer of ["ob:n2", ...FINISH]) await b.press(answer);
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
