import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderIntro, renderOnboarding } from "../../src/bot/screens";
import { renderLead } from "../../src/bot/views";
import { Repo, type User } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { formatInterval } from "../../src/srs/fsrs";
import { HINT } from "../../src/tutorial/hints";
import { nextOccurrence, startOnboarding } from "../../src/users/service";
import { harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { recountProgress, seedCatalog, seedGuidedOrder, seedLearner, seedTopics } from "../helpers/seed";

/** 06:00 UTC: 09:00 in Moscow. */
const T = Date.UTC(2026, 8, 30, 6);
type Markup = { inline_keyboard?: { text: string; callback_data: string }[][] };
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
   * button showed, and `given`, the interval the grade gave the card, written the same way. They are the same but for
   * an interval of days, which the scheduler moves a little (its fuzz): «8д» on the button may be «9д» for the card.
   * A hint names the interval of the button.
   */
  const grade = async (rating: 1 | 2 | 3 | 4) => {
    const button = (h.lastMarkup().inline_keyboard ?? []).flat().find((b) => new RegExp(`^g:\\d+:\\d+:${rating}$`).test(b.callback_data))!;
    const u = await press(button.callback_data);
    const card = (await env.DB.prepare("SELECT c.due, u.lang FROM cards c JOIN users u ON u.id = c.user_id WHERE c.id = ?").bind(Number(button.callback_data.split(":")[1])).first<{ due: number; lang: "ru" | "tt" }>())!;
    return { ...u, shown: button.text.split(" ")[1]!, given: formatInterval(card.due - T, card.lang) };
  };
  const user = async () => (await new Repo(env.DB).getUserByTg(42))!;
  return { h, text: (s: string) => update(() => h.text(s)), press, grade, user };
}
/** The update changed the message in place and answered the tap: nothing was sent. */
const edited = (u: { calls: { method: string; payload: Record<string, unknown> }[]; methods: string[] }, messageId = 100) => {
  expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
  expect(u.calls[0]!.payload.message_id).toBe(messageId);
};

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

/** Goes through the introduction in Russian up to the first card, with the levels as they are checked at first: A1. */
async function introduced(b: ReturnType<typeof bot>) {
  await b.text("/start");
  for (const answer of ["ob:ru", "ob:n1", "ob:n2", "ob:go"]) await b.press(answer, 100);
}

