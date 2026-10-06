import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderHub, renderLevelChecks, renderModes, renderPosChecks, renderTopics } from "../../src/bot/screens";
import { Repo } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import type { Hub, LevelLine, TopicLine } from "../../src/levels/service";
import { newMem } from "../../src/srs/fsrs";
import { easyButton, harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { note, recountProgress, seedCatalog, seedGuidedOrder, seedLearner, seedTopics } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
type Markup = { inline_keyboard?: { text: string; callback_data: string }[][] };
const buttons = (m: Markup) => (m.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);
const rows = (m: Markup) => (m.inline_keyboard ?? []).map((row) => row.map((b) => b.callback_data));

/**
 * The bot over a database that counts its calls. `text` and `press` run one update and give its Telegram calls, the
 * number of its D1 calls and the text of its toast; every update is held to the budget of an update without a voice.
 * A press goes to message 100, the first message the bot sends, unless another is named.
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
  return { h, text: (s: string) => update(() => h.text(s)), press: (data: string, messageId = 100) => update(() => h.press(data, messageId)) };
}
/** The update changed message 100 in place and answered the tap: nothing was sent. */
const edited = (u: { calls: { method: string; payload: Record<string, unknown> }[]; methods: string[] }, messageId = 100) => {
  expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
  expect(u.calls[0]!.payload.message_id).toBe(messageId);
};

/**
 * The learner at the bot (Telegram id 42) has A1 and A2 checked. A1: 40 words in the topics 0, 1, 2 in turn, 36 graded
 * and one more shown but not graded; it covers 45% of a text. A2: 3 words of «Основа», none started. B1 has two words
 * and is not checked; B2 and C1 have none. «Мои слова» holds 12 words, an AI deck 20.
 */
async function learnerInA1(db: D1Database) {
  await seedTopics(db);
  const a1 = await seedCatalog(db, Array.from({ length: 40 }, (_, i) => ({ level: 1, word: `сүз${i + 1}`, topic: i % 3 })));
  await seedCatalog(db, [...["авыл", "су", "юл"].map((word) => ({ level: 2, word })), ...["көн", "өй"].map((word) => ({ level: 3, word }))]);
  await db.prepare("UPDATE decks SET coverage_pct = 45 WHERE level_no = 1").run();
  const { repo, user } = await seedLearner(db, { now: T, tgId: 42, patch: { levels: 0b11 } });
  await repo.batch(a1.slice(0, 36).map((id) => repo.insertCardStmt(user.id, id, "tt_ru", gradedMem(T))));
  await repo.insertCard(user.id, a1[36]!, "tt_ru", newMem(T));
  await recountProgress(db, user.id);
  await repo.insertNotes(await repo.customDeck(user.id, T), Array.from({ length: 12 }, (_, i) => note(`үзем${i + 1}`)));
  const ai = await repo.insertDeck({ slug: null, kind: "ai", titleRu: "🤖 Путешествия", titleTt: "🤖 Путешествия", levelNo: null, coveragePct: null, ownerId: user.id });
  await repo.insertNotes(ai, Array.from({ length: 20 }, (_, i) => note(`сәяхәт${i + 1}`)));
  await repo.subscribe(user.id, ai, T);
  return { repo, user };
}

/**
 * A1: «әни», «әти» of «Семья и близкие» (2), «ипи» of «Еда» (8), «мин» of «Основа» (0). A2: «сөт» of «Еда».
 * B1: «сәяхәт» of «Путешествия» (15). The learner (Telegram id 42) has A1 checked and nothing started.
 */
async function learnerWithTopics(db: D1Database) {
  await seedTopics(db);
  await seedCatalog(db, [
    { level: 1, word: "әни", topic: 2 }, { level: 1, word: "әти", topic: 2 }, { level: 1, word: "ипи", topic: 8 }, { level: 1, word: "мин", topic: 0 },
    { level: 2, word: "сөт", topic: 8 }, { level: 3, word: "сәяхәт", topic: 15 },
  ]);
  return seedLearner(db, { now: T, tgId: 42 });
}

const HUB_RU = [
  "📚 <b>Уровни</b>",
  "☑ A1 · 36 из 40 (будет 500) · ≈45 % текста",
  "☑ A2 · 0 из 3 (будет 850)",
  "☐ B1 · 0 из 2 (будет 850)",
  "☐ B2 · скоро",
  "☐ C1 · скоро",
  "",
  "🧭 Бот ведёт по темам · сейчас «Знакомство и вежливость»: 12 из 13",
  "📝 Мои слова · 12",
  "🤖 Путешествия · 20",
].join("\n");
const HUB_BUTTONS = [["Уровни", "hub:lv"], ["Части речи", "hub:pos"], ["Порядок слов", "hub:mode"], ["Темы", "hub:tp"], ["▶ Учить", "learn"]];
const LEVELS_TEXT = "📚 <b>Уровни</b>\nНовые слова берутся из отмеченных уровней. Начатые слова повторяются в любом случае.";
const POS_TEXT = "🧩 <b>Части речи</b>\nНовые слова берутся только из отмеченных частей речи. Начатые слова повторяются в любом случае.";
const MODES_TEXT = [
  "🧭 <b>Порядок новых слов</b>",
  "<b>Бот ведёт по темам</b> — темы идут по порядку, основные слова подмешиваются; можно перескочить на другую тему",
  "<b>Сам выбираю тему</b> — слова только из выбранной темы",
  "<b>По частоте</b> — от самых нужных к редким, вперемешку",
].join("\n\n");
const TOPICS_TEXT = "🗂 <b>Темы</b>\nНажмите на тему — новые слова пойдут из неё. Числа: сколько слов начато из имеющихся.";

describe("/levels: the hub", () => {
  it("shows the five levels, the order of new words with its topic and the own decks, with a button for each list", async () => {
    await learnerInA1(env.DB);
    const b = bot();
    const u = await b.text("/levels");
    expect(b.h.lastText()).toBe(HUB_RU);
    expect(buttons(b.h.lastMarkup())).toEqual(HUB_BUTTONS);
    expect(rows(b.h.lastMarkup())).toEqual([["hub:lv", "hub:pos"], ["hub:mode", "hub:tp"], ["learn"]]);
    expect(u.methods).toEqual(["sendMessage"]);
    expect(u.d1).toBe(2);
  });

  it("is in Tatar for a tt user, with the level codes as they are and the Tatar titles of the topics", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    await repo.updateUser(user.id, { lang: "tt" });
    const b = bot();
    await b.text("/levels");
    expect(b.h.lastText()).toBe([
      "📚 <b>Дәрәҗәләр</b>",
      "☑ A1 · 36/40 (500 булачак) · текстның ≈45 %",
      "☑ A2 · 0/3 (850 булачак)",
      "☐ B1 · 0/2 (850 булачак)",
      "☐ B2 · тиздән",
      "☐ C1 · тиздән",
      "",
      "🧭 Бот темалар буенча алып бара · хәзер «Танышу һәм әдәп»: 12/13",
      "📝 Минем сүзләр · 12",
      "🤖 Путешествия · 20",
    ].join("\n"));
    expect(buttons(b.h.lastMarkup())).toEqual([["Дәрәҗәләр", "hub:lv"], ["Сүз төркемнәре", "hub:pos"], ["Сүзләр тәртибе", "hub:mode"], ["Темалар", "hub:tp"], ["▶ Өйрәнү", "learn"]]);
  });

  it("the «Уровни» button of the done screen and of the empty screen sends the hub as a new message", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }]);
    await seedLearner(env.DB, { now: T, tgId: 42 });
    const b = bot();
    await b.text("/learn");
    await b.press(easyButton(b.h), b.h.tg.lastMessageId());
    expect(b.h.lastText()).toContain(ru.doneTitle);
    expect(buttons(b.h.lastMarkup())).toEqual([[ru.addWords, "help:add"], ["📚 Уровни", "levels"]]);
    const u = await b.press("levels", b.h.tg.lastMessageId());
    expect(u.methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(b.h.lastText()).toBe(["📚 <b>Уровни</b>", "☑ A1 · 1 из 1 (будет 500)", "☐ A2 · скоро", "☐ B1 · скоро", "☐ B2 · скоро", "☐ C1 · скоро", "", "🧭 Бот ведёт по темам"].join("\n"));
    expect(buttons(b.h.lastMarkup())).toEqual(HUB_BUTTONS);
  });

  it("a learner with nothing to learn is sent to /levels, and the hub of an empty catalog still opens", async () => {
    const b = bot();
    await b.text("/start");
    const repo = new Repo(env.DB);
    const id = (await repo.getUserByTg(42))!.id;
    await repo.updateUser(id, { onboardingStep: null });
    await b.text("/learn");
    expect(b.h.lastText()).toBe("Пока учить нечего. Отметьте уровень в /levels или напишите боту своё слово.");
    expect(buttons(b.h.lastMarkup())).toEqual([["📚 Уровни", "levels"]]);
    await repo.updateUser(id, { lang: "tt" });
    await b.text("/learn");
    expect(b.h.lastText()).toBe(tt.nothingToLearn);
    expect(buttons(b.h.lastMarkup())).toEqual([["📚 Дәрәҗәләр", "levels"]]);
    await repo.updateUser(id, { lang: "ru" });
    await b.press("levels", b.h.tg.lastMessageId());
    // The level a new learner has checked holds no card yet: it is «скоро» with its mark.
    expect(b.h.lastText()).toBe(["📚 <b>Уровни</b>", "☑ A1 · скоро", "☐ A2 · скоро", "☐ B1 · скоро", "☐ B2 · скоро", "☐ C1 · скоро", "", "🧭 Бот ведёт по темам"].join("\n"));
  });

  it("during the introduction the buttons of these screens change nothing: the tap is answered with the hint", async () => {
    await learnerInA1(env.DB);
    const repo = new Repo(env.DB);
    const user = (await repo.getUserByTg(42))!;
    const b = bot();
    // The steps after the language; on the language step every update is answered with its screen (tutorial.test.ts).
    for (const step of ["intro1", "intro2", "levels"]) {
      await repo.updateUser(user.id, { onboardingStep: step });
      for (const data of [
        "levels", "hub", "hub:lv", "lv:t:3", "hub:pos", "ps:t:0", "hub:mode", "md:freq", "hub:tp", "tp:1", "fix:pos", "fix:lv:3", "fix:topic", "set:hub", "set:tz", "tz:300", "set:back", "lv:skip",
        "set:lang", "set:ret", "set:new", "set:rem", "set:dir", "set:auto",
      ]) {
        const u = await b.press(data);
        expect(u.calls.map((c) => [c.method, c.payload.text]), `${step} ${data}`).toEqual([["answerCallbackQuery", ru.chooseAbove]]);
      }
      expect(await repo.getUser(user.id)).toEqual({ ...user, onboardingStep: step });
    }
  });
});

