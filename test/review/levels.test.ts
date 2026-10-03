import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ru } from "../../src/i18n/ru";
import { LAST_LEVEL, ReviewService, type Screen } from "../../src/review/service";
import { easyButton, harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { asCard, gradeShown, gradedMem } from "../helpers/review";
import { seedLevels, seedUser } from "../helpers/seed";

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 30, 6, 0); // 09:00 local (+03:00)
const levelUpOf = (s: Screen) => (s.kind === "card" || s.kind === "done" ? s.levelUp : undefined);
const subscriptions = async (userId: number) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM user_decks WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n;

describe("levels", () => {
  it("has twenty levels", () => {
    expect(LAST_LEVEL).toBe(20);
  });

  it("opens the next level exactly once when the open levels run out", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 2 });
    await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
    let s = await new ReviewService(repo, now).nextScreen(user);
    expect(s.kind === "card" && s.levelUp).toBeNull();
    s = await gradeShown(repo, user, s, 4, now);
    expect(s.kind === "card" && s.levelUp).toBeNull();
    expect((await repo.getUser(user.id))!.level).toBe(1);
    s = await gradeShown(repo, user, s, 4, now);
    expect(s.kind === "card" && s.levelUp).toEqual({ from: 1, to: 2, coveragePct: 31 });
    expect(s.kind === "card" && s.view.word).toBe("авыл");
    expect(s.kind === "card" && s.counts).toEqual({ n: 2, l: 0, r: 0 });
    const again = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
    expect(again.kind === "card" && again.levelUp).toBeNull();
    expect(again.kind === "card" && again.view.word).toBe("авыл");
    expect((await repo.getUser(user.id))!.level).toBe(2);
    expect(await subscriptions(user.id)).toBe(2);
  });

  it("two concurrent calls announce the level once", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now, level: 1, words: 2 });
    await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
    // Both words of level 1 are graded and not due today, so each call finds the open levels empty.
    for (const id of noteIds) await repo.insertCard(user.id, id, "tt_ru", gradedMem(now));
    const screens = await Promise.all([
      new ReviewService(repo, now).nextScreen(user),
      new ReviewService(repo, now).nextScreen(user),
    ]);
    expect(screens.filter((s) => s.kind === "card" && s.levelUp).length).toBe(1);
    expect(screens.map(levelUpOf).filter(Boolean)).toEqual([{ from: 1, to: 2, coveragePct: 31 }]);
    expect(screens.map((s) => asCard(s).view.word)).toEqual(["авыл", "авыл"]);
    expect(asCard(screens[0]!).view.cardId).toBe(asCard(screens[1]!).view.cardId);
    expect((await repo.getUser(user.id))!.level).toBe(2);
    expect(await subscriptions(user.id)).toBe(2);
  });

  it("does not open a level while the daily limit is used up", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 5, patch: { newPerDay: 5 } });
    await seedLevels(env.DB, { 2: ["өй", "эш"] }, { 1: 31 });
    let s = await new ReviewService(repo, now).nextScreen(user);
    for (let i = 0; i < 5; i++) {
      expect(levelUpOf(s)).toBeNull();
      s = await gradeShown(repo, user, s, 3, now);
    }
    // Five words graded Good: the limit is spent and level 1 has no new words left.
    expect(s.kind).toBe("done");
    expect(levelUpOf(s)).toBeNull();
    const again = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
    expect(levelUpOf(again)).toBeNull();
    expect((await repo.getUser(user.id))!.level).toBe(1);
    expect(await subscriptions(user.id)).toBe(1);
    // The next day the limit is free again and the level opens.
    const tomorrow = await new ReviewService(repo, now + DAY).nextScreen((await repo.getUser(user.id))!);
    expect(levelUpOf(tomorrow)).toEqual({ from: 1, to: 2, coveragePct: 31 });
    expect((await repo.getUser(user.id))!.level).toBe(2);
  });

  it("stays on the level when the next level is not in the database", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 2 });
    let s = await new ReviewService(repo, now).nextScreen(user);
    s = await gradeShown(repo, user, s, 4, now);
    s = await gradeShown(repo, user, s, 4, now);
    expect(s.kind).toBe("done");
    expect(levelUpOf(s)).toBeNull();
    expect((await repo.getUser(user.id))!.level).toBe(1);
    expect(await subscriptions(user.id)).toBe(1);
  });

  it("congratulates once after level 20", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 20, words: 2 });
    await seedLevels(env.DB, {}, { 20: 80 });
    let s = await new ReviewService(repo, now).nextScreen(user);
    s = await gradeShown(repo, user, s, 4, now);
    expect(levelUpOf(s)).toBeNull();
    s = await gradeShown(repo, user, s, 4, now);
    expect(s.kind).toBe("done");
    expect(levelUpOf(s)).toEqual({ from: 20, to: null, coveragePct: 80 });
    expect((await repo.getUser(user.id))!.level).toBe(21);
    const s2 = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
    expect(s2.kind).toBe("done");
    expect(levelUpOf(s2)).toBeNull();
    // A stale copy of the user (still level 20) does not congratulate again either.
    const stale = await new ReviewService(repo, now).nextScreen({ ...(await repo.getUser(user.id))!, level: 20 });
    expect(levelUpOf(stale)).toBeNull();
    expect((await repo.getUser(user.id))!.level).toBe(21);
    expect(await subscriptions(user.id)).toBe(1);
  });

  it("keeps the level open after undo and does not announce it again", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 2 });
    await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
    let s = await new ReviewService(repo, now).nextScreen(user);
    s = await gradeShown(repo, user, s, 4, now);
    const opened = await gradeShown(repo, user, s, 4, now);
    expect(levelUpOf(opened)).toEqual({ from: 1, to: 2, coveragePct: 31 });
    const afterUndo = await new ReviewService(repo, now).undo((await repo.getUser(user.id))!);
    expect(afterUndo.kind === "card" && afterUndo.view.word).toBe("вакыт");
    expect(afterUndo.kind === "card" && afterUndo.levelUp).toBeNull();
    expect((await repo.getUser(user.id))!.level).toBe(2);
    const regraded = await gradeShown(repo, user, afterUndo, 4, now);
    expect(regraded.kind === "card" && regraded.view.word).toBe("авыл");
    expect(regraded.kind === "card" && regraded.levelUp).toBeNull();
    expect((await repo.getUser(user.id))!.level).toBe(2);
    expect(await subscriptions(user.id)).toBe(2);
  });

  it("after opening skipped levels gives their words first and opens level 8 only when they are done", async () => {
    // Start at level 7 («китап»); levels 1 and 3 were skipped, level 8 is still closed.
    const { repo, user } = await seedUser(env.DB, { now, level: 7, words: 1 });
    await seedLevels(env.DB, { 1: ["авыл", "су"], 3: ["юл"], 8: ["көн"] }, { 7: 66 });
    expect(asCard(await new ReviewService(repo, now).nextScreen(user)).view.word).toBe("китап");
    expect(await repo.openSkippedLevels(user.id, now)).toBe(2);
    expect(await repo.openSkippedLevels(user.id, now)).toBe(0);
    expect(await subscriptions(user.id)).toBe(3);
    expect((await repo.getUser(user.id))!.level).toBe(7);

    let s = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
    const seen: string[] = [];
    for (const word of ["авыл", "су", "юл", "китап"]) {
      expect(asCard(s).view.word).toBe(word);
      expect(asCard(s).levelUp).toBeNull();
      expect((await repo.getUser(user.id))!.level).toBe(7);
      seen.push(asCard(s).view.word);
      s = await gradeShown(repo, user, s, 4, now);
    }
    expect(seen).toEqual(["авыл", "су", "юл", "китап"]);
    expect(asCard(s).view.word).toBe("көн");
    expect(asCard(s).levelUp).toEqual({ from: 7, to: 8, coveragePct: 66 });
    expect((await repo.getUser(user.id))!.level).toBe(8);
    expect(await subscriptions(user.id)).toBe(4);
  });

  it("spends at most 8 D1 calls on a grade that opens a level", async () => {
    await seedUser(env.DB, { now, level: 1, words: 2, tgId: 42 });
    await seedLevels(env.DB, { 2: ["авыл", "су"] }, { 1: 31 });
    const db = countingDb(env.DB);
    const h = harness(db, { now });
    await h.text("/learn");
    await h.press(easyButton(h), h.tg.lastMessageId());
    expect(h.lastText()).toContain("<b>вакыт</b>");
    const telegramBefore = h.tg.calls.length;
    db.calls = 0;
    await h.press(easyButton(h), h.tg.lastMessageId());
    const telegram = h.tg.calls.slice(telegramBefore).map((c) => c.method);
    expect(h.lastText().startsWith(ru.levelUp(1, 2, 31))).toBe(true);
    expect(h.lastText()).toContain("<b>авыл</b>");
    expect(db.calls).toBeLessThanOrEqual(8);
    expect(telegram.length).toBeLessThanOrEqual(3);
    expect(telegram).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
  });
});