describe("the introduction", () => {
  it("/start → the language → two screens → the levels → «Начать»: the first real card, with the hint of the first card", async () => {
    await catalog(env.DB);
    const b = bot();
    const start = await b.text("/start");
    expect(start.methods).toEqual(["sendMessage"]);
    expect(b.h.lastText()).toBe(ru.welcome);
    expect(buttons(b.h.lastMarkup())).toEqual([["Русский", "ob:ru"], ["Татарча", "ob:tt"]]);

    const lang = await b.press("ob:ru");
    edited(lang);
    expect(b.h.lastText()).toBe("Кабатла учит татарские слова карточками. Слово возвращается тогда, когда вы начинаете его забывать: сначала через минуты, потом через дни и месяцы. Так оно остаётся в памяти надолго.");
    expect(buttons(b.h.lastMarkup())).toEqual([["Дальше", "ob:n1"]]);
    expect(await b.user()).toMatchObject({ lang: "ru", onboardingStep: "intro1" });

    const first = await b.press("ob:n1");
    edited(first);
    expect(b.h.lastText()).toBe("Карточка: сверху слово, перевод и пример скрыты. Вспомните перевод, нажмите на скрытый текст и честно оцените себя одной из четырёх кнопок. На каждой кнопке написано, когда слово вернётся.");
    expect(buttons(b.h.lastMarkup())).toEqual([["Дальше", "ob:n2"]]);
    expect((await b.user()).onboardingStep).toBe("intro2");

    const second = await b.press("ob:n2");
    edited(second);
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
    expect(buttons(b.h.lastMarkup()).slice(0, 4).map(([, data]) => data)).toEqual([expect.stringMatching(/^g:\d+:0:1$/), expect.stringMatching(/:2$/), expect.stringMatching(/:3$/), expect.stringMatching(/:4$/)]);
    expect(await b.user()).toMatchObject({
      onboardingStep: null, hintsSeen: HINT.update, levels: 0b1, posGroups: 255, newMode: "guided", topicNo: null, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180,
      nextDailyAt: nextOccurrence(180, "09:00", T), nextEveningAt: nextOccurrence(180, "20:00", T),
    });
    // D1 calls: the user; the step, and for «Уровни» the counters of the levels; the finish is the user, the guarded
    // write, the user again, the queue, its read positions, the new card and the session.
    expect([start.d1, lang.d1, first.d1, second.d1, go.d1]).toEqual([3, 2, 2, 3, 7]);
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

  it("is in Tatar for a learner who chose it: the screens, the levels and the hint of the first card", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    edited(await b.press("ob:tt"));
    expect(b.h.lastText()).toBe(tt.intro1);
    expect(buttons(b.h.lastMarkup())).toEqual([["Алга таба", "ob:n1"]]);
    await b.press("ob:n1");
    expect(b.h.lastText()).toBe(tt.intro2);
    expect(buttons(b.h.lastMarkup())).toEqual([["Алга таба", "ob:n2"]]);
    await b.press("ob:n2");
    expect(b.h.lastText()).toBe(tt.obLevels);
    expect(buttons(b.h.lastMarkup())).toEqual([
      ["☑ A1 · 5 сүз · текстның ≈45 %", "ob:lv:1"], ["☐ A2 · 1 сүз", "ob:lv:2"], ["☐ B1 · тиздән", "ob:lv:3"], ["☐ B2 · тиздән", "ob:lv:4"], ["☐ C1 · тиздән", "ob:lv:5"], ["Башлау", "ob:go"],
    ]);
    await b.press("ob:go");
    expect(b.h.lastText().startsWith(`${tt.hintFront}\n\n${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    const good = await b.grade(3);
    expect(b.h.lastText().startsWith(`„Яхшы“: сүз кайтканчы &lt;10мин бар. Аны тагын искә төшерсәгез, аралык үсәчәк: көннәр, аннары атналар һәм айлар.\n${tt.hintOrder}\n\n🔵 9 · 🔴 1 · 🟢 0\n<b>мин</b>\n`)).toBe(true);
    expect([good.shown, good.given]).toEqual(["<10мин", "<10мин"]);
  });

  it("a second tap on «Дальше» of the first screen does not skip the second: it stays, and the tap is answered like any answer the step does not take", async () => {
    await catalog(env.DB);
    const b = bot();
    await b.text("/start");
    await b.press("ob:ru");
    edited(await b.press("ob:n1"));
    expect(b.h.lastText()).toBe(ru.intro2);
    const late = await b.press("ob:n1");
    edited(late);
    expect(late.calls[0]!.payload).toMatchObject({ text: ru.intro2, reply_markup: { inline_keyboard: [[{ text: "Дальше", callback_data: "ob:n2" }]] } });
    expect(late.toast).toBe(ru.chooseAbove);
    expect((await b.user()).onboardingStep).toBe("intro2");
    // Two taps that arrive together both show the second screen.
    await new Repo(env.DB).updateUser((await b.user()).id, { onboardingStep: "intro1" });
    const before = b.h.tg.calls.length;
    await Promise.all([b.h.press("ob:n1", 100), b.h.press("ob:n1", 100)]);
    expect(b.h.tg.calls.slice(before).filter((c) => c.method === "editMessageText").map((c) => c.payload.text)).toEqual([ru.intro2, ru.intro2]);
    expect((await b.user()).onboardingStep).toBe("intro2");
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
    expect(await again()).toEqual([ru.intro1, [["Дальше", "ob:n1"]]]);
    await b.press("ob:n1", 100);
    expect(await again()).toEqual([ru.intro2, [["Дальше", "ob:n2"]]]);
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
        for (const typed of ["14:35", "рәхмәт", "/learn", "/levels", "/settings", "/stats", "/undo"]) {
          const u = await b.text(typed);
          expect(u.calls.map((c) => [c.method, c.payload.text]), typed).toEqual([["sendMessage", ru.chooseAbove]]);
        }
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

/*
 * Every learner starts again with the levels A1–C1, and the first thing a returning learner does is seldom /start: a
 * button of an old message, /learn, a word. The bot knows nobody yet, so whatever comes is answered with the language
 * screen, as a new message.
 */
describe("a learner who has not chosen a language yet", () => {
  const LANG_SCREEN = { text: ru.welcome, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Русский", callback_data: "ob:ru" }, { text: "Татарча", callback_data: "ob:tt" }]] } };
  const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  /** What the bot holds of learners: the rows of the users, and everything a learner's action could have made. */
  const held = async () => Object.fromEntries(await Promise.all(["users", "cards", "sessions", "previews", "review_log", "decks WHERE kind <> 'catalog'"].map(async (t) => [t.split(" ")[0]!, await count(t)])));
  const NOTHING_BUT_THE_ROW = { users: 1, cards: 0, sessions: 0, previews: 0, review_log: 0, decks: 0 };
  /** A new learner as the bot stores one before any answer. */
  const NEW_ROW = { onboardingStep: "lang", lang: "ru", levels: 0b1, newPerDay: 10, remindAt: "09:00", retention: 0.9, direction: "tt_ru", autoplay: false, pendingEdit: null };
  /** One message, the language screen, sent and not edited; a tap is answered after it, with no words. */
  const languageScreen = (u: Awaited<ReturnType<ReturnType<typeof bot>["press"]>>, tap: boolean, why: string) => {
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
    expect(await held()).toEqual(NOTHING_BUT_THE_ROW);
    expect(await b.user()).toMatchObject(NEW_ROW);

    // The same once more, before a language is chosen: the screen again, and nothing else.
    const second = kind === "tap" ? await b.press(update, 77) : await b.text(update);
    languageScreen(second, kind === "tap", what);
    expect(second.d1).toBe(1);
    expect(await held()).toEqual(NOTHING_BUT_THE_ROW);
    expect(await b.user()).toMatchObject(NEW_ROW);

    // «Русский» of the screen sent last goes on as it does after /start: the first screen about the bot, in that message.
    const screen = b.h.tg.lastMessageId();
    const chosen = await b.press("ob:ru", screen);
    edited(chosen, screen);
    expect(b.h.lastText()).toBe(ru.intro1);
    expect(buttons(b.h.lastMarkup())).toEqual([["Дальше", "ob:n1"]]);
    expect(await b.user()).toMatchObject({ ...NEW_ROW, onboardingStep: "intro1" });
    expect(await held()).toEqual(NOTHING_BUT_THE_ROW);
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
    expect(await held()).toEqual(NOTHING_BUT_THE_ROW);
    // The first screen of all, sent by /start, still takes the answer.
    edited(await b.press("ob:tt", 100), 100);
    expect(b.h.lastText()).toBe(tt.intro1);
    expect(await b.user()).toMatchObject({ lang: "tt", onboardingStep: "intro1" });
  });
});

describe("hints", () => {
  it("each button says once, above the next card, when the word comes back; the first of them adds the order of a session", async () => {
    await catalog(env.DB);
    const b = bot();
    await introduced(b);
    const startsWith = (lead: string, word: string) => expect(b.h.lastText().split(`\n<b>${word}</b>\n`)[0]!.replace(/🔵.*$/, ""), b.h.lastText()).toBe(lead ? `${lead}\n\n` : "");
    startsWith(ru.hintFront, "сәлам");
    expect((await b.user()).hintsSeen).toBe(HINT.update);

    const good = await b.grade(3);
    expect(good.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect([good.shown, good.given]).toEqual(["<10м", "<10м"]);
    startsWith("„Хорошо“: слово вернётся через &lt;10м. Вспомните его снова — интервал вырастет: дни, потом недели и месяцы.\nПорядок в занятии: сначала слова на закреплении, потом повторения на сегодня, между ними новые слова.", "мин");
    expect((await b.user()).hintsSeen).toBe(HINT.update | HINT.front | HINT.good | HINT.order);

    const goodAgain = await b.grade(3);
    startsWith("", "рәхмәт");
    // A hint rides in the message of the card and in the write of the grade: the same calls with it and without.
    expect([good.d1, good.methods]).toEqual([goodAgain.d1, goodAgain.methods]);

    const again = await b.grade(1);
    expect([again.shown, again.given]).toEqual(["<1м", "<1м"]);
    startsWith("„Снова“: слово вернётся через &lt;1м, в этом же занятии, и будет приходить, пока не запомнится.", "син");
    const hard = await b.grade(2);
    expect([hard.shown, hard.given]).toEqual(["<6м", "<6м"]);
    startsWith("„Трудно“: слово вернётся через &lt;6м. Интервалы будут расти медленнее.", "исәнмесез");
    const easy = await b.grade(4);
    // The words of A1 are all started: the card that comes is one that is due again.
    // The button read «Легко 8д»: the hint says 8д, whatever day the scheduler's fuzz gave the card.
    expect(easy.shown).toBe("8д");
    expect(b.h.lastText().startsWith("„Легко“: слово ушло сразу на 8д и не занимает дневную норму новых слов.\n\n🔵 0 · ")).toBe(true);
    expect(easy.given).toMatch(/^\d+д$/);
    expect((await b.user()).hintsSeen).toBe(127);
    // Measured: a grade is 6 D1 calls and 3 Telegram calls here, with a hint or without.
    expect([good.d1, goodAgain.d1, again.d1, hard.d1, easy.d1]).toEqual([6, 6, 6, 6, 6]);
    for (const g of [good, goodAgain, again, hard, easy]) expect(g.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);

    // Every button once more: no hint comes twice, and the update notice never comes to a new learner.
    for (const rating of [1, 2, 3, 4] as const) {
      if (!buttons(b.h.lastMarkup()).some(([, data]) => data!.startsWith("g:"))) break;
      await b.grade(rating);
      expect(b.h.lastText()).toMatch(/^(🔵|✅)/);
    }
    expect((await b.user()).hintsSeen).toBe(127);
    const texts = b.h.tg.calls.map((c) => String(c.payload.text ?? ""));
    for (const hint of ["„Хорошо“", "„Снова“", "„Трудно“", "„Легко“", "Порядок в занятии"]) expect(texts.filter((x) => x.includes(hint)), hint).toHaveLength(1);
    expect(texts.filter((x) => x.includes("Бот обновился"))).toEqual([]);
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

  it("a hint that falls on the screen that ends the session is its first lines", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сәлам", topic: 1 }]);
    const b = bot();
    await introduced(b);
    const easy = await b.grade(4);
    expect(easy.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(b.h.lastText()).toBe([
      `„Легко“: слово ушло сразу на ${easy.shown} и не занимает дневную норму новых слов.`, ru.hintOrder, "",
      ru.doneTitle, ru.doneToday(1, 0), ru.streak(1), "", ru.emptyAllDone,
    ].join("\n"));
    expect(easy.d1).toBeLessThanOrEqual(8);
  });

  it("an undone grade does not bring its hint back", async () => {
    await catalog(env.DB);
    const b = bot();
    await introduced(b);
    await b.grade(3);
    await b.press("u");
    expect(b.h.lastText().startsWith(`${COUNTERS}\n<b>сәлам</b>\n`)).toBe(true);
    await b.grade(3);
    expect(b.h.lastText().startsWith("🔵 9 · 🔴 1 · 🟢 0\n<b>мин</b>\n")).toBe(true);
  });

  it("the texts of the hints, in both languages", () => {
    const lead = (rating: 1 | 2 | 3 | 4, withOrder = false) => ({ kind: "button", rating, interval: "<10м", withOrder }) as const;
    expect([renderLead({ kind: "front" }, "ru"), renderLead({ kind: "update" }, "ru"), ...([1, 2, 3, 4] as const).map((r) => renderLead(lead(r), "ru")), renderLead(lead(3, true), "ru")]).toEqual([
      "Вспомните перевод, откройте скрытый текст и оцените себя.",
      "Бот обновился: уровни A1–C1, темы и порядок слов — в /levels",
      "„Снова“: слово вернётся через &lt;10м, в этом же занятии, и будет приходить, пока не запомнится.",
      "„Трудно“: слово вернётся через &lt;10м. Интервалы будут расти медленнее.",
      "„Хорошо“: слово вернётся через &lt;10м. Вспомните его снова — интервал вырастет: дни, потом недели и месяцы.",
      "„Легко“: слово ушло сразу на &lt;10м и не занимает дневную норму новых слов.",
      "„Хорошо“: слово вернётся через &lt;10м. Вспомните его снова — интервал вырастет: дни, потом недели и месяцы.\nПорядок в занятии: сначала слова на закреплении, потом повторения на сегодня, между ними новые слова.",
    ]);
    const ttLead = (rating: 1 | 2 | 3 | 4, withOrder = false) => ({ ...lead(rating, withOrder), interval: "8көн" });
    expect([renderLead({ kind: "front" }, "tt"), renderLead({ kind: "update" }, "tt"), ...([1, 2, 3, 4] as const).map((r) => renderLead(ttLead(r), "tt")), renderLead(ttLead(1, true), "tt")]).toEqual([
      tt.hintFront, tt.updateNotice, tt.hintAgain("8көн"), tt.hintHard("8көн"), tt.hintGood("8көн"), tt.hintEasy("8көн"), `${tt.hintAgain("8көн")}\n${tt.hintOrder}`,
    ]);
  });
});

describe("a learner who knew the bot before the levels A1–C1", () => {
  /** Every hint counts as seen, the update notice does not (`hintsSeen` 63); «сәлам» is started and comes back in five days. */
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
});

describe("«Показать обучение заново»", () => {
  /** A learner in the middle of A1 and A2, with settings of their own, who has seen every hint and the update notice. */
  async function studying(hintsSeen = 127) {
    await catalog(env.DB);
    const { repo, user } = await seedLearner(env.DB, {
      now: T, tgId: 42,
      patch: { hintsSeen, levels: 0b11, posGroups: 0b1011, newMode: "topic", topicNo: 1, newPerDay: 20, remindAt: "19:00", tzOffsetMin: 300, direction: "both", autoplay: false, retention: 0.95, streak: 4, lastStudyDay: "2026-09-29" },
    });
    const note = (await env.DB.prepare("SELECT id FROM notes WHERE word = 'сәлам'").first<{ id: number }>())!.id;
    await repo.insertCard(user.id, note, "tt_ru", gradedMem(T));
    await recountProgress(env.DB, user.id);
    const state = async () => ({
      cards: (await env.DB.prepare("SELECT * FROM cards ORDER BY id").all()).results,
      progress: (await env.DB.prepare("SELECT * FROM user_progress ORDER BY level, topic_no").all()).results,
      log: (await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>())!.n,
    });
    return { repo, user, state };
  }

  it("is the last row of the settings", async () => {
    await studying();
    const b = bot();
    await b.text("/settings");
    expect(buttons(b.h.lastMarkup()).at(-1)).toEqual(["🎓 Показать обучение заново", "set:tut"]);
    expect(buttons(b.h.lastMarkup()).at(-2)).toEqual(["📚 Уровни, темы, порядок слов", "set:hub"]);
  });

  it("shows the two screens in the message of the settings, «Понятно» is the settings again; only the hints change", async () => {
    const { repo, user, state } = await studying();
    const before = await state();
    const b = bot();
    await b.text("/settings");
    const settings = [b.h.lastText(), buttons(b.h.lastMarkup())];

    const one = await b.press("set:tut");
    edited(one);
    expect(one.d1).toBe(2);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([ru.intro1, [["Дальше", "tut:2"]]]);
    // The update notice was seen and stays seen; every hint comes again.
    expect(await repo.getUser(user.id)).toEqual({ ...user, hintsSeen: HINT.update });
    const two = await b.press("tut:2");
    edited(two);
    expect(two.d1).toBe(1);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([ru.intro2, [["Понятно", "tut:ok"]]]);
    const ok = await b.press("tut:ok");
    edited(ok);
    expect(ok.d1).toBe(1);
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual(settings);
    expect(await repo.getUser(user.id)).toEqual({ ...user, hintsSeen: HINT.update });
    expect(await state()).toEqual(before);
  });

  it("the hints come again: the first card, then each button once", async () => {
    await studying();
    await new Repo(env.DB).updateUser((await new Repo(env.DB).getUserByTg(42))!.id, { direction: "tt_ru", newMode: "guided", topicNo: null, posGroups: 255 });
    const b = bot();
    await b.text("/settings");
    await b.press("set:tut");
    await b.text("/learn");
    expect(b.h.lastText().startsWith(`${ru.hintFront}\n\n🔵 20 · 🔴 0 · 🟢 0\n<b>мин</b>\n`)).toBe(true);
    const good = await b.grade(3);
    expect(b.h.lastText().startsWith(`${ru.hintGood(good.shown.replace("<", "&lt;"))}\n${ru.hintOrder}\n\n🔵 19 · 🔴 1 · 🟢 0\n<b>рәхмәт</b>\n`)).toBe(true);
    await b.grade(3);
    expect(b.h.lastText()).toMatch(/^🔵/);
    const again = await b.grade(1);
    expect(b.h.lastText().startsWith(`${ru.hintAgain(again.shown.replace("<", "&lt;"))}\n\n🔵`)).toBe(true);
    expect(b.h.tg.calls.filter((c) => String(c.payload.text ?? "").includes("Бот обновился"))).toEqual([]);
  });

  it("for a learner who has not seen the update notice yet it stays unseen", async () => {
    const { repo, user } = await studying(63);
    const b = bot();
    await b.text("/settings");
    await b.press("set:tut");
    expect((await repo.getUser(user.id))!.hintsSeen).toBe(0);
  });

  it("is in Tatar for a tt learner, and the screens are those of the introduction", async () => {
    const { repo, user } = await studying();
    await repo.updateUser(user.id, { lang: "tt" });
    const b = bot();
    await b.text("/settings");
    expect(buttons(b.h.lastMarkup()).at(-1)).toEqual(["🎓 Өйрәтүне яңадан күрсәтү", "set:tut"]);
    await b.press("set:tut");
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([tt.intro1, [["Алга таба", "tut:2"]]]);
    await b.press("tut:2");
    expect([b.h.lastText(), buttons(b.h.lastMarkup())]).toEqual([tt.intro2, [["Аңлашылды", "tut:ok"]]]);
    expect([renderIntro(1, "tt").text, renderIntro(2, "tt").text]).toEqual([tt.intro1, tt.intro2]);
    expect([renderIntro(1, "ru", true).text, renderIntro(2, "ru", true).text]).toEqual([ru.intro1, ru.intro2]);
  });
});