describe("«Уровни»: the checkboxes of the levels", () => {
  it("opens in the message of the hub; a tap on a level with cards checks it, another unchecks it, and the message is edited, not sent again", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    await b.text("/levels");
    const open = await b.press("hub:lv");
    edited(open);
    expect(open.d1).toBe(2);
    expect(b.h.lastText()).toBe(LEVELS_TEXT);
    expect(buttons(b.h.lastMarkup())).toEqual([["☑ A1 · 36 из 40", "lv:t:1"], ["☑ A2 · 0 из 3", "lv:t:2"], ["☐ B1 · 0 из 2", "lv:t:3"], ["☐ B2 · скоро", "lv:t:4"], ["☐ C1 · скоро", "lv:t:5"], ["Готово", "hub"]]);

    const check = await b.press("lv:t:3");
    edited(check);
    expect(check.d1).toBe(4);
    expect(check.toast).toBeUndefined();
    expect((await repo.getUser(user.id))!.levels).toBe(0b111);
    expect(buttons(b.h.lastMarkup())[2]).toEqual(["☑ B1 · 0 из 2", "lv:t:3"]);

    edited(await b.press("lv:t:2"));
    expect((await repo.getUser(user.id))!.levels).toBe(0b101);
    expect(buttons(b.h.lastMarkup()).slice(0, 3)).toEqual([["☑ A1 · 36 из 40", "lv:t:1"], ["☐ A2 · 0 из 3", "lv:t:2"], ["☑ B1 · 0 из 2", "lv:t:3"]]);

    // «Готово» is the hub again, in the same message, with the levels as they are now.
    const done = await b.press("hub");
    edited(done);
    expect(done.d1).toBe(2);
    expect(b.h.lastText().split("\n").slice(1, 4)).toEqual(["☑ A1 · 36 из 40 (будет 500) · ≈45 % текста", "☐ A2 · 0 из 3 (будет 850)", "☑ B1 · 0 из 2 (будет 850)"]);
    expect(buttons(b.h.lastMarkup())).toEqual(HUB_BUTTONS);
    expect(b.h.tg.of("sendMessage")).toHaveLength(1);
  });

  it("the only checked level cannot be unchecked: the tap is answered with a toast and nothing changes", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    const b = bot();
    await b.text("/levels");
    await b.press("hub:lv");
    const u = await b.press("lv:t:1");
    expect(u.calls.map((c) => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", "Нужен хотя бы один уровень"]]);
    expect(await repo.getUser(user.id)).toEqual(user);
  });

  it("a level without cards cannot be checked: the tap is answered with a toast and nothing changes", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    const u = await b.press("lv:t:4");
    expect(u.calls.map((c) => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", "В этом уровне пока нет слов"]]);
    expect(await repo.getUser(user.id)).toEqual(user);
    expect(tt.levelEmpty).toBe("Бу дәрәҗәдә әлегә сүзләр юк");
  });

  it("unchecking the only level that holds the chosen topic clears the choice with it", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    await repo.updateUser(user.id, { levels: 0b101, topicNo: 15 });
    const b = bot();
    await b.press("lv:t:3");
    expect(await repo.getUser(user.id)).toMatchObject({ levels: 0b001, topicNo: null });
  });
});

