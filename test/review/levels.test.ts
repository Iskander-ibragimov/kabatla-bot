import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
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

  describe("a catalog with gaps", () => {
    it("opens the next level that exists, sets users.level to it and names it", async () => {
      const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 1 });
      const ids = await seedLevels(env.DB, { 3: ["авыл"], 4: ["су"] }, { 1: 31 });
      let s = await new ReviewService(repo, now).nextScreen(user);
      s = await gradeShown(repo, user, s, 4, now);
      expect(levelUpOf(s)).toEqual({ from: 1, to: 3, coveragePct: 31 });
      expect(asCard(s).view.word).toBe("авыл");
      expect((await repo.getUser(user.id))!.level).toBe(3);
      expect(await repo.userDeckIds(user.id)).toEqual([(await repo.getDeckBySlug("l01"))!.id, ids[3]]);
      // Level 4 is opened only when level 3 is done, and it is the neighbour this time.
      s = await gradeShown(repo, user, s, 4, now);
      expect(levelUpOf(s)).toEqual({ from: 3, to: 4, coveragePct: null });
      expect((await repo.getUser(user.id))!.level).toBe(4);
      expect(await subscriptions(user.id)).toBe(3);
    });

    it("jumps over several missing levels at once", async () => {
      const { repo, user } = await seedUser(env.DB, { now, level: 2, words: 1 });
      await seedLevels(env.DB, { 1: ["су"], 9: ["авыл"] }, { 2: 40 });
      const s = await gradeShown(repo, user, await new ReviewService(repo, now).nextScreen(user), 4, now);
      // Level 1 is below the current one: it is a skipped level, not the next one.
      expect(levelUpOf(s)).toEqual({ from: 2, to: 9, coveragePct: 40 });
      expect(asCard(s).view.word).toBe("авыл");
      expect((await repo.getUser(user.id))!.level).toBe(9);
      expect(await subscriptions(user.id)).toBe(2);
    });

    it("two concurrent calls announce the level over a gap once", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now, level: 1, words: 2 });
      await seedLevels(env.DB, { 3: ["авыл", "су"] }, { 1: 31 });
      for (const id of noteIds) await repo.insertCard(user.id, id, "tt_ru", gradedMem(now));
      const screens = await Promise.all([
        new ReviewService(repo, now).nextScreen(user),
        new ReviewService(repo, now).nextScreen(user),
      ]);
      expect(screens.map(levelUpOf).filter(Boolean)).toEqual([{ from: 1, to: 3, coveragePct: 31 }]);
      expect(screens.map((s) => asCard(s).view.word)).toEqual(["авыл", "авыл"]);
      expect((await repo.getUser(user.id))!.level).toBe(3);
      expect(await subscriptions(user.id)).toBe(2);
      // A stale copy of the user (still level 1) neither announces again nor moves the level.
      const stale = await new ReviewService(repo, now).nextScreen(user);
      expect(levelUpOf(stale)).toBeNull();
      expect((await repo.getUser(user.id))!.level).toBe(3);
    });

    it("does nothing while no higher level is published: no congratulation, no change", async () => {
      // Level 19 is the last one published; level 1 below it was skipped.
      const { repo, user } = await seedUser(env.DB, { now, level: 19, words: 1 });
      await seedLevels(env.DB, { 1: ["су"] }, { 19: 79 });
      const s = await gradeShown(repo, user, await new ReviewService(repo, now).nextScreen(user), 4, now);
      expect(s.kind).toBe("done");
      expect(levelUpOf(s)).toBeNull();
      expect((await repo.getUser(user.id))!.level).toBe(19);
      expect(await subscriptions(user.id)).toBe(1);
      const again = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
      expect(levelUpOf(again)).toBeNull();
      expect((await repo.getUser(user.id))!.level).toBe(19);
      // When the level is published later, the next screen opens it.
      await seedLevels(env.DB, { 20: ["авыл"] });
      const later = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
      expect(levelUpOf(later)).toEqual({ from: 19, to: 20, coveragePct: 79 });
      expect(asCard(later).view.word).toBe("авыл");
    });

    it("a deck numbered above the last level is not a level to open", async () => {
      const { repo, user } = await seedUser(env.DB, { now, level: 20, words: 1 });
      await seedLevels(env.DB, { 22: ["авыл"] }, { 20: 80 });
      const s = await gradeShown(repo, user, await new ReviewService(repo, now).nextScreen(user), 4, now);
      expect(s.kind).toBe("done");
      expect(levelUpOf(s)).toEqual({ from: 20, to: null, coveragePct: 80 });
      expect((await repo.getUser(user.id))!.level).toBe(21);
      expect(await subscriptions(user.id)).toBe(1);
    });

    it("opening a level over a gap costs exactly one D1 call more than a plain next card", async () => {
      const { user, noteIds } = await seedUser(env.DB, { now, level: 1, words: 2 });
      await seedLevels(env.DB, { 3: ["авыл"] }, { 1: 31 });
      const db = countingDb(env.DB);
      const repo = new Repo(db);
      const first = asCard(await new ReviewService(repo, now).nextScreen(user));
      expect(first.levelUp).toBeNull();
      const plain = db.calls;
      // Both words of level 1 become graded and not due today.
      const raw = new Repo(env.DB);
      await raw.updateCardStmt(first.view.cardId, gradedMem(now)).run();
      await raw.insertCard(user.id, noteIds[1]!, "tt_ru", gradedMem(now));
      db.calls = 0;
      const opened = await new ReviewService(repo, now).nextScreen(user);
      expect(levelUpOf(opened)).toEqual({ from: 1, to: 3, coveragePct: 31 });
      expect(db.calls).toBe(plain + 1);
    });

    it("the card after a jump names the level that was opened", async () => {
      await seedUser(env.DB, { now, level: 1, words: 1, tgId: 42 });
      await seedLevels(env.DB, { 3: ["авыл"] }, { 1: 31 });
      const db = countingDb(env.DB);
      const h = harness(db, { now });
      await h.text("/learn");
      const telegramBefore = h.tg.calls.length;
      db.calls = 0;
      await h.press(easyButton(h), h.tg.lastMessageId());
      expect(h.lastText().startsWith(`${ru.levelUp(1, 3, 31)}\n\n🔵 1 · 🔴 0 · 🟢 0\n<b>авыл</b>`)).toBe(true);
      expect(ru.levelUp(1, 3, 31)).toContain("Открываю уровень 3.");
      expect(db.calls).toBeLessThanOrEqual(8);
      expect(h.tg.calls.slice(telegramBefore).map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    });
  });

  describe("the current level's deck exists but was never opened (ruling T16c)", () => {
    /** A learner who finished onboarding at `level` with nothing open: the catalog had no such level then. */
    async function strandedAt(level: number, tgId = 1) {
      const repo = new Repo(env.DB);
      const id = await repo.insertUser({ tgId, chatId: tgId, lang: "ru", now });
      await repo.updateUser(id, { onboardingStep: null, tzOffsetMin: 180, level });
      return { repo, user: (await repo.getUser(id))! };
    }
    const openLevels = async (userId: number) =>
      (await env.DB.prepare("SELECT d.level_no FROM user_decks ud JOIN decks d ON d.id = ud.deck_id WHERE ud.user_id = ? AND d.level_no IS NOT NULL ORDER BY d.level_no").bind(userId).all<{ level_no: number }>())
        .results.map((r) => r.level_no);

    it("opens that deck on the next screen, with no announcement, and the level stays", async () => {
      const { repo, user } = await strandedAt(4);
      expect((await new ReviewService(repo, now).nextScreen(user)).kind).toBe("nothing");
      // The catalog gains level 4, and level 5 behind it.
      await seedLevels(env.DB, { 4: ["авыл", "су"], 5: ["юл"] }, { 4: 61 });
      const s = asCard(await new ReviewService(repo, now).nextScreen(user));
      expect(s.view.word).toBe("авыл");
      expect(s.levelUp).toBeNull();
      expect(s.counts).toEqual({ n: 2, l: 0, r: 0 });
      expect((await repo.getUser(user.id))!.level).toBe(4);
      expect(await openLevels(user.id)).toEqual([4]);
      // From here on it is an ordinary level: level 5 opens when level 4 is done, with the announcement.
      let next = await gradeShown(repo, user, s, 4, now);
      expect(asCard(next).view.word).toBe("су");
      expect(levelUpOf(next)).toBeNull();
      next = await gradeShown(repo, user, next, 4, now);
      expect(levelUpOf(next)).toEqual({ from: 4, to: 5, coveragePct: 61 });
      expect(asCard(next).view.word).toBe("юл");
      expect(await openLevels(user.id)).toEqual([4, 5]);
    });

    it("two concurrent calls open it once and neither moves to the level above", async () => {
      const { repo, user } = await strandedAt(4);
      await seedLevels(env.DB, { 4: ["авыл", "су"], 5: ["юл"] });
      const screens = await Promise.all([
        new ReviewService(repo, now).nextScreen(user),
        new ReviewService(repo, now).nextScreen(user),
        new ReviewService(repo, now).nextScreen(user),
      ]);
      expect(screens.map((s) => asCard(s).view.word)).toEqual(["авыл", "авыл", "авыл"]);
      expect(new Set(screens.map((s) => asCard(s).view.cardId)).size).toBe(1);
      expect(screens.map(levelUpOf)).toEqual([null, null, null]);
      expect((await repo.getUser(user.id))!.level).toBe(4);
      expect(await openLevels(user.id)).toEqual([4]);
      expect(await subscriptions(user.id)).toBe(1);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ?").bind(user.id).first<{ n: number }>())!.n).toBe(1);
    });

    it("the level change itself refuses to step over a current level that is not open", async () => {
      // What a call would send if it had read the queue before level 4 was published.
      const { repo, user } = await strandedAt(4);
      await seedLevels(env.DB, { 4: ["авыл"], 5: ["юл"] });
      await repo.batch(repo.openLevelStmts(user.id, 4, LAST_LEVEL, now));
      expect((await repo.getUser(user.id))!.level).toBe(4);
      expect(await openLevels(user.id)).toEqual([]);
    });

    it("costs exactly one D1 call more than a plain next card", async () => {
      const { user } = await strandedAt(4);
      await seedLevels(env.DB, { 4: ["авыл", "су"] });
      const db = countingDb(env.DB);
      const repo = new Repo(db);
      expect(asCard(await new ReviewService(repo, now).nextScreen(user)).view.word).toBe("авыл");
      const opening = db.calls;
      db.calls = 0;
      expect(asCard(await new ReviewService(repo, now).nextScreen(user)).view.word).toBe("авыл");
      expect(opening).toBe(db.calls + 1);
    });

    it("waits until the open decks have no unseen words, like any level", async () => {
      // Level 1 was opened with «Открыть пропущенные» and still has a word.
      const { repo, user } = await strandedAt(4);
      await seedLevels(env.DB, { 1: ["китап"], 4: ["авыл"] });
      expect(await repo.openSkippedLevels(user.id, now)).toBe(1);
      let s = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
      expect(asCard(s).view.word).toBe("китап");
      expect(await openLevels(user.id)).toEqual([1]);
      s = await gradeShown(repo, user, s, 4, now);
      expect(asCard(s).view.word).toBe("авыл");
      expect(levelUpOf(s)).toBeNull();
      expect((await repo.getUser(user.id))!.level).toBe(4);
      expect(await openLevels(user.id)).toEqual([1, 4]);
    });

    it("does not open it while the daily limit is used up", async () => {
      const { repo, user } = await strandedAt(4);
      await repo.updateUser(user.id, { newPerDay: 1 });
      await seedLevels(env.DB, { 1: ["китап"], 4: ["авыл"] });
      await repo.openSkippedLevels(user.id, now);
      let s = await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!);
      s = await gradeShown(repo, user, s, 3, now);
      expect(s.kind).toBe("done");
      expect(await openLevels(user.id)).toEqual([1]);
    });

    it("the last level, never opened, is opened and not congratulated on", async () => {
      const { repo, user } = await strandedAt(20);
      await seedLevels(env.DB, { 20: ["авыл"] }, { 20: 80 });
      const s = asCard(await new ReviewService(repo, now).nextScreen(user));
      expect(s.view.word).toBe("авыл");
      expect(s.levelUp).toBeNull();
      expect((await repo.getUser(user.id))!.level).toBe(20);
      const done = await gradeShown(repo, user, s, 4, now);
      expect(levelUpOf(done)).toEqual({ from: 20, to: null, coveragePct: 80 });
      expect((await repo.getUser(user.id))!.level).toBe(21);
    });

    it("onboarding on an empty catalog, then the level is published: /learn shows its first word within budget", async () => {
      const db = countingDb(env.DB);
      const h = harness(db, { now });
      await h.text("/start");
      await h.press("ob:ru");
      for (let i = 0; i < 10; i++) await h.press(i < 5 ? "ob:1" : "ob:0");
      await h.press("ob:10");
      await h.press("ob:09:00");
      await h.press("ob:180");
      expect(h.lastText()).toBe(ru.nothingToLearn);
      const repo = new Repo(env.DB);
      const u = (await repo.getUserByTg(42))!;
      expect(u.level).toBe(4);
      expect(await repo.userDeckIds(u.id)).toEqual([]);

      await seedLevels(env.DB, { 4: ["авыл", "су"], 5: ["юл"] }, { 4: 61 });
      const telegramBefore = h.tg.calls.length;
      db.calls = 0;
      await h.text("/learn");
      expect(h.lastText().startsWith("🔵 2 · 🔴 0 · 🟢 0\n<b>авыл</b>")).toBe(true);
      expect(h.tg.calls.slice(telegramBefore).map((c) => c.method)).toEqual(["sendMessage"]);
      expect(db.calls).toBeLessThanOrEqual(8);
      expect((await repo.getUser(u.id))!.level).toBe(4);
      expect(await openLevels(u.id)).toEqual([4]);
    });
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
