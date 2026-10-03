import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { PLACEMENT } from "../../src/users/placement";
import { countingDb } from "../helpers/countingDb";
import { harness } from "../helpers/botHarness";
import { seedLevels } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const seedCatalog = (db: D1Database) => seedLevels(db, { 1: ["китап", "вакыт"], 2: ["авыл", "су"], 3: ["юл", "көн"], 4: ["өй", "эш"] });
const callbacks = (m: { inline_keyboard?: { callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data);

describe("bot handlers", () => {
  it("start runs onboarding to the first card", async () => {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    expect(callbacks(h.lastMarkup())).toEqual(["ob:ru", "ob:tt"]);
    await h.press("ob:en");
    expect((await new Repo(env.DB).getUserByTg(42))!.onboardingStep).toBe("lang");
    await h.press("ob:ru");
    expect(h.lastText()).toContain("1/10");
    expect(h.lastText()).toContain(PLACEMENT[0]!.word);
    for (let i = 0; i < 10; i++) await h.press("ob:1");
    expect(h.lastText()).toContain("уровня <b>10</b>");
    expect((await new Repo(env.DB).getUserByTg(42))!.level).toBe(10);
    await h.press("ob:10");
    expect(callbacks(h.lastMarkup())).toContain("ob:09:00");
    await h.press("ob:09:00");
    expect(callbacks(h.lastMarkup())).toContain("ob:180");
    await h.press("ob:180");
    expect(h.tg.of("editMessageText").at(-1)!.payload.text).toContain("09:00");
    expect(h.tg.of("editMessageText").at(-1)!.payload.text).toContain(ru.easyHint);
    expect(h.tg.of("deleteMessage")).toHaveLength(0);
  });

  it("opens the start level and shows its first card right after the last answer", async () => {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    await h.press("ob:ru");
    for (let i = 0; i < 10; i++) await h.press(i < 5 ? "ob:1" : "ob:0");
    await h.press("ob:10");
    await h.press("ob:09:00");
    await h.press("ob:180");
    const card = h.tg.of("sendMessage").at(-1)!;
    expect(String(card.payload.text)).toContain("<b>өй</b>");
    expect(callbacks(card.payload.reply_markup as never).slice(0, 4)).toEqual([expect.stringMatching(/^g:\d+:0:1$/), expect.stringMatching(/:2$/), expect.stringMatching(/:3$/), expect.stringMatching(/:4$/)]);
    expect(card.payload.link_preview_options).toEqual({ is_disabled: true });
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(await repo.userDeckIds(u.id)).toEqual([(await repo.getDeckBySlug("l04"))!.id]);
  });

  /** Runs onboarding up to the time-zone question, then counts the calls of the one update that answers it. */
  async function finishWith(answer: (h: ReturnType<typeof harness>) => Promise<unknown>) {
    await seedLevels(env.DB, { 1: ["бер"], 4: ["дүрт"] });
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/start");
    await h.press("ob:tt");
    for (let i = 0; i < 10; i++) await h.press(i < 5 ? "ob:1" : "ob:0");
    await h.press("ob:10");
    await h.press("ob:09:00");
    const tgBefore = h.tg.calls.length;
    db.calls = 0;
    await answer(h);
    return { h, telegramCalls: h.tg.calls.length - tgBefore, d1Calls: db.calls, update: h.tg.calls.slice(tgBefore) };
  }
  const textsOf = (calls: { payload: Record<string, unknown> }[]) => calls.map((c) => String(c.payload.text ?? ""));

  it("sends the hint and the first card right after the last answer, within budget", async () => {
    const { telegramCalls, d1Calls, update } = await finishWith((h) => h.press("ob:180"));
    const texts = textsOf(update.filter((c) => c.method !== "answerCallbackQuery"));
    expect(texts.join("\n")).toContain(tt.easyHint);
    expect(texts.at(-1)).toContain("дүрт");
    expect(update.map((c) => c.method)).toEqual(["editMessageText", "sendMessage", "answerCallbackQuery"]);
    expect(telegramCalls).toBeLessThanOrEqual(3);
    expect(d1Calls).toBeLessThanOrEqual(8);
  });

  it("typed local time finishes onboarding with a new message and stays within budget", async () => {
    const { telegramCalls, d1Calls, update } = await finishWith((h) => h.text("14:35"));
    expect(update.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(textsOf(update)[0]).toContain(tt.easyHint);
    expect(telegramCalls).toBeLessThanOrEqual(3);
    expect(d1Calls).toBeLessThanOrEqual(8);
  });

  it("without a seeded start level onboarding still finishes and shows the empty screen", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    await h.press("ob:ru");
    for (let i = 0; i < 10; i++) await h.press("ob:1");
    await h.press("ob:10");
    await h.press("ob:09:00");
    await h.press("ob:180");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u).toMatchObject({ onboardingStep: null, level: 10 });
    expect(await repo.userDeckIds(u.id)).toEqual([]);
    expect(h.lastText()).toContain(ru.noDecks);
  });

  async function startSession() {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    await repo.subscribe(u.id, (await repo.getDeckBySlug("l01"))!.id, T);
    await h.text("/learn");
    const cardMsg = h.tg.lastMessageId();
    const grade = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never)[2]!;
    return { h, repo, u, cardMsg, grade };
  }

  it("grade shows the next card as a new message and deletes the old one (fresh spoiler)", async () => {
    const { h, repo, u, cardMsg, grade } = await startSession();
    const editsBefore = h.tg.of("editMessageText").length;
    await h.press(grade, cardMsg);
    expect(h.tg.of("editMessageText")).toHaveLength(editsBefore);
    const next = h.tg.of("sendMessage").at(-1)!;
    expect(String(next.payload.text)).toContain("<b>вакыт</b>");
    expect(String(next.payload.text)).not.toContain("китап");
    expect(String(next.payload.text)).toContain("<tg-spoiler>");
    expect(next.payload.disable_notification).toBe(true);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id)).toEqual([cardMsg]);
    expect((await repo.getSession(u.id))!.messageId).toBe(h.tg.lastMessageId());
    expect(h.tg.lastMessageId()).not.toBe(cardMsg);
    await h.press(grade, cardMsg);
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Эта кнопка уже неактуальна");
    expect(h.tg.of("deleteMessage")).toHaveLength(1);
  });

  it("undo also re-sends the card as a new message", async () => {
    const { h, cardMsg, grade } = await startSession();
    await h.press(grade, cardMsg);
    const second = h.tg.lastMessageId();
    await h.press("u", second);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id)).toEqual([cardMsg, second]);
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("<b>китап</b>");
  });

  it("if the old card can't be deleted, its buttons are removed instead", async () => {
    const { h, cardMsg, grade } = await startSession();
    h.tg.failNext("deleteMessage", 400, "Bad Request: message can't be deleted for everyone");
    await h.press(grade, cardMsg);
    const strip = h.tg.of("editMessageReplyMarkup").at(-1)!;
    expect(strip.payload.message_id).toBe(cardMsg);
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("<b>вакыт</b>");
  });

  it("the voice message of the previous card is removed with it", async () => {
    const { h, repo, u, cardMsg, grade } = await startSession();
    await repo.saveSession({ userId: u.id, chatId: 42, messageId: cardMsg, cardId: null, stale: false, lastVoiceMessageId: 77 });
    await h.press(grade, cardMsg);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id).sort()).toEqual([77, cardMsg].sort());
    expect((await repo.getSession(u.id))!.lastVoiceMessageId).toBeNull();
  });

  it("text with a link shows a preview with the link host; url-only asks for words", async () => {
    const f = (async () =>
      json({ choices: [{ message: { content: JSON.stringify({ cards: [{ word: "рәхмәт", transcription: null, pos: "intj", translation: "спасибо", exampleTt: "Зур рәхмәт!", exampleRu: "Большое спасибо!" }] }) } }] })
    ) as typeof fetch;
    const h = harness(env.DB, { now: T, fetch: f });
    await h.text("/start");
    const repo = new Repo(env.DB);
    await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
    await h.text("рәхмәт https://example.com/a", [{ type: "url", offset: 7, length: 21 }]);
    expect(h.tg.of("sendMessage").at(-1)!.payload.text).toBe("🔎 Ищу слова…");
    expect(h.lastText()).toContain("<b>рәхмәт</b>");
    expect(h.lastText()).toContain("<blockquote><i>Зур рәхмәт!</i>\nБольшое спасибо!</blockquote>");
    expect(h.lastText()).toContain("🔗 example.com");
    await h.press(callbacks(h.lastMarkup())[0]!, 300);
    expect(h.lastText()).toContain("✅ Добавлено");
    expect(h.lastText()).toContain("<b>рәхмәт</b>");
    await h.text("https://youtu.be/q", [{ type: "url", offset: 0, length: 18 }]);
    expect(h.lastText()).toContain("youtu.be");
  });

  it("D1 daily limit error answers with maintenance and does not throw", async () => {
    const broken = new Repo(env.DB);
    broken.getUserByTg = async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit."); };
    const h = harness(env.DB, { now: T, repo: broken });
    await h.text("/learn");
    expect(h.lastText()).toContain("Технический перерыв");
  });

  it("settings buttons cycle values in place", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    await h.text("/settings");
    await h.press("set:ret", 200);
    expect(h.lastText()).toContain("Настройки");
    expect((await repo.getUser(u.id))!.retention).toBe(0.95);
    await h.press("set:dir", 200);
    expect((await repo.getUser(u.id))!.direction).toBe("ru_tt");
    await h.press("set:dir", 200);
    await h.press("set:dir", 200);
    expect((await repo.getUser(u.id))!.direction).toBe("tt_ru");
    const labels = () => (h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.text);
    expect(labels()).toContain("↔️ Направление: татарский → русский");
    await h.press("set:dir", 200);
    await h.press("set:dir", 200);
    expect((await repo.getUser(u.id))!.direction).toBe("both");
    expect(labels()).toContain("↔️ Направление: оба");
    await h.press("set:lang", 200);
    expect((await repo.getUser(u.id))!.lang).toBe("tt");
    expect(h.lastText()).toContain("Көйләүләр");
    expect(labels()).toContain("🌐 Тел: Татарча");
    expect(labels()).toContain("↔️ Юнәлеш: икесе дә");
    await h.press("set:lang", 200);
    expect((await repo.getUser(u.id))!.lang).toBe("ru");
    expect(h.lastText()).toContain("Настройки");
    expect(labels()).toContain("🌐 Язык: Русский");
  });

  describe("reports", () => {
    const adminSends = (h: ReturnType<typeof harness>) => h.tg.of("sendMessage").filter((c) => c.payload.chat_id === 999);
    const answers = (h: ReturnType<typeof harness>) => h.tg.of("answerCallbackQuery").map((c) => c.payload.text);
    const noteId = async (word: string) => (await env.DB.prepare("SELECT id FROM notes WHERE word = ?").bind(word).first<{ id: number }>())!.id;

    it("stores one report per user and word and notifies the admin once", async () => {
      const { h, repo, cardMsg } = await startSession();
      const id = await noteId("китап");
      await h.press(`r:${id}`, cardMsg);
      await h.press(`r:${id}`, cardMsg);
      expect(adminSends(h)).toHaveLength(1);
      const msg = adminSends(h)[0]!;
      expect(String(msg.payload.text)).toContain("китап");
      expect(String(msg.payload.text)).toContain("китап-ru");
      expect(String(msg.payload.text)).toContain("42");
      expect(msg.payload.parse_mode).toBe("HTML");
      expect(answers(h)).toEqual([ru.reportSent, ru.reportAlready]);
      expect((await repo.recentReports(10))[0]).toMatchObject({ noteId: id, word: "китап", translation: "китап-ru", count: 1 });
      expect(h.tg.of("editMessageText")).toHaveLength(0);
      expect(h.tg.of("deleteMessage")).toHaveLength(0);
    });

    it("answers in the interface language", async () => {
      const { h, repo, u, cardMsg } = await startSession();
      await repo.updateUser(u.id, { lang: "tt" });
      await h.press(`r:${await noteId("китап")}`, cardMsg);
      expect(answers(h)).toEqual([tt.reportSent]);
    });

    it("escapes the word, translation and example in the admin message", async () => {
      const { h, repo, cardMsg } = await startSession();
      const [id] = await repo.insertNotes((await repo.getDeckBySlug("l01"))!.id, [
        { word: "<b>x&y", transcription: null, pos: "n", translation: "a<i>b", exampleTt: "<u>q", exampleRu: "r&s" },
      ]);
      await h.press(`r:${id}`, cardMsg);
      const text = String(adminSends(h)[0]!.payload.text);
      expect(text).toContain("&lt;b&gt;x&amp;y");
      expect(text).toContain("a&lt;i&gt;b");
      expect(text).toContain("&lt;u&gt;q");
      expect(text).toContain("r&amp;s");
      expect(text).not.toContain("<b>x");
    });

    it("keeps the report when the admin cannot be reached", async () => {
      const { h, repo, cardMsg } = await startSession();
      h.tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
      await h.press(`r:${await noteId("китап")}`, cardMsg);
      expect(answers(h)).toEqual([ru.reportSent]);
      expect(await repo.recentReports(10)).toHaveLength(1);
    });

    it("ignores a forged report for a word the user cannot see", async () => {
      const { h, repo, cardMsg } = await startSession();
      const other = await repo.insertUser({ tgId: 77, chatId: 77, lang: "ru", now: T });
      const secret = await repo.customDeck(other, T);
      const [id] = await repo.insertNotes(secret, [{ word: "серсүз", transcription: null, pos: "", translation: "тайна", exampleTt: "", exampleRu: "" }]);
      await h.press(`r:${id}`, cardMsg);
      await h.press("r:999999", cardMsg);
      expect(answers(h)).toEqual([ru.staleButton, ru.staleButton]);
      expect(adminSends(h)).toHaveLength(0);
      expect(await repo.recentReports(10)).toEqual([]);
      expect(JSON.stringify(h.tg.calls)).not.toContain("серсүз");
    });

    it("lets the user report a note they have a card for even after leaving its deck", async () => {
      const { h, repo, u, cardMsg } = await startSession();
      const id = await noteId("китап");
      expect(await repo.getCardByNote(u.id, id, "tt_ru")).not.toBeNull();
      await env.DB.prepare("DELETE FROM user_decks WHERE user_id = ?").bind(u.id).run();
      await h.press(`r:${id}`, cardMsg);
      expect(answers(h)).toEqual([ru.reportSent]);
    });

    it("stays within the Telegram and D1 budget and does not redraw the card", async () => {
      await seedCatalog(env.DB);
      const db = countingDb(env.DB);
      const h = harness(db, { now: T });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null });
      await repo.subscribe(u.id, (await repo.getDeckBySlug("l01"))!.id, T);
      await h.text("/learn");
      const id = await noteId("китап");
      const tgBefore = h.tg.calls.length;
      db.calls = 0;
      await h.press(`r:${id}`, h.tg.lastMessageId());
      expect(h.tg.calls.slice(tgBefore).map((c) => c.method).sort()).toEqual(["answerCallbackQuery", "sendMessage"]);
      expect(db.calls).toBe(3); // user row, visible note, insert report
    });
  });
});