describe("«Части речи»: the checkboxes of the groups", () => {
  it("opens in the message of the hub; a tap unchecks a group in place and the hub then names the groups left", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    await b.text("/levels");
    const open = await b.press("hub:pos");
    edited(open);
    expect(open.d1).toBe(1);
    expect(b.h.lastText()).toBe(POS_TEXT);
    expect(buttons(b.h.lastMarkup())).toEqual([
      ["☑ Существительные", "ps:t:0"], ["☑ Глаголы", "ps:t:1"], ["☑ Прилагательные", "ps:t:2"], ["☑ Наречия", "ps:t:3"],
      ["☑ Местоимения", "ps:t:4"], ["☑ Числительные", "ps:t:5"], ["☑ Служебные слова", "ps:t:6"], ["☑ Фразы", "ps:t:7"], ["Готово", "hub"],
    ]);
    expect(rows(b.h.lastMarkup())).toEqual([["ps:t:0", "ps:t:1"], ["ps:t:2", "ps:t:3"], ["ps:t:4", "ps:t:5"], ["ps:t:6", "ps:t:7"], ["hub"]]);

    for (const bit of [2, 3, 4, 5, 6, 7]) {
      const u = await b.press(`ps:t:${bit}`);
      edited(u);
      expect(u.d1).toBe(3);
    }
    expect((await repo.getUser(user.id))!.posGroups).toBe(0b11);
    expect(buttons(b.h.lastMarkup()).slice(0, 3)).toEqual([["☑ Существительные", "ps:t:0"], ["☑ Глаголы", "ps:t:1"], ["☐ Прилагательные", "ps:t:2"]]);
    await b.press("hub");
    expect(b.h.lastText().split("\n").slice(7, 9)).toEqual(["🧭 Бот ведёт по темам · сейчас «Знакомство и вежливость»: 12 из 13", "🧩 Части речи: существительные, глаголы"]);
  });

  it("the only checked group cannot be unchecked: the tap is answered with a toast and nothing changes", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    await repo.updateUser(user.id, { posGroups: 1 << 1 });
    const b = bot();
    const u = await b.press("ps:t:1");
    expect(u.calls.map((c) => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", "Нужна хотя бы одна часть речи"]]);
    expect((await repo.getUser(user.id))!.posGroups).toBe(1 << 1);
    expect(tt.needPos).toBe("Кимендә бер сүз төркеме кирәк");
  });
});

