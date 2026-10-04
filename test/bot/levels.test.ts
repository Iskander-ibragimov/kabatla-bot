import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderLevels } from "../../src/bot/screens";
import { Repo } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import type { Hub } from "../../src/levels/service";
import { newMem } from "../../src/srs/fsrs";
import { easyButton, harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { note, recountProgress, seedCatalog, seedLearner, seedLevels, seedTopics, seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
const buttons = (m: { inline_keyboard?: { text: string; callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);

/**
 * The learner at the bot (Telegram id 42) has A1 and A2 checked. A1: 40 words, 36 graded and one more shown but not
 * graded; it covers 45% of a text. A2: 3 words, none started. B1 has two words and is not checked. «Мои слова» holds
 * 12 words, an AI deck 20.
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

// The screen of this task is a stand-in built from the texts the bot has: the levels screen proper comes with the
// bot screens of the plan (hub, checkboxes, topics). What is pinned here is that its numbers are the learner's.
describe("/levels", () => {
  it("shows every checked level with the words started of those it has, the own decks and the coverage; no button", async () => {
    await learnerInA1(env.DB);
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe([
      "📚 <b>Уровни</b>",
      "▶️ Уровень 1 · 36 из 40",
      "▶️ Уровень 2 · 0 из 3",
      "📝 Мои слова · 12",
      "🤖 Путешествия · 20",
    ].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([]);
    expect(h.tg.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(db.calls).toBeLessThanOrEqual(8);
  });

  it("names the coverage of the levels that are started whole", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const left = await env.DB.prepare("SELECT id FROM notes WHERE level = 1 AND id NOT IN (SELECT note_id FROM cards WHERE user_id = ?1 AND state != 'new') ORDER BY id").bind(user.id).all<{ id: number }>();
    for (const n of left.results) await repo.updateCardStmt(await repo.ensureNewCard(user.id, n.id, "tt_ru", newMem(T)), gradedMem(T)).run();
    await recountProgress(env.DB, user.id);
    const h = harness(env.DB, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe([
      "📚 <b>Уровни</b>",
      "▶️ Уровень 1 · 40 из 40",
      "▶️ Уровень 2 · 0 из 3",
      "📝 Мои слова · 12",
      "🤖 Путешествия · 20",
      "📖 Покрытие текста ≈45%",
    ].join("\n"));
  });

  it("the button of the old screen that opened skipped levels answers that it is out of date and changes nothing", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.press("lv:skip");
    expect(h.tg.calls.map((c) => [c.method, c.payload.text])).toEqual([["answerCallbackQuery", ru.staleButton]]);
    expect(db.calls).toBeLessThanOrEqual(8);
    expect(await repo.getUser(user.id)).toEqual(user);
    expect(await repo.userDeckIds(user.id)).toHaveLength(2);
  });

  it("is in Tatar for a tt user", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    await repo.updateUser(user.id, { lang: "tt" });
    const h = harness(env.DB, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe([
      "📚 <b>Дәрәҗәләр</b>",
      "▶️ 1 нче дәрәҗә · 36/40",
      "▶️ 2 нче дәрәҗә · 0/3",
      "📝 Минем сүзләр · 12",
      "🤖 Путешествия · 20",
    ].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([]);
  });

  it("the «Уровни» button of the done screen opens the same screen", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "китап" }]);
    await seedLearner(env.DB, { now: T, tgId: 42 });
    const h = harness(env.DB, { now: T });
    await h.text("/learn");
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText()).toContain(ru.doneTitle);
    expect(buttons(h.lastMarkup())).toEqual([[ru.addWords, "help:add"], ["📚 Уровни", "levels"]]);
    await h.press("levels", h.tg.lastMessageId());
    expect(h.lastText()).toBe(["📚 <b>Уровни</b>", "▶️ Уровень 1 · 1 из 1"].join("\n"));
    expect(buttons(h.lastMarkup())).toEqual([]);
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
    // A learner who has nothing at all still gets the screen: its title alone, for the checked level has no cards.
    await repo.updateUser((await repo.getUserByTg(42))!.id, { lang: "ru" });
    await h.press("levels", h.tg.lastMessageId());
    expect(h.lastText()).toBe("📚 <b>Уровни</b>");
  });

  it("/decks answers as an unknown command and the old deck buttons do nothing", async () => {
    const { repo, user } = await learnerInA1(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/decks");
    expect(h.lastText()).toBe(ru.unknownCommand);
    const sent = h.tg.calls.length;
    await h.press("decks");
    await h.press(`sub:${(await repo.getDeckBySlug("a2"))!.id}`);
    expect(h.tg.calls.length).toBe(sent);
    expect(await repo.userDeckIds(user.id)).toHaveLength(2);
    expect(ru.help).toContain("/levels — уровни");
    expect(ru.help + tt.help).not.toContain("/decks");
    expect([ru.cmdLevels, tt.cmdLevels]).toEqual(["Уровни", "Дәрәҗәләр"]);
  });
});

describe("the bot opens no level by itself", () => {
  it("when the checked level has no word left the session ends with no line about a level; nothing is opened or checked", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 2, tgId: 42 });
    await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
    const h = harness(env.DB, { now: T });
    await h.text("/learn");
    expect(h.lastText().startsWith("🔵 10 · 🔴 0 · 🟢 0\n<b>китап</b>")).toBe(true);
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText().startsWith("🔵 10 · 🔴 0 · 🟢 0\n<b>вакыт</b>")).toBe(true);
    await h.press(easyButton(h), h.tg.lastMessageId());
    // Level 2 has words, and the screen that ends the session knows why no new word came; it is shown without that reason for now.
    expect(h.lastText()).toBe([ru.doneTitle, ru.doneToday(2, 0), ru.streak(1)].join("\n"));
    expect(await repo.getUser(user.id)).toMatchObject({ level: 1, levels: 1 });
    expect(await repo.userDeckIds(user.id)).toHaveLength(1);
    await h.text("/learn");
    expect(h.lastText().startsWith(ru.doneTitle)).toBe(true);
  });
});

describe("renderLevels", () => {
  const hubOf = (over: Partial<Hub>): Hub => ({ levels: [], mode: "guided", posGroups: 255, topic: null, own: [], ...over });
  const level = (no: 1 | 2 | 3 | 4 | 5, checked: boolean, started: number, total: number, coveragePct: number | null = null) =>
    ({ no, code: `L${no}`, checked, total, size: 850, started, coveragePct });

  it("has a line for a checked level that has cards, and none for an unchecked or an empty one", () => {
    const r = renderLevels(hubOf({ levels: [level(1, true, 400, 400, 45), level(2, false, 3, 850, 60), level(3, true, 0, 20), level(4, true, 0, 0)] }), "ru");
    expect(r.text).toBe(["📚 <b>Уровни</b>", "▶️ Уровень 1 · 400 из 400", "▶️ Уровень 3 · 0 из 20", "📖 Покрытие текста ≈45%"].join("\n"));
    expect(r.keyboard).toEqual([]);
  });

  it("escapes the title of an own deck", () => {
    const r = renderLevels(hubOf({ own: [{ kind: "ai", titleRu: "🤖 <b>x&y", titleTt: "🤖 <b>x&y", total: 3 }] }), "ru");
    expect(r.text).toContain("🤖 &lt;b&gt;x&amp;y · 3");
  });
});
