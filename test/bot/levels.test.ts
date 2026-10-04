import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderLevels } from "../../src/bot/screens";
import { renderLevelUp } from "../../src/bot/views";
import { Repo } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { newMem } from "../../src/srs/fsrs";
import type { LevelsView } from "../../src/stats/service";
import { easyButton, harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { note, seedLevels, seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
const buttons = (m: { inline_keyboard?: { text: string; callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);

/**
 * The picture from the brief: the learner (Telegram id 42) started at level 4 of 100 words; 36 words are graded, one more
 * is a copy in «Мои слова» (12 words), one was shown but not graded; an AI deck of 20 words; levels 1–3 cover 54%.
 * The catalog has six levels so far, so two are ahead.
 */
async function learnerAtLevel4(db: D1Database) {
  const level4 = Array.from({ length: 100 }, (_, i) => `сүз${i + 1}`);
  await seedLevels(db, { 1: ["китап", "вакыт"], 2: ["авыл", "су"], 3: ["юл", "көн"], 4: level4, 5: ["өй"], 6: ["эш"] }, { 3: 54, 4: 61 });
  const { repo, user, noteIds } = await seedUser(db, { now: T, level: 4, tgId: 42 });
  await repo.batch(noteIds.slice(0, 36).map((id) => repo.insertCardStmt(user.id, id, "tt_ru", gradedMem(T))));
  await repo.insertCard(user.id, noteIds[36]!, "tt_ru", newMem(T));
  await repo.insertNotes(await repo.customDeck(user.id, T), ["сүз100", ...Array.from({ length: 11 }, (_, i) => `үзем${i + 1}`)].map((w) => note(w)));
  const ai = await repo.insertDeck({ slug: null, kind: "ai", titleRu: "🤖 Путешествия", titleTt: "🤖 Путешествия", levelNo: null, coveragePct: null, ownerId: user.id });
  await repo.insertNotes(ai, Array.from({ length: 20 }, (_, i) => note(`сәяхәт${i + 1}`)));
  await repo.subscribe(user.id, ai, T);
  return { repo, user };
}

describe("/levels", () => {
  it("shows passed levels, the current one with progress, what is ahead, own decks, coverage and the button for skipped levels", async () => {
    await learnerAtLevel4(env.DB);
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe([
      "📚 <b>Уровни</b>",
      "⏭ Пропущено: 1–3",
      "▶️ Уровень 4 · 37 из 100",
      "🔒 Впереди: 2",
      "📝 Мои слова · 12",
      "🤖 Путешествия · 20",
      "📖 Покрытие текста ≈54%",
    ].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([["Открыть пропущенные (1–3)", "lv:skip"]]);
    expect(h.tg.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(db.calls).toBeLessThanOrEqual(8);
  });

  it("opens the skipped levels with the button and then shows no button", async () => {
    const { repo, user } = await learnerAtLevel4(env.DB);
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/levels");
    const screen = h.tg.lastMessageId();
    const telegramBefore = h.tg.calls.length;
    db.calls = 0;
    await h.press("lv:skip", screen);
    expect(h.tg.calls.slice(telegramBefore).map((c) => c.method)).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(db.calls).toBeLessThanOrEqual(8);
    const edit = h.tg.of("editMessageText").at(-1)!;
    expect(edit.payload.message_id).toBe(screen);
    expect(edit.payload.reply_markup).toBeUndefined();
    expect(edit.payload.text).toBe([
      "📚 <b>Уровни</b>",
      "▶️ Уровень 1 · 0 из 2",
      "▶️ Уровень 2 · 0 из 2",
      "▶️ Уровень 3 · 0 из 2",
      "▶️ Уровень 4 · 37 из 100",
      "🔒 Впереди: 2",
      "📝 Мои слова · 12",
      "🤖 Путешествия · 20",
      "📖 Покрытие текста ≈54%",
    ].join("\n"));
    expect((await repo.getUser(user.id))!.level).toBe(4);
    const open = await env.DB.prepare("SELECT d.level_no FROM user_decks ud JOIN decks d ON d.id = ud.deck_id WHERE ud.user_id = ? AND d.level_no IS NOT NULL ORDER BY d.level_no")
      .bind(user.id).all<{ level_no: number }>();
    expect(open.results.map((r) => r.level_no)).toEqual([1, 2, 3, 4]);
    await h.text("/levels");
    expect(buttons(h.lastMarkup())).toEqual([]);
  });

  it("is in Tatar for a tt user", async () => {
    const { repo, user } = await learnerAtLevel4(env.DB);
    await repo.updateUser(user.id, { lang: "tt" });
    const h = harness(env.DB, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe([
      "📚 <b>Дәрәҗәләр</b>",
      tt.levelsSkipped("1–3"),
      "▶️ 4 нче дәрәҗә · 37/100",
      tt.levelsAhead(2),
      "📝 Минем сүзләр · 12",
      "🤖 Путешествия · 20",
      tt.levelsCoverage(54),
    ].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([[tt.openSkippedBtn("1–3"), "lv:skip"]]);
  });

  it("the «Уровни» button of the done screen opens the same screen", async () => {
    await seedUser(env.DB, { now: T, level: 1, words: 1, tgId: 42 });
    const h = harness(env.DB, { now: T });
    await h.text("/learn");
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText()).toContain(ru.doneTitle);
    expect(buttons(h.lastMarkup())).toEqual([[ru.addWords, "help:add"], ["📚 Уровни", "levels"]]);
    await h.press("levels", h.tg.lastMessageId());
    // Level 1 is the only level published: nothing is said about levels ahead.
    expect(h.lastText()).toBe(["📚 <b>Уровни</b>", "▶️ Уровень 1 · 1 из 1"].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([]);
  });

  it("a learner placed above the only published level sees it as skipped, with no current level and nothing ahead", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 2, tgId: 42 });
    await env.DB.prepare("DELETE FROM user_decks").run();
    await repo.updateUser(user.id, { level: 7 });
    const h = harness(env.DB, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe(["📚 <b>Уровни</b>", "⏭ Пропущено: 1"].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([["Открыть пропущенные (1)", "lv:skip"]]);
    await h.press("lv:skip", h.tg.lastMessageId());
    expect(h.tg.of("editMessageText").at(-1)!.payload.text).toBe(["📚 <b>Уровни</b>", "▶️ Уровень 1 · 0 из 2"].join("\n"));
  });

  it("the empty screen offers the levels", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
    await h.text("/learn");
    expect(h.lastText()).toBe("Пока учить нечего. Откройте уровень в /levels или напишите боту своё слово.");
    expect(buttons(h.lastMarkup())).toEqual([["📚 Уровни", "levels"]]);
    await repo.updateUser((await repo.getUserByTg(42))!.id, { lang: "tt" });
    await h.text("/learn");
    expect(h.lastText()).toBe(tt.nothingToLearn);
    expect(buttons(h.lastMarkup())).toEqual([["📚 Дәрәҗәләр", "levels"]]);
  });

  it("/decks answers as an unknown command and the old deck buttons do nothing", async () => {
    const { repo, user } = await learnerAtLevel4(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/decks");
    expect(h.lastText()).toBe(ru.unknownCommand);
    const sent = h.tg.calls.length;
    await h.press("decks");
    await h.press(`sub:${(await repo.getDeckBySlug("l01"))!.id}`);
    expect(h.tg.calls.length).toBe(sent);
    expect(await repo.userDeckIds(user.id)).toHaveLength(3);
    expect(ru.help).toContain("/levels — уровни");
    expect(ru.help + tt.help).not.toContain("/decks");
    expect([ru.cmdLevels, tt.cmdLevels]).toEqual(["Уровни", "Дәрәҗәләр"]);
  });

  it("does not open skipped levels for a user who is still in onboarding", async () => {
    await seedLevels(env.DB, { 1: ["китап"], 7: ["авыл"] });
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { level: 7 });
    await h.press("lv:skip");
    expect(await repo.userDeckIds(u.id)).toEqual([]);
  });
});

describe("level-up line", () => {
  it("the card after the transition starts with the line about the level", async () => {
    await seedUser(env.DB, { now: T, level: 1, words: 2, tgId: 42 });
    await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
    const h = harness(env.DB, { now: T });
    await h.text("/learn");
    expect(h.lastText().startsWith("🔵 2 · 🔴 0 · 🟢 0\n<b>китап</b>")).toBe(true);
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText().startsWith("🔵 1 · 🔴 0 · 🟢 0\n<b>вакыт</b>")).toBe(true);
    await h.press(easyButton(h), h.tg.lastMessageId());
    // Level 1 of this test has two words, and the line names that number.
    const line = "Все 2 слова уровня 1 в работе. Открываю уровень 2. Пройденные слова покрывают ≈31% обычного текста.";
    expect(h.lastText().startsWith(`${line}\n\n🔵 2 · 🔴 0 · 🟢 0\n<b>авыл</b>`)).toBe(true);
    // The line is said once: the next card is plain again.
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText().startsWith("🔵 1 · 🔴 0 · 🟢 0\n<b>су</b>")).toBe(true);
  });

  it("after level 20 the done screen starts with the congratulation", async () => {
    await seedUser(env.DB, { now: T, level: 20, words: 1, tgId: 42 });
    await seedLevels(env.DB, {}, { 20: 80 });
    const h = harness(env.DB, { now: T });
    await h.text("/learn");
    await h.press(easyButton(h), h.tg.lastMessageId());
    const line = "Все 2 000 слов в работе! 🎉 Дальше — повторения по расписанию. Свои слова можно добавлять в любой момент.";
    expect(h.lastText().startsWith(`${line} Пройденные слова покрывают ≈80% обычного текста.\n\n${ru.doneTitle}`)).toBe(true);
    await h.text("/learn");
    expect(h.lastText().startsWith(ru.doneTitle)).toBe(true);
  });

  it("renderLevelUp picks the transition or the congratulation and leaves out unknown coverage", () => {
    expect(renderLevelUp({ from: 3, to: 4, coveragePct: 54, total: 100 }, "ru")).toBe("Все 100 слов уровня 3 в работе. Открываю уровень 4. Пройденные слова покрывают ≈54% обычного текста.");
    expect(renderLevelUp({ from: 3, to: 4, coveragePct: null, total: 100 }, "ru")).toBe("Все 100 слов уровня 3 в работе. Открываю уровень 4.");
    // The number is the level's own: a level that got a 101st word says so.
    expect(renderLevelUp({ from: 3, to: 4, coveragePct: null, total: 101 }, "ru")).toBe("Все 101 слово уровня 3 в работе. Открываю уровень 4.");
    expect(renderLevelUp({ from: 3, to: 4, coveragePct: null, total: 101 }, "tt")).toBe(tt.levelUp(3, 4, null, 101));
    // A level whose deck the catalog does not have (a gap) has no words to speak of.
    expect(renderLevelUp({ from: 3, to: 5, coveragePct: null, total: null }, "ru")).toBe("Открываю уровень 5.");
    expect(renderLevelUp({ from: 20, to: null, coveragePct: null, total: 100 }, "ru")).toBe("Все 2 000 слов в работе! 🎉 Дальше — повторения по расписанию. Свои слова можно добавлять в любой момент.");
    expect(renderLevelUp({ from: 5, to: 6, coveragePct: 61, total: 100 }, "tt")).toBe(tt.levelUp(5, 6, 61, 100));
    expect(renderLevelUp({ from: 20, to: null, coveragePct: 80, total: 100 }, "tt")).toBe(tt.levelsDone(80));
    expect(tt.levelUp(5, 6, 61, 100)).toContain("5 нче дәрәҗә");
    expect(tt.levelUp(5, 6, 61, 100)).toContain("6 нчы дәрәҗә");
    expect(tt.levelUp(5, 6, 61, 100)).toContain("≈61%");
    expect(tt.levelUp(5, 6, null, 100)).not.toContain("≈");
  });
});

describe("renderLevels", () => {
  const view = (over: Partial<LevelsView>): LevelsView => ({ passed: [], inProgress: [], ahead: 0, own: [], coveragePct: null, skipped: [], ...over });

  it("writes level numbers as ranges", () => {
    const r = renderLevels(view({ passed: [1, 3, 5, 7, 8], skipped: [2, 4, 6], inProgress: [{ levelNo: 9, seen: 0, total: 100 }], ahead: 11 }), "ru");
    expect(r.text).toBe(["📚 <b>Уровни</b>", "✅ Пройдено: 1, 3, 5, 7–8", "⏭ Пропущено: 2, 4, 6", "▶️ Уровень 9 · 0 из 100", "🔒 Впереди: 11"].join("\n"));
    expect(r.keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([["Открыть пропущенные (2, 4, 6)", "lv:skip"]]);
    // In Tatar, with the word the button uses.
    expect(renderLevels(view({ passed: [3], skipped: [1, 2] }), "tt").text).toBe(["📚 <b>Дәрәҗәләр</b>", "✅ Үтелгән: 3", "⏭ Калдырылган: 1–2"].join("\n"));
    // A learner who skipped nothing has no such line.
    expect(renderLevels(view({ passed: [1, 2] }), "ru").text).toBe(["📚 <b>Уровни</b>", "✅ Пройдено: 1–2"].join("\n"));
  });

  it("when every level is done shows neither a current level nor what is ahead", () => {
    const all = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = renderLevels(view({ passed: all, coveragePct: 80 }), "ru");
    expect(r.text).toBe(["📚 <b>Уровни</b>", "✅ Пройдено: 1–20", "📖 Покрытие текста ≈80%"].join("\n"));
    expect(r.keyboard).toEqual([]);
  });

  it("escapes the title of an own deck", () => {
    const r = renderLevels(view({ own: [{ kind: "ai", titleRu: "🤖 <b>x&y", titleTt: "🤖 <b>x&y", total: 3 }] }), "ru");
    expect(r.text).toContain("🤖 &lt;b&gt;x&amp;y · 3");
  });
});