describe("«Порядок слов»: the three orders of new words", () => {
  it("names the three orders with the one in use marked; a tap moves the mark in place and the hub names the new order", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    await b.text("/levels");
    const open = await b.press("hub:mode");
    edited(open);
    expect(open.d1).toBe(1);
    expect(b.h.lastText()).toBe(MODES_TEXT);
    expect(buttons(b.h.lastMarkup())).toEqual([["✅ Бот ведёт по темам", "md:guided"], ["Сам выбираю тему", "md:topic"], ["По частоте", "md:freq"], ["Готово", "hub"]]);

    const freq = await b.press("md:freq");
    edited(freq);
    expect(freq.d1).toBe(2);
    expect((await repo.getUser(user.id))!.newMode).toBe("freq");
    expect(b.h.lastText()).toBe(MODES_TEXT);
    expect(buttons(b.h.lastMarkup())).toEqual([["Бот ведёт по темам", "md:guided"], ["Сам выбираю тему", "md:topic"], ["✅ По частоте", "md:freq"], ["Готово", "hub"]]);

    // «По частоте» takes no notice of a topic: the hub names no topic and offers no «Темы».
    await b.press("hub");
    expect(b.h.lastText().split("\n").slice(7)).toEqual(["🧭 По частоте", "📝 Мои слова · 12", "🤖 Путешествия · 20"]);
    expect(buttons(b.h.lastMarkup())).toEqual(HUB_BUTTONS.filter(([, data]) => data !== "hub:tp"));
    expect(rows(b.h.lastMarkup())).toEqual([["hub:lv", "hub:pos"], ["hub:mode"], ["learn"]]);

    await b.press("md:guided");
    expect((await repo.getUser(user.id))!.newMode).toBe("guided");
    expect(buttons(b.h.lastMarkup())[0]).toEqual(["✅ Бот ведёт по темам", "md:guided"]);
  });

  it("«Сам выбираю тему» without a topic chosen goes on to the list of topics; with one chosen it stays and the hub names the topic", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    await b.text("/levels");
    const u = await b.press("md:topic");
    edited(u);
    expect(u.d1).toBe(3);
    expect((await repo.getUser(user.id))!.newMode).toBe("topic");
    expect(b.h.lastText()).toBe(TOPICS_TEXT);
    await b.press("hub");
    expect(b.h.lastText().split("\n")[7]).toBe("🧭 Сам выбираю тему · тема не выбрана");

    await b.press("tp:2");
    await b.press("md:guided");
    await b.press("md:topic");
    expect(b.h.lastText()).toBe(MODES_TEXT);
    expect(buttons(b.h.lastMarkup())[1]).toEqual(["✅ Сам выбираю тему", "md:topic"]);
    await b.press("hub");
    expect(b.h.lastText().split("\n")[7]).toBe("🧭 Сам выбираю тему · «Семья и близкие»: 12 из 13");
    expect(buttons(b.h.lastMarkup())).toEqual(HUB_BUTTONS);
  });
});

