import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LlmClient } from "../../src/content/llm";
import { ContentService } from "../../src/content/service";
import { transcribe } from "../../src/content/transcribe";
import { Repo } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { PLACEMENT } from "../../src/users/placement";
import { countingDb } from "../helpers/countingDb";
import { easyButton, harness } from "../helpers/botHarness";
import { echoLlm } from "../helpers/llm";
import { note, seedLevels, seedUser } from "../helpers/seed";
import { TELEGRAM_TEXT_LIMIT, visibleLength } from "../helpers/visible";

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
    // Ten known words place at level 10; the catalog of this test ends at level 4.
    expect(h.lastText()).toContain("уровня <b>4</b>");
    expect((await new Repo(env.DB).getUserByTg(42))!.level).toBe(4);
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

  it("with only level 1 published a learner who knows every placement word starts at level 1, within budget", async () => {
    await seedLevels(env.DB, { 1: ["бер", "ике"] });
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/start");
    await h.press("ob:ru");
    for (let i = 0; i < 10; i++) await h.press("ob:1");
    expect(h.lastText()).toBe(ru.goalQ(1));
    await h.press("ob:10");
    await h.press("ob:09:00");
    const tgBefore = h.tg.calls.length;
    db.calls = 0;
    await h.press("ob:180");
    expect(h.tg.calls.slice(tgBefore).map((c) => c.method)).toEqual(["editMessageText", "sendMessage", "answerCallbackQuery"]);
    expect(db.calls).toBeLessThanOrEqual(8);
    expect(h.lastText()).toContain("<b>бер</b>");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u).toMatchObject({ onboardingStep: null, level: 1 });
    expect(await repo.userDeckIds(u.id)).toEqual([(await repo.getDeckBySlug("l01"))!.id]);
  });

  it("two concurrent taps on a time-zone button finish onboarding once; the second is answered as a stale button", async () => {
    const { update } = await finishWith((h) => Promise.all([h.press("ob:180", 100), h.press("ob:180", 100)]));
    expect(update.filter((c) => c.method === "editMessageText")).toHaveLength(1);
    const cards = update.filter((c) => c.method === "sendMessage");
    expect(cards).toHaveLength(1);
    expect(String(cards[0]!.payload.text)).toContain("дүрт");
    expect(update.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text).sort()).toEqual([tt.staleButton, undefined].sort());
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(await repo.userDeckIds(u.id)).toEqual([(await repo.getDeckBySlug("l04"))!.id]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("two concurrent typed times finish onboarding once and the second gets no answer", async () => {
    const { update } = await finishWith((h) => Promise.all([h.text("14:35"), h.text("14:35")]));
    expect(update.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(textsOf(update)[0]).toContain(tt.easyHint);
    expect(textsOf(update)[1]).toContain("дүрт");
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
    expect(h.lastText()).toBe(ru.nothingToLearn);
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

  describe("🔊", () => {
    const setAudio = (noteId: number, fileId: string) => env.DB.prepare("UPDATE notes SET audio_file_id = ? WHERE id = ?").bind(fileId, noteId).run();
    const answers = (h: ReturnType<typeof harness>) => h.tg.of("answerCallbackQuery").map((c) => c.payload.text);

    it("sends the voice of a word the learner can see", async () => {
      const { h, repo, cardMsg } = await startSession();
      const id = (await env.DB.prepare("SELECT id FROM notes WHERE word = 'китап'").first<{ id: number }>())!.id;
      await setAudio(id, "VOICE-KITAP");
      await h.press(`v:${id}`, cardMsg);
      expect(h.tg.of("sendVoice").map((c) => [c.payload.chat_id, c.payload.voice])).toEqual([[42, "VOICE-KITAP"]]);
      expect(answers(h)).toEqual([undefined]);
      void repo;
    });

    it("does not play another learner's own word, a word of a level that is not open, or a note that does not exist: the tap is answered like a stale button", async () => {
      const { h, repo, cardMsg } = await startSession();
      const other = await repo.insertUser({ tgId: 77, chatId: 77, lang: "ru", now: T });
      const [secret] = await repo.insertNotes(await repo.customDeck(other, T), [{ word: "серсүз", transcription: null, pos: "", translation: "тайна", exampleTt: "", exampleRu: "", audioFileId: "VOICE-SECRET" }]);
      const closed = (await env.DB.prepare("SELECT id FROM notes WHERE word = 'авыл'").first<{ id: number }>())!.id; // level 2, not open
      await setAudio(closed, "VOICE-AVYL");
      await h.press(`v:${secret}`, cardMsg);
      await h.press(`v:${closed}`, cardMsg);
      await h.press("v:999999", cardMsg);
      expect(h.tg.of("sendVoice")).toEqual([]);
      expect(answers(h)).toEqual([ru.staleButton, ru.staleButton, ru.staleButton]);
      expect(JSON.stringify(h.tg.calls)).not.toContain("VOICE-SECRET");
      expect((await repo.getSession((await repo.getUserByTg(42))!.id))!.lastVoiceMessageId).toBeNull();
    });

    it("a word without a voice is answered the same way", async () => {
      const { h, cardMsg } = await startSession();
      const id = (await env.DB.prepare("SELECT id FROM notes WHERE word = 'китап'").first<{ id: number }>())!.id;
      await h.press(`v:${id}`, cardMsg);
      expect(h.tg.of("sendVoice")).toEqual([]);
      expect(answers(h)).toEqual([ru.staleButton]);
    });
  });

  it("a note stored with fields longer than a message is still sent as a card, also under the line about a new level", async () => {
    await seedUser(env.DB, { now: T, level: 1, words: 1, tgId: 42 });
    await seedLevels(env.DB, { 2: ["авыл"] }, { 1: 31 });
    await env.DB.prepare("UPDATE notes SET translation = ?, example_tt = ?, example_ru = ?").bind("я".repeat(5000), "ә".repeat(5000), "я".repeat(5000)).run();
    const h = harness(env.DB, { now: T });
    await h.text("/learn");
    expect(h.lastText()).toContain("<b>китап</b>");
    expect(visibleLength(h.lastText())).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText().startsWith(`${ru.levelUp(1, 2, 31)}\n\n🔵 1 · 🔴 0 · 🟢 0\n<b>авыл</b>`)).toBe(true);
    expect(visibleLength(h.lastText())).toBe(TELEGRAM_TEXT_LIMIT);
    // The learner's queue is not blocked: the card can be graded and the session goes on.
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText()).toContain(ru.doneTitle);
  });

  it("undo answers the tap once, with the note that the grade was undone, within the Telegram budget", async () => {
    const { h, cardMsg, grade } = await startSession();
    await h.press(grade, cardMsg);
    const before = h.tg.calls.length;
    await h.press("u", h.tg.lastMessageId());
    const update = h.tg.calls.slice(before);
    expect(update.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(update.at(-1)!.payload.text).toBe(ru.undone);
  });

  /**
   * Autoplay is opt-in and exempt from the 3 / 8 budget of an update, but capped (ruling T16a):
   * at most 5 Telegram calls and 10 D1 calls per update, and the voice goes out after the card.
   */
  describe("autoplay budget", () => {
    const TG_CAP = 5, D1_CAP = 10;

    /** A learner with autoplay on, two words left in level 1 and level 2 behind it; every word has a voice. */
    async function autoplaySession(direction: "tt_ru" | "both" = "tt_ru") {
      await seedUser(env.DB, { now: T, level: 1, words: 2, tgId: 42, patch: { autoplay: true, direction } });
      await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
      await env.DB.prepare("UPDATE notes SET audio_file_id = 'voice-of-' || word").run();
      const db = countingDb(env.DB);
      const h = harness(db, { now: T });
      /** Runs one update and returns its Telegram calls and the number of its D1 calls. */
      const update = async (run: () => Promise<unknown>) => {
        const before = h.tg.calls.length;
        db.calls = 0;
        await run();
        return { calls: h.tg.calls.slice(before), methods: h.tg.calls.slice(before).map((c) => c.method), d1: db.calls };
      };
      /** The message id of the card on screen: the fake Telegram numbers what it sends from 100, voices included. */
      const cardMessage = () => 100 + h.tg.calls.filter((c) => c.method.startsWith("send")).map((c) => c.method).lastIndexOf("sendMessage");
      const easy = () => update(() => h.press(easyButton(h), cardMessage()));
      return { h, update, easy, cardMessage };
    }
    const within = (u: { methods: string[]; d1: number }) => {
      expect(u.methods.length, u.methods.join(",")).toBeLessThanOrEqual(TG_CAP);
      expect(u.d1).toBeLessThanOrEqual(D1_CAP);
    };
    /** The voice is the last call of the update and comes after the card it belongs to. */
    const voiceAfterCard = (u: { calls: { method: string; payload: Record<string, unknown> }[]; methods: string[] }, word: string) => {
      expect(u.methods.filter((m) => m === "sendVoice")).toHaveLength(1);
      expect(u.methods.at(-1)).toBe("sendVoice");
      expect(u.calls.at(-1)!.payload.voice).toBe(`voice-of-${word}`);
      expect(u.methods.indexOf("sendMessage")).toBeGreaterThanOrEqual(0);
      expect(u.methods.indexOf("sendMessage")).toBeLessThan(u.methods.indexOf("sendVoice"));
      expect(String(u.calls[u.methods.indexOf("sendMessage")]!.payload.text)).toContain(`<b>${word}</b>`);
    };

    it("a grade sends the next card first and its voice last, within 5 Telegram and 10 D1 calls", async () => {
      const { h, update, easy } = await autoplaySession();
      const first = await update(() => h.text("/learn"));
      expect(first.methods).toEqual(["sendMessage", "sendVoice"]);
      voiceAfterCard(first, "китап");
      within(first);
      const second = await easy();
      // The old card and its voice are removed; the new voice is the last call.
      expect(second.methods).toEqual(["sendMessage", "deleteMessage", "deleteMessage", "answerCallbackQuery", "sendVoice"]);
      voiceAfterCard(second, "вакыт");
      within(second);
    });

    it.each(["tt_ru", "both"] as const)("the grade that opens a level stays within the caps, direction %s", async (direction) => {
      const { h, update, easy } = await autoplaySession(direction);
      within(await update(() => h.text("/learn")));
      within(await easy());
      const opening = await easy();
      expect(h.lastText().startsWith(ru.levelUp(1, 2, 31))).toBe(true);
      expect(opening.methods).toEqual(["sendMessage", "deleteMessage", "deleteMessage", "answerCallbackQuery", "sendVoice"]);
      voiceAfterCard(opening, "авыл");
      within(opening);
    });

    it("undo with autoplay stays within the caps and sends the voice after the restored card", async () => {
      const { h, update, easy, cardMessage } = await autoplaySession();
      await h.text("/learn");
      await easy();
      const undo = await update(() => h.press("u", cardMessage()));
      expect(undo.methods).toEqual(["sendMessage", "deleteMessage", "deleteMessage", "answerCallbackQuery", "sendVoice"]);
      expect(undo.calls[3]!.payload.text).toBe(ru.undone);
      voiceAfterCard(undo, "китап");
      within(undo);
    });

    it("a card without a voice gets none, and the update is back within the ordinary budget", async () => {
      const { h, easy } = await autoplaySession();
      await env.DB.prepare("UPDATE notes SET audio_file_id = NULL WHERE word = 'вакыт'").run();
      await h.text("/learn");
      const second = await easy();
      // The voice of the first card is removed with it; the second card has no voice to send.
      expect(second.methods).toEqual(["sendMessage", "deleteMessage", "deleteMessage", "answerCallbackQuery"]);
      expect(second.d1).toBeLessThanOrEqual(8);
    });
  });

  it("text with a link shows a preview with the link host; url-only asks for words", async () => {
    const f = (async () =>
      json({ choices: [{ message: { content: JSON.stringify({ cards: [{ input: "рәхмәт", lang: "tt", word: "рәхмәт", pos: "intj", translation: "спасибо", exampleTt: "Зур рәхмәт!", exampleRu: "Большое спасибо!" }] }) } }] })
    ) as typeof fetch;
    const h = harness(env.DB, { now: T, fetch: f });
    await h.text("/start");
    const repo = new Repo(env.DB);
    await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
    await h.text("рәхмәт https://example.com/a", [{ type: "url", offset: 7, length: 21 }]);
    expect(h.tg.of("sendMessage").at(-1)!.payload.text).toBe("🔎 Ищу слова…");
    expect(h.lastText()).toBe(`<b>рәхмәт</b>\n[рәхмә́т] · <i>межд.</i>\n\n<b>спасибо</b><blockquote><i>Зур рәхмәт!</i>\nБольшое спасибо!</blockquote>\n🔗 example.com\n${ru.aiNote}`);
    await h.press(callbacks(h.lastMarkup())[0]!, 300);
    expect(h.lastText()).toContain("✅ Добавлено");
    expect(h.lastText()).toContain("<b>рәхмәт</b>");
    await h.text("https://youtu.be/q", [{ type: "url", offset: 0, length: 18 }]);
    expect(h.lastText()).toContain("youtu.be");
  });

  it("/gen shows the deck with transcriptions and the AI note, and the button adds it", async () => {
    const cards = ["сәяхәт", "юл", "билет", "вокзал", "чемодан"].map((w, i) => ({ input: w, lang: "tt", word: w, pos: "n", translation: `слово ${i}`, exampleTt: `Бу ${w}.`, exampleRu: `Это слово ${i}.` }));
    const f = (async () => json({ choices: [{ message: { content: JSON.stringify({ cards }) } }] })) as typeof fetch;
    const h = harness(env.DB, { now: T, fetch: f });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    await h.text("/gen в <дороге>");
    expect(h.lastText()).toBe([
      ru.genTitle("в &lt;дороге&gt;", 5), "",
      "• <b>сәяхәт</b> [сәйәхә́т] · <i>сущ.</i> — слово 0", "• <b>юл</b> [йул] · <i>сущ.</i> — слово 1", "• <b>билет</b> [биле́т] · <i>сущ.</i> — слово 2",
      `• <b>вокзал</b> [${transcribe("вокзал")}] · <i>сущ.</i> — слово 3`, `• <b>чемодан</b> [${transcribe("чемодан")}] · <i>сущ.</i> — слово 4`,
      "", ru.genLeft(2), ru.aiNote,
    ].join("\n"));
    await h.press(callbacks(h.lastMarkup())[0]!, 300);
    expect(h.lastText()).toContain("✅ Колода");
    const decks = await repo.ownDecks(u.id);
    expect(decks.map((d) => [d.kind, d.total])).toEqual([["ai", 5]]);
    const { results } = await env.DB.prepare("SELECT word, transcription, example_src FROM notes WHERE deck_id = ? ORDER BY id").bind(decks[0]!.id).all();
    expect(results).toEqual([
      { word: "сәяхәт", transcription: "сәйәхә́т", example_src: "ai" }, { word: "юл", transcription: "йул", example_src: "ai" }, { word: "билет", transcription: "биле́т", example_src: "ai" },
      { word: "вокзал", transcription: transcribe("вокзал"), example_src: "ai" }, { word: "чемодан", transcription: transcribe("чемодан"), example_src: "ai" },
    ]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 0 });
  });

  describe("long input", () => {
    /** An 80-character phrase, different for every `i`; «я» doubles in the transcription. */
    const phrase = (i: number) => `${"яя ".repeat(26)}${String(i).padStart(2, "0")}`;
    /** A model that answers every line it is asked about with a card at the field maxima. */
    const maximal = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const prompt = (JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages[1]!.content;
      const cards = prompt.split("\n").slice(1).map((line) => ({
        input: line, lang: "tt", word: line, pos: "post", translation: "я".repeat(200), exampleTt: "ә".repeat(300), exampleRu: "я".repeat(300),
      }));
      return json({ choices: [{ message: { content: JSON.stringify({ cards }) } }] });
    }) as typeof fetch;
    async function ready(lang: "ru" | "tt", f?: typeof fetch) {
      const h = harness(env.DB, { now: T, fetch: f });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null, lang });
      return { h, repo, u };
    }
    /** An AI deck of the user under a 100-character topic, holding the phrases 0…n-1. */
    async function ownDeck(repo: Repo, userId: number, n: number) {
      const title = `🤖 ${"т".repeat(100)}`;
      const deckId = await repo.insertDeck({ slug: null, kind: "ai", titleRu: title, titleTt: title, levelNo: null, coveragePct: null, ownerId: userId });
      await repo.insertNotes(deckId, Array.from({ length: n }, (_, i) => note(phrase(i))));
      await repo.subscribe(userId, deckId, T);
    }
    const LINK = `https://${"a".repeat(480)}.example/x`;
    const message = (from: number, to: number) => [...Array.from({ length: to - from }, (_, i) => phrase(from + i)), LINK].join("\n");

    it.each(["ru", "tt"] as const)("20 new phrases at the field maxima are answered in one message, %s", async (lang) => {
      const { h } = await ready(lang, maximal);
      await h.text(message(0, 20));
      expect(h.lastText()).toContain((lang === "ru" ? ru : tt).foundN(20));
      const lines = h.lastText().split("\n").filter((l) => l.startsWith("• "));
      expect(lines).toHaveLength(20);
      expect(new Set(lines).size).toBe(20);
      // Twenty phrases leave room for every word as typed: only transcriptions and the ends of the translations go.
      for (let i = 0; i < 20; i++) expect(lines[i]).toContain(`<b>${phrase(i)}</b>`);
      expect(visibleLength(h.lastText())).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    });

    it.each(["ru", "tt"] as const)("19 known phrases that get the link and one new card shown whole fit one message, %s", async (lang) => {
      const { h, repo, u } = await ready(lang, maximal);
      await ownDeck(repo, u.id, 19);
      await h.text(message(0, 20));
      const text = h.lastText();
      const known = text.split("\n").filter((l) => l.startsWith("ℹ️"));
      expect(known).toHaveLength(19);
      // The known phrases differ only in their last word, and each line still shows which one it is about.
      expect(new Set(known).size).toBe(19);
      known.forEach((l, i) => expect(l).toContain(`${String(i).padStart(2, "0")}»`));
      expect(text).toContain("🔗,"); // the link was attached and the line says so
      // The new card is whole: word, transcription, translation and both examples.
      expect(text).toContain(`<b>${phrase(19)}</b>\n[`);
      expect(text).toContain(`<b>${"я".repeat(200)}</b><blockquote><i>${"ә".repeat(300)}</i>\n${"я".repeat(300)}</blockquote>`);
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    });

    it.each(["ru", "tt"] as const)("20 known phrases, and 19 with one left for a manual translation, fit one message, %s", async (lang) => {
      const { h, repo, u } = await ready(lang);
      await ownDeck(repo, u.id, 20);
      await h.text(message(0, 20));
      expect(h.lastText().split("\n").filter((l) => l.startsWith("ℹ️"))).toHaveLength(20);
      expect(visibleLength(h.lastText())).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      await h.text(message(1, 21)); // the model is down: the one new phrase is asked for by hand
      expect(h.lastText()).toContain((lang === "ru" ? ru : tt).manualAsk(phrase(20)));
      expect(visibleLength(h.lastText())).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    });

    it("the model is down for 20 new phrases: the list of untranslated ones fits one message", async () => {
      const { h } = await ready("tt");
      await h.text(message(0, 20));
      expect(h.lastText()).toContain(tt.manualAsk(phrase(0)));
      // The list fits, so every phrase is named whole.
      for (let i = 1; i < 20; i++) expect(h.lastText()).toContain(phrase(i));
      expect(h.lastText()).not.toContain("…");
      expect(visibleLength(h.lastText())).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    });

    it("a line of more than 80 characters is answered with a request for a shorter text, and the model is not asked", async () => {
      let asked = 0;
      const { h } = await ready("ru", (async () => { asked++; return json({}, 500); }) as typeof fetch);
      await h.text(`матур\n${"сүз ".repeat(20)}я`);
      expect(h.lastText()).toBe(ru.tooLong(80));
      expect(asked).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM previews").first()).toEqual({ n: 0 });
    });

    it("a hand-typed translation of more than 200 characters is refused and a shorter one is still awaited", async () => {
      const { h, repo, u } = await ready("ru");
      await h.text("матур");
      expect(h.lastText()).toBe(ru.manualAsk("матур"));
      await h.text("я".repeat(201));
      expect(h.lastText()).toBe(ru.tooLong(200));
      expect((await repo.getUser(u.id))!.pendingEdit).not.toBeNull();
      await h.text("красивый");
      expect(h.lastText()).toBe(ru.added("<b>матур</b>"));
      expect(await env.DB.prepare("SELECT word, translation FROM notes").all().then((r) => r.results)).toEqual([{ word: "матур", translation: "красивый" }]);
    });

    it("the same when a preview is being edited", async () => {
      const { h, repo, u } = await ready("ru", maximal);
      await h.text("зур");
      await h.press(callbacks(h.lastMarkup())[1]!, 300); // ✏️
      expect(h.lastText()).toBe(ru.editAsk("зур"));
      await h.text("я".repeat(201));
      expect(h.lastText()).toBe(ru.tooLong(200));
      expect((await repo.getUser(u.id))!.pendingEdit).not.toBeNull();
      await h.text("большой");
      expect(h.lastText()).toContain("<b>большой</b>");
      expect(h.lastText()).not.toContain(ru.aiNote);
    });
  });

  describe("a preview that is being edited", () => {
    const HOUR = 3_600_000;
    /** The learner typed «матур», got the preview and pressed ✏️: the bot waits for a translation. */
    async function editing() {
      const h = harness(env.DB, { now: T, fetch: echoLlm() });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null });
      await h.text("матур");
      const preview = h.tg.lastMessageId();
      const [add, edit, cancel] = callbacks(h.lastMarkup()) as [string, string, string];
      await h.press(edit, preview);
      expect(h.lastText()).toBe(ru.editAsk("матур"));
      expect((await repo.getUser(u.id))!.pendingEdit).not.toBeNull();
      return { h, repo, u, preview, add, cancel };
    }
    /** The next typed word is answered with its own preview: the add flow works. */
    async function expectNewWordIsPreviewed(h: ReturnType<typeof harness>, word = "зур") {
      await h.text(word);
      expect(h.lastText()).toContain(`<b>${word}</b>`);
      expect(h.lastText()).not.toBe(ru.previewExpired);
      expect(callbacks(h.lastMarkup())[0]).toMatch(/^add:ok:\d+$/);
    }

    it("the request for a translation is sent as HTML, so a quote in the word is shown as a quote", async () => {
      const h = harness(env.DB, { now: T, fetch: echoLlm() });
      await h.text("/start");
      const repo = new Repo(env.DB);
      await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
      await h.text('ул "әйе" диде');
      await h.press(callbacks(h.lastMarkup())[1]!, h.tg.lastMessageId());
      const ask = h.tg.of("sendMessage").at(-1)!.payload;
      expect(ask.text).toBe(ru.editAsk("ул &quot;әйе&quot; диде"));
      expect(ask.parse_mode).toBe("HTML");
    });

    it("✏️, then ✅: the word is added and the next typed word starts a new preview", async () => {
      const { h, repo, u, preview, add } = await editing();
      await h.press(add, preview);
      expect(h.lastText()).toBe(ru.added("<b>матур</b>"));
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
      await expectNewWordIsPreviewed(h);
      await expectNewWordIsPreviewed(h, "кечкенә");
      expect(await env.DB.prepare("SELECT word, translation FROM notes ORDER BY id").all().then((r) => r.results)).toEqual([{ word: "матур", translation: "перевод" }]);
    });

    it("✏️, then ✖️: nothing is added and the next typed word starts a new preview", async () => {
      const { h, repo, u, preview, cancel } = await editing();
      await h.press(cancel, preview);
      expect(h.lastText()).toBe(ru.notAdded);
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
      await expectNewWordIsPreviewed(h);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first()).toEqual({ n: 0 });
    });

    it("✏️, then the preview expires: the next typed word starts a new preview", async () => {
      const { h, repo, u } = await editing();
      h.setNow(T + 25 * HOUR);
      await expectNewWordIsPreviewed(h);
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
      // The old preview was not touched by the text.
      expect(await env.DB.prepare("SELECT payload FROM previews ORDER BY id LIMIT 1").first<{ payload: string }>().then((r) => r!.payload)).toContain("перевод");
    });

    it("✏️, then the preview is gone: a message longer than a translation may be is still taken as words", async () => {
      const { h, repo, u } = await editing();
      await env.DB.prepare("DELETE FROM previews").run();
      const words = Array.from({ length: 20 }, (_, i) => `озынсүз${"а".repeat(i + 1)}`);
      expect(words.join("\n").length).toBeGreaterThan(200);
      await h.text(words.join("\n"));
      expect(h.lastText()).toContain(ru.foundN(20));
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
    });

    it("a state left by an earlier version of the bot (a preview that was added long ago) no longer blocks adding", async () => {
      const h = harness(env.DB, { now: T, fetch: echoLlm() });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null, pendingEdit: JSON.stringify({ preview: { previewId: 12345 } }) });
      await expectNewWordIsPreviewed(h);
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
    });

    it("✅ on another preview leaves the edit alone: the typed text is still the translation of the edited one", async () => {
      const { h, repo, u } = await editing();
      const other = await new ContentService(repo, { llm: new LlmClient([{ baseUrl: "https://llm/v1", apiKey: "k", model: "m" }], echoLlm()) }, T).prepareAdd((await repo.getUser(u.id))!, "зур", []);
      if (other.kind !== "preview") throw new Error(other.kind);
      await h.press(`add:ok:${other.previewId}`, 900);
      expect(h.lastText()).toBe(ru.added("<b>зур</b>"));
      expect((await repo.getUser(u.id))!.pendingEdit).not.toBeNull();
      await h.text("красивый");
      expect(h.lastText()).toContain("<b>матур</b>");
      expect(h.lastText()).toContain("<b>красивый</b>");
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
    });
  });

  describe("a translation asked for by hand", () => {
    const MINUTE = 60_000;
    const notesCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>())!.n;
    /** The model is down: the learner typed «матур» and the bot asks for its translation. */
    async function asked(lang: "ru" | "tt" = "ru") {
      const h = harness(env.DB, { now: T });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null, lang });
      await h.text("матур");
      const prompt = h.tg.lastMessageId();
      expect(h.lastText()).toBe((lang === "ru" ? ru : tt).manualAsk("матур"));
      return { h, repo, u, prompt };
    }

    it.each(["ru", "tt"] as const)("the request carries a ✖️ button, %s", async (lang) => {
      const { h } = await asked(lang);
      const buttons = (h.lastMarkup().inline_keyboard ?? []).flat();
      expect(buttons.map((b) => b.text)).toEqual(["✖️"]);
      expect(buttons[0]!.callback_data).toMatch(/^add:skip:\d+$/);
    });

    it("✖️ ends the wait: the request is replaced, and the next text is a new word, not a translation", async () => {
      const { h, repo, u, prompt } = await asked();
      await h.press(callbacks(h.lastMarkup())[0]!, prompt);
      expect(h.tg.of("editMessageText").at(-1)!.payload).toMatchObject({ message_id: prompt, text: ru.notAdded });
      expect(h.lastMarkup().inline_keyboard).toBeUndefined();
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
      expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBeUndefined();
      await h.text("зур");
      expect(h.lastText()).toBe(ru.manualAsk("зур"));
      expect(await notesCount()).toBe(0);
      // The translation of the second word is taken as before.
      await h.text("большой");
      expect(await env.DB.prepare("SELECT word, translation FROM notes").all().then((r) => r.results)).toEqual([{ word: "зур", translation: "большой" }]);
    });

    it("the wait ends after 10 minutes: a text that comes later is a new word", async () => {
      const { h, repo, u } = await asked();
      h.setNow(T + 10 * MINUTE + 1);
      await h.text("зур");
      expect(h.lastText()).toBe(ru.manualAsk("зур"));
      expect(await notesCount()).toBe(0);
      // The wait is for «зур» now, from this message on.
      expect(JSON.parse((await repo.getUser(u.id))!.pendingEdit!)).toEqual({ manual: { word: "зур", url: null, at: T + 10 * MINUTE + 1 } });
    });

    it("a translation that comes within 10 minutes is stored", async () => {
      const { h } = await asked();
      h.setNow(T + 10 * MINUTE);
      await h.text("красивый");
      expect(h.lastText()).toBe(ru.added("<b>матур</b>"));
      expect(await env.DB.prepare("SELECT word, translation FROM notes").all().then((r) => r.results)).toEqual([{ word: "матур", translation: "красивый" }]);
    });

    it("a command typed while the bot waits is a command and is never stored as the translation", async () => {
      const { h, repo, u } = await asked();
      await h.text("/help");
      expect(h.lastText()).toBe(ru.help);
      await h.text("/levels");
      expect(h.lastText()).toContain(ru.levelsTitle);
      await h.text("/кушымта");
      expect(h.lastText()).toBe(ru.unknownCommand);
      await h.text("/gen");
      expect(h.lastText()).toBe(ru.genUsage);
      expect(await notesCount()).toBe(0);
      expect((await repo.getUser(u.id))!.pendingEdit).not.toBeNull();
      await h.text("красивый");
      expect(await env.DB.prepare("SELECT word, translation FROM notes").all().then((r) => r.results)).toEqual([{ word: "матур", translation: "красивый" }]);
    });

    it("✖️ of an earlier request does not end the wait for a later word, and is answered like a stale button", async () => {
      const { h, repo, u, prompt } = await asked();
      const first = callbacks(h.lastMarkup())[0]!;
      h.setNow(T + 11 * MINUTE);
      await h.text("зур");
      const waiting = (await repo.getUser(u.id))!.pendingEdit;
      await h.press(first, prompt);
      expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe(ru.staleButton);
      expect((await repo.getUser(u.id))!.pendingEdit).toBe(waiting);
      // ✖️ pressed twice, and ✖️ after the wait has ended, are stale too.
      await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
      await h.press(callbacks(h.lastMarkup())[0] ?? first, h.tg.lastMessageId());
      expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe(ru.staleButton);
    });

    it("a wait left by an earlier version of the bot, without a time, has ended", async () => {
      const h = harness(env.DB, { now: T });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null, pendingEdit: JSON.stringify({ manual: { word: "иске", url: null } }) });
      await h.text("зур");
      expect(h.lastText()).toBe(ru.manualAsk("зур"));
      expect(await notesCount()).toBe(0);
    });

    it("✏️ on a preview waits for the translation for 10 minutes too", async () => {
      const h = harness(env.DB, { now: T, fetch: echoLlm() });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null });
      await h.text("матур");
      await h.press(callbacks(h.lastMarkup())[1]!, h.tg.lastMessageId());
      h.setNow(T + 10 * MINUTE + 1);
      await h.text("зур");
      // «зур» is a new word with its own preview, not the translation of «матур».
      expect(h.lastText()).toContain("<b>зур</b>");
      expect(h.lastText()).not.toContain("матур");
      expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
      expect(await env.DB.prepare("SELECT payload FROM previews ORDER BY id LIMIT 1").first<{ payload: string }>().then((r) => r!.payload)).toContain("перевод");
    });
  });

  describe("the daily limit of messages with words", () => {
    async function ready(lang: "ru" | "tt", patch: Record<string, unknown> = {}) {
      const h = harness(env.DB, { now: T, fetch: echoLlm() });
      await h.text("/start");
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      await repo.updateUser(u.id, { onboardingStep: null, lang, ...patch });
      return { h, repo, u };
    }

    it.each([["ru", ru], ["tt", tt]] as const)("the 51st message of the day is answered with the limit text, in one message, %s", async (lang, t) => {
      const { h, repo, u } = await ready(lang, { addsDay: "2026-09-30", addsCount: 49 });
      await h.text("матур");
      expect(h.lastText()).toContain("<b>матур</b>");
      expect((await repo.getUser(u.id))!.addsCount).toBe(50);
      const before = h.tg.calls.length;
      await h.text("зур");
      expect(h.tg.calls.slice(before).map((c) => [c.method, c.payload.text])).toEqual([["sendMessage", t.addLimit(50)]]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM previews").first()).toEqual({ n: 1 });
      // The next local day words are taken again.
      h.setNow(T + 24 * 3_600_000);
      await h.text("зур");
      expect(h.lastText()).toContain("<b>зур</b>");
    });

    it("a translation typed by hand and a command are not messages with words", async () => {
      const { h, repo, u } = await ready("ru");
      await h.text("матур");
      await h.press(callbacks(h.lastMarkup())[1]!, h.tg.lastMessageId()); // ✏️
      await h.text("красивый");
      await h.text("/help");
      expect((await repo.getUser(u.id))!.addsCount).toBe(1);
    });

    it("counting a message costs no D1 call beyond the budget of the update", async () => {
      await seedCatalog(env.DB);
      const db = countingDb(env.DB);
      const h = harness(db, { now: T, fetch: echoLlm() });
      await h.text("/start");
      const repo = new Repo(env.DB);
      await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null, pendingUrl: "https://youtu.be/q", pendingUrlAt: T });
      db.calls = 0;
      await h.text("матур\nавыл\nэни");
      expect(h.lastText()).toContain(ru.foundN(3));
      expect(db.calls).toBeLessThanOrEqual(8);
    });
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