describe("«Темы»: the topics of the checked levels", () => {
  it("lists the topics that have cards in the checked levels with the words started of those they have; a tap chooses a topic, and the next new word is of it", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    const b = bot();
    await b.text("/levels");
    const open = await b.press("hub:tp");
    edited(open);
    expect(open.d1).toBe(2);
    expect(b.h.lastText()).toBe(TOPICS_TEXT);
    // «Еда» counts the one word of A1: A2 is not checked. «Путешествия» has a word in B1 alone and is not listed.
    expect(buttons(b.h.lastMarkup())).toEqual([["Основа · 0 из 1", "tp:0"], ["Семья и близкие · 0 из 2", "tp:2"], ["Еда · 0 из 1", "tp:8"], ["✅ Не выбирать", "tp:none"], ["Готово", "hub"]]);
    expect(rows(b.h.lastMarkup())).toEqual([["tp:0"], ["tp:2"], ["tp:8"], ["tp:none", "hub"]]);

    const choose = await b.press("tp:8");
    edited(choose);
    expect(choose.d1).toBe(4);
    expect((await repo.getUser(user.id))!.topicNo).toBe(8);
    expect(buttons(b.h.lastMarkup())).toEqual([["Основа · 0 из 1", "tp:0"], ["Семья и близкие · 0 из 2", "tp:2"], ["✅ Еда · 0 из 1", "tp:8"], ["Не выбирать", "tp:none"], ["Готово", "hub"]]);

    await b.press("hub");
    expect(b.h.lastText().split("\n")[7]).toBe("🧭 Бот ведёт по темам · сейчас «Еда»: 0 из 1");
    await b.text("/learn");
    expect(b.h.lastText()).toContain("<b>ипи</b>");
  });

  it("«Не выбирать» clears the choice", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    await repo.updateUser(user.id, { topicNo: 2 });
    const b = bot();
    await b.press("hub:tp");
    expect(buttons(b.h.lastMarkup()).slice(1, 4)).toEqual([["✅ Семья и близкие · 0 из 2", "tp:2"], ["Еда · 0 из 1", "tp:8"], ["Не выбирать", "tp:none"]]);
    const u = await b.press("tp:none");
    edited(u);
    expect((await repo.getUser(user.id))!.topicNo).toBeNull();
    expect(buttons(b.h.lastMarkup()).slice(1, 4)).toEqual([["Семья и близкие · 0 из 2", "tp:2"], ["Еда · 0 из 1", "tp:8"], ["✅ Не выбирать", "tp:none"]]);
  });

  it("a button of a topic that has no card in the checked levels any more is out of date: the list as it is now is shown", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    const b = bot();
    const u = await b.press("tp:15");
    expect(u.toast).toBe(ru.staleButton);
    expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(b.h.lastText()).toBe(TOPICS_TEXT);
    expect((await repo.getUser(user.id))!.topicNo).toBeNull();
  });

  it("«Основа» chosen and then «Не выбирать» in the guided order: the words go on from the first themed word, none is passed over", async () => {
    // A1 in the guided order of the catalog: т1 о1 т2 о2 … — twenty themed words of two topics and twenty of «Основа» in turn.
    await seedTopics(env.DB);
    await seedCatalog(env.DB, [
      ...Array.from({ length: 20 }, (_, i) => ({ level: 1, word: `т${i + 1}`, topic: i < 10 ? 1 : 2 })),
      ...Array.from({ length: 20 }, (_, i) => ({ level: 1, word: `о${i + 1}`, topic: 0 })),
    ]);
    await seedGuidedOrder(env.DB);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
    const b = bot();
    const word = () => b.h.lastText().match(/<b>(.+?)<\/b>/)![1];
    const easy = () => b.press(easyButton(b.h), b.h.tg.lastMessageId());
    await b.press("tp:0", 900);
    await b.text("/learn");
    const given: string[] = [];
    for (let i = 0; i < 15; i++) { given.push(word()!); await easy(); }
    expect(given).toEqual(Array.from({ length: 15 }, (_, i) => `о${i + 1}`));
    // The sixteenth word of «Основа» is on the screen; it is a started card whatever is chosen.
    expect(word()).toBe("о16");
    const card = b.h.tg.lastMessageId(), button = easyButton(b.h);
    await b.press("tp:none", 900);
    expect((await repo.getUser(user.id))!.topicNo).toBeNull();
    await b.press(button, card);
    const after: string[] = [];
    for (let i = 0; i < 6; i++) { after.push(word()!); await easy(); }
    // The themed words from the first one; the words of «Основа» among them go on from the first that is not started.
    expect(after).toEqual(["т1", "т2", "т3", "т4", "т5", "т6"]);
  });

  it("in «По частоте» the screen is not offered: a button left from another order shows the hub and chooses nothing", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    await repo.updateUser(user.id, { newMode: "freq" });
    const b = bot();
    for (const data of ["hub:tp", "tp:8", "fix:topic"]) {
      const u = await b.press(data);
      expect(u.toast, data).toBe(ru.staleButton);
      expect(u.methods, data).toEqual(["editMessageText", "answerCallbackQuery"]);
      expect(b.h.lastText().split("\n")[7], data).toBe("🧭 По частоте");
    }
    expect((await repo.getUser(user.id))!.topicNo).toBeNull();
  });

  it("is in Tatar for a tt user", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    await repo.updateUser(user.id, { lang: "tt", topicNo: 8 });
    const b = bot();
    await b.press("hub:tp");
    expect(b.h.lastText()).toBe(tt.topicsText);
    expect(buttons(b.h.lastMarkup())).toEqual([["Нигез сүзләр · 0/1", "tp:0"], ["Гаилә һәм якыннар · 0/2", "tp:2"], ["✅ Ризык · 0/1", "tp:8"], ["Сайламау", "tp:none"], ["Әзер", "hub"]]);
  });
});

describe("buttons of screens that are gone", () => {
  it("«Открыть пропущенные» of the old /levels answers that it is out of date and shows the hub in its message; nothing is changed", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    const u = await b.press("lv:skip", 77);
    expect(u.toast).toBe(ru.staleButton);
    edited(u, 77);
    expect(b.h.lastText()).toBe(HUB_RU);
    expect(await repo.getUser(user.id)).toEqual(user);
  });

  it("/decks answers as an unknown command, and a button nobody knows answers that it is out of date", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const b = bot();
    await b.text("/decks");
    expect(b.h.lastText()).toBe(ru.unknownCommand);
    for (const data of ["decks", `sub:${(await repo.getDeckBySlug("a2"))!.id}`, "lv:t:9", "md:x", "tz:1"]) {
      const u = await b.press(data);
      expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
    }
    expect(await repo.getUser(user.id)).toEqual(user);
    expect(ru.help).toContain("/levels — уровни, темы, порядок слов");
    expect(ru.help + tt.help).not.toContain("/decks");
    expect([ru.cmdLevels, tt.cmdLevels]).toEqual(["Уровни, темы, порядок слов", "Дәрәҗәләр, темалар, сүзләр тәртибе"]);
  });
});

describe("the end of a session with no new word although the day allows more", () => {
  const LEAD = "Новых слов по вашим настройкам нет: ";
  /** Runs /learn and grades cards «Легко» until the session is over; gives the id of the message of the done screen. */
  async function toTheEnd(b: ReturnType<typeof bot>): Promise<number> {
    await b.text("/learn");
    while (easyButton(b.h)) await b.press(easyButton(b.h), b.h.tg.lastMessageId());
    expect(b.h.lastText().startsWith(ru.doneTitle)).toBe(true);
    return b.h.tg.lastMessageId();
  }

  it("the checked levels are started whole and another level has cards: the bot checks nothing by itself and offers the lowest such level; the button checks it and shows a card of it", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }, { level: 1, word: "вакыт" }, { level: 2, word: "авыл" }, { level: 3, word: "су" }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
    const b = bot();
    const done = await toTheEnd(b);
    expect(b.h.lastText()).toBe([ru.doneTitle, ru.doneToday(2, 0), ru.streak(1), "", `${LEAD}отмеченные уровни пройдены.`].join("\n"));
    expect(buttons(b.h.lastMarkup())).toEqual([["Добавить уровень A2", "fix:lv:2"], [ru.addWords, "help:add"], ["📚 Уровни", "levels"]]);
    expect(rows(b.h.lastMarkup())).toEqual([["fix:lv:2"], ["help:add", "levels"]]);
    expect((await repo.getUser(user.id))!.levels).toBe(0b001);

    const u = await b.press("fix:lv:2", done);
    expect(u.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(u.calls[1]!.payload.message_id).toBe(done);
    expect(u.d1).toBe(6);
    expect(b.h.lastText().startsWith("🔵 10 · 🔴 0 · 🟢 0\n<b>авыл</b>")).toBe(true);
    expect((await repo.getUser(user.id))!.levels).toBe(0b011);
  });

  it("a second tap on «Добавить уровень» does not uncheck the level", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }, { level: 2, word: "авыл" }, { level: 2, word: "су" }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
    const b = bot();
    const done = await toTheEnd(b);
    await Promise.all([b.h.press("fix:lv:2", done), b.h.press("fix:lv:2", done)]);
    expect((await repo.getUser(user.id))!.levels).toBe(0b011);
    await b.press("fix:lv:2", done);
    expect((await repo.getUser(user.id))!.levels).toBe(0b011);
    expect(b.h.lastText()).toContain("<b>авыл</b>");
  });

  it("«Добавить уровень» of a level that has no cards checks nothing and the session stays over", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
    const b = bot();
    const done = await toTheEnd(b);
    expect(b.h.lastText().split("\n").at(-1)).toBe("Все слова каталога в работе 🎉");
    expect(buttons(b.h.lastMarkup())).toEqual([[ru.addWords, "help:add"], ["📚 Уровни", "levels"]]);
    await b.press("fix:lv:4", done);
    expect((await repo.getUser(user.id))!.levels).toBe(0b001);
    expect(b.h.lastText().split("\n").at(-1)).toBe("Все слова каталога в работе 🎉");
  });

  it("the checked parts of speech have no word left and the others have: the button checks every part of speech and shows the next card", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }, { level: 1, word: "бару", pos: "v" }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42, patch: { posGroups: 1 } });
    const b = bot();
    const done = await toTheEnd(b);
    expect(b.h.lastText().split("\n").at(-1)).toBe(`${LEAD}в отмеченных частях речи слова кончились.`);
    expect(buttons(b.h.lastMarkup())[0]).toEqual(["Включить все части речи", "fix:pos"]);

    const u = await b.press("fix:pos", done);
    expect(u.methods).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(u.d1).toBe(6);
    expect((await repo.getUser(user.id))!.posGroups).toBe(255);
    expect(b.h.lastText()).toContain("<b>бару</b>");
  });

  it("«Сам выбираю тему» and the topic has no word left: the button opens the list of topics in the message of the done screen", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    await repo.updateUser(user.id, { newMode: "topic", topicNo: 8 });
    const b = bot();
    const done = await toTheEnd(b);
    expect(b.h.lastText().split("\n").at(-1)).toBe(`${LEAD}тема закончилась.`);
    expect(buttons(b.h.lastMarkup())[0]).toEqual(["Выбрать тему", "fix:topic"]);

    const u = await b.press("fix:topic", done);
    edited(u, done);
    expect(u.d1).toBe(2);
    expect(b.h.lastText()).toBe(TOPICS_TEXT);
    expect(buttons(b.h.lastMarkup())).toEqual([["Основа · 0 из 1", "tp:0"], ["Семья и близкие · 0 из 2", "tp:2"], ["✅ Еда · 1 из 1", "tp:8"], ["Не выбирать", "tp:none"], ["Готово", "hub"]]);
    // «Готово» is the hub, and its last button goes on to the cards: the learner types no command.
    await b.press("tp:2", done);
    await b.press("hub", done);
    expect(buttons(b.h.lastMarkup())).toEqual(HUB_BUTTONS);
    const learn = await b.press("learn", done);
    expect(learn.methods).toEqual(["sendMessage", "answerCallbackQuery"]);
    expect(b.h.lastText()).toContain("<b>әни</b>");
  });

  it("«Сам выбираю тему» and no topic is chosen: the line says so, with the same button", async () => {
    const { repo, user } = await learnerWithTopics(env.DB);
    await repo.updateUser(user.id, { newMode: "topic", topicNo: 8 });
    const b = bot();
    const done = await toTheEnd(b);
    await b.press("fix:topic", done);
    await b.press("tp:none", done);
    await b.text("/learn");
    expect(b.h.lastText().split("\n").at(-1)).toBe(`${LEAD}тема не выбрана.`);
    expect(buttons(b.h.lastMarkup())[0]).toEqual(["Выбрать тему", "fix:topic"]);
    await repo.updateUser(user.id, { lang: "tt" });
    await b.text("/learn");
    expect(b.h.lastText().split("\n").at(-1)).toBe("Көйләүләрегез буенча яңа сүзләр юк: тема сайланмаган.");
    expect(buttons(b.h.lastMarkup())[0]).toEqual(["Тема сайлау", "fix:topic"]);
  });

  it("with autoplay the button that adds a level stays within the caps of an update with a voice", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }, { level: 2, word: "авыл" }]);
    await env.DB.prepare("UPDATE notes SET audio_file_id = 'voice-of-' || word").run();
    await seedLearner(env.DB, { now: T, tgId: 42, patch: { autoplay: true } });
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    // The card is message 100 and its voice 101; the done screen is the message sent after them.
    await h.text("/learn");
    await h.press(easyButton(h), 100);
    const done = h.tg.lastMessageId();
    const before = h.tg.calls.length;
    db.calls = 0;
    await h.press("fix:lv:2", done);
    expect(h.tg.calls.slice(before).map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery", "sendVoice"]);
    expect(h.tg.calls.at(-1)!.payload.voice).toBe("voice-of-авыл");
    expect(db.calls).toBe(9);
  });

  it("the day's limit is spent: the session ends with no line about the settings", async () => {
    await seedCatalog(env.DB, Array.from({ length: 7 }, (_, i) => ({ level: 1, word: `сүз${i + 1}` })));
    await seedLearner(env.DB, { now: T, tgId: 42, patch: { newPerDay: 5 } });
    const b = bot();
    await b.text("/learn");
    // «Хорошо» spends the day's limit; «Легко» on a new word does not.
    const good = () => (b.h.lastMarkup().inline_keyboard ?? []).flat().map((x) => x.callback_data).find((c) => /^g:\d+:\d+:3$/.test(c));
    for (let i = 0; i < 5; i++) await b.press(good()!, b.h.tg.lastMessageId());
    expect(good()).toBeUndefined();
    expect(b.h.lastText().startsWith(ru.doneTitle)).toBe(true);
    expect(b.h.lastText()).not.toContain("Новых слов");
    expect(buttons(b.h.lastMarkup())).toEqual([[ru.addWords, "help:add"], ["📚 Уровни", "levels"]]);
  });
});

describe("the renderers of the hub and its screens", () => {
  const level = (no: 1 | 2 | 3 | 4 | 5, over: Partial<LevelLine> = {}): LevelLine =>
    ({ no, code: ["A1", "A2", "B1", "B2", "C1"][no - 1]!, checked: false, total: 0, size: [500, 850, 850, 800, 850][no - 1]!, started: 0, coveragePct: null, ...over });
  const hubOf = (over: Partial<Hub>): Hub => ({ levels: [], mode: "guided", posGroups: 255, topic: null, own: [], ...over });
  const topic = (over: Partial<TopicLine> = {}): TopicLine => ({ no: 2, titleRu: "Семья и близкие", titleTt: "Гаилә һәм якыннар", started: 12, total: 40, ...over });

  it("a level line: «(будет N)» only while the level holds fewer cards than its size, the coverage only when the level has one, «скоро» for a level without cards", () => {
    const lines = (levels: LevelLine[]) => renderHub(hubOf({ levels }), "ru").text.split("\n").slice(1, 1 + levels.length);
    expect(lines([
      level(1, { checked: true, total: 400, started: 137, coveragePct: 45 }), level(2, { checked: true, total: 850, started: 850, coveragePct: 62 }),
      level(3, { total: 850, started: 3 }), level(4, { total: 12, started: 0 }), level(5),
    ])).toEqual([
      "☑ A1 · 137 из 400 (будет 500) · ≈45 % текста", "☑ A2 · 850 из 850 · ≈62 % текста", "☐ B1 · 3 из 850", "☐ B2 · 0 из 12 (будет 800)", "☐ C1 · скоро",
    ]);
    // A counter above the cards of its level is shown as the level started whole.
    expect(lines([level(1, { checked: true, total: 400, started: 403 })])).toEqual(["☑ A1 · 400 из 400 (будет 500)"]);
  });

  it("the line of the order: the topic the guided order stands in, the chosen topic or its absence, and nothing in «По частоте»", () => {
    const line = (over: Partial<Hub>, lang: "ru" | "tt" = "ru") => renderHub(hubOf(over), lang).text.split("\n").find((l) => l.startsWith("🧭"));
    expect(line({ topic: topic() })).toBe("🧭 Бот ведёт по темам · сейчас «Семья и близкие»: 12 из 40");
    expect(line({ topic: null })).toBe("🧭 Бот ведёт по темам");
    expect(line({ mode: "topic", topic: topic({ titleRu: "Еда", started: 3, total: 20 }) })).toBe("🧭 Сам выбираю тему · «Еда»: 3 из 20");
    expect(line({ mode: "topic", topic: null })).toBe("🧭 Сам выбираю тему · тема не выбрана");
    expect(line({ mode: "freq", topic: null })).toBe("🧭 По частоте");
    expect(line({ topic: topic() }, "tt")).toBe("🧭 Бот темалар буенча алып бара · хәзер «Гаилә һәм якыннар»: 12/40");
    expect(line({ mode: "topic", topic: null }, "tt")).toBe("🧭 Теманы үзем сайлыйм · тема сайланмаган");
    expect(line({ mode: "freq" }, "tt")).toBe("🧭 Ешлык буенча");
  });

  it("the line of the parts of speech stands only when not all are checked", () => {
    const text = (posGroups: number, lang: "ru" | "tt" = "ru") => renderHub(hubOf({ posGroups }), lang).text;
    expect(text(255)).not.toContain("🧩");
    expect(text(0b11).split("\n").at(-1)).toBe("🧩 Части речи: существительные, глаголы");
    expect(text(0b1111_1100).split("\n").at(-1)).toBe("🧩 Части речи: прилагательные, наречия, местоимения, числительные, служебные слова, фразы");
    expect(text(0b1111_1111, "tt")).not.toContain("🧩");
    expect(text(0b1100_0001, "tt").split("\n").at(-1)).toBe("🧩 Сүз төркемнәре: исемнәр, ярдәмлек сүзләр, гыйбарәләр");
  });

  it("escapes what comes from the database: the title of a topic and of an own deck", () => {
    const r = renderHub(hubOf({ topic: topic({ titleRu: "<b>x&y" }), own: [{ kind: "ai", titleRu: "🤖 <b>x&y", titleTt: "🤖 <b>x&y", total: 3 }, { kind: "custom", titleRu: "Мои слова", titleTt: "Минем сүзләр", total: 14 }] }), "ru");
    expect(r.text.split("\n").slice(-3)).toEqual(["🧭 Бот ведёт по темам · сейчас «&lt;b&gt;x&amp;y»: 12 из 40", "🤖 &lt;b&gt;x&amp;y · 3", "📝 Мои слова · 14"]);
    // The text of a button is not HTML: the title stands as it is.
    expect(renderTopics([topic({ titleRu: "<b>x&y" })], null, "ru").keyboard[0]![0]!.text).toBe("<b>x&y · 12 из 40");
  });

  it("the checkboxes of the levels and of the parts of speech, the orders and the topics in Tatar", () => {
    const levels = renderLevelChecks([level(1, { checked: true, total: 400, started: 137, coveragePct: 45 }), level(2)], "tt");
    expect(levels.text).toBe(`${tt.levelsTitle}\n${tt.levelChecksHint}`);
    expect(levels.keyboard.flat().map((b) => b.text)).toEqual(["☑ A1 · 137/400", "☐ A2 · тиздән", "Әзер"]);
    const pos = renderPosChecks(0b1000_0010, "tt");
    expect(pos.text).toBe(`${tt.posTitle}\n${tt.posChecksHint}`);
    expect(pos.keyboard.flat().map((b) => b.text)).toEqual(["☐ Исемнәр", "☑ Фигыльләр", "☐ Сыйфатлар", "☐ Рәвешләр", "☐ Алмашлыклар", "☐ Саннар", "☐ Ярдәмлек сүзләр", "☑ Гыйбарәләр", "Әзер"]);
    const modes = renderModes("topic", "tt");
    expect(modes.text.split("\n\n")).toEqual([
      "🧭 <b>Яңа сүзләр тәртибе</b>",
      `<b>Бот темалар буенча алып бара</b> — ${tt.modeAbout("guided")}`,
      `<b>Теманы үзем сайлыйм</b> — ${tt.modeAbout("topic")}`,
      `<b>Ешлык буенча</b> — ${tt.modeAbout("freq")}`,
    ]);
    expect(modes.keyboard.flat().map((b) => b.text)).toEqual(["Бот темалар буенча алып бара", "✅ Теманы үзем сайлыйм", "Ешлык буенча", "Әзер"]);
    expect(renderTopics([], null, "tt").keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([["✅ Сайламау", "tp:none"], ["Әзер", "hub"]]);
  });
});
