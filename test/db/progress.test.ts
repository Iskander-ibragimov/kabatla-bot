import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Direction, Repo, User } from "../../src/db/repo";
import { type Mem, newMem } from "../../src/srs/fsrs";
import { gradedMem, logStmt } from "../helpers/review";
import { note, seedCatalog, seedLearner } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3 on 2026-09-30. */
const T = Date.UTC(2026, 8, 30, 7, 0);
const TODAY = "2026-09-30";

const counters = async (userId: number) =>
  (await env.DB.prepare("SELECT level, topic_no, started FROM user_progress WHERE user_id = ? ORDER BY level, topic_no").bind(userId).all()).results;

/**
 * The write of a grade as the review service makes it, with the counter statement in its place: after the usage
 * statement and before the sibling statement. `reps` is what the caller believes the card has; a wrong value fails the guard.
 */
async function grade(repo: Repo, user: User, card: { id: number; noteId: number; direction: Direction }, before: Mem, o: { reps?: number; sibling?: boolean } = {}) {
  const stmts = [
    repo.gradeCardStmt(card.id, o.reps ?? before.reps, { ...gradedMem(T), reps: before.reps + 1 }),
    repo.guardedLogStmt({
      cardId: card.id, userId: user.id, rating: 3, stateBefore: before, intervalBeforeDays: before.scheduledDays, intervalAfterMs: 5 * DAY,
      reviewedAt: T, wasNew: before.state === "new", learnedNow: false, streakBefore: 0, lastStudyDayBefore: null,
    }),
    repo.guardedUserStmt(user.id, { streak: 1, lastStudyDay: TODAY, lastReviewAt: T, mixCounter: 1 }),
    repo.guardedUsageStmt(TODAY, 1, 8),
    repo.progressStmt(user.id, card.noteId, card.id, before.state === "new"),
  ];
  if (o.sibling) stmts.push(repo.guardedSiblingStmt(user.id, card.noteId, card.direction === "tt_ru" ? "ru_tt" : "tt_ru", TODAY, T));
  return repo.batch(stmts);
}

/** The write of an undo as the review service makes it, with the counter statement after the card is restored. */
async function undo(repo: Repo, user: User, cardId: number) {
  const log = (await repo.lastReviewLog(user.id))!;
  expect(log.cardId).toBe(cardId);
  return repo.batch([repo.updateCardStmt(log.cardId, log.stateBefore), repo.markUndoneStmt(log.id), repo.updateUserStmt(user.id, { streak: 0, lastStudyDay: null }), repo.unprogressStmt(user.id, log.cardId)]);
}

async function newCard(repo: Repo, user: User, noteId: number, direction: Direction = "tt_ru") {
  return { id: await repo.ensureNewCard(user.id, noteId, direction, newMem(T)), noteId, direction };
}

describe("the counters of started words (user_progress)", () => {
  it("the first grade of a catalog word adds 1 to the pair of its level and topic", async () => {
    const ids = await seedCatalog(env.DB, [{ level: 1, word: "бер", topic: 2 }, { level: 1, word: "ике", topic: 2 }, { level: 3, word: "өч", topic: 7 }]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    expect(await repo.progress(user.id)).toEqual([]);
    const res = await grade(repo, user, await newCard(repo, user, ids[0]!), newMem(T));
    expect(res[4]!.meta.changes).toBe(1);
    expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 2, started: 1 }]);
    await grade(repo, user, await newCard(repo, user, ids[1]!), newMem(T));
    await grade(repo, user, await newCard(repo, user, ids[2]!), newMem(T));
    expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 2, started: 2 }, { level: 3, topicNo: 7, started: 1 }]);
    // Another learner's counters are another row.
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    await grade(repo, other.user, await newCard(repo, other.user, ids[0]!), newMem(T));
    expect(await repo.progress(other.user.id)).toEqual([{ level: 1, topicNo: 2, started: 1 }]);
    expect(await repo.progress(user.id)).toHaveLength(2);
  });

  it("a later grade of the same card, and the first grade of the word's reverse card, add 0 and still change exactly one row", async () => {
    const [id] = await seedCatalog(env.DB, [{ level: 2, word: "бер", topic: 4 }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const card = await newCard(repo, user, id!);
    const first = await grade(repo, user, card, newMem(T), { sibling: true });
    expect(first.map((r) => r.meta.changes)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await counters(user.id)).toEqual([{ level: 2, topic_no: 4, started: 1 }]);
    // The grade hid the reverse card and created it; the counter statement before the sibling statement left `changes()` at 1.
    const reverse = (await repo.getCardByNote(user.id, id!, "ru_tt"))!;
    expect(reverse).toMatchObject({ buriedDay: TODAY, mem: { state: "new" } });

    const again = await grade(repo, user, card, { ...gradedMem(T), reps: 1 }, { sibling: true });
    expect(again.map((r) => r.meta.changes)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await counters(user.id)).toEqual([{ level: 2, topic_no: 4, started: 1 }]);

    const back = await grade(repo, user, { id: reverse.id, noteId: id!, direction: "ru_tt" }, reverse.mem, { sibling: true });
    expect(back[4]!.meta.changes).toBe(1);
    expect(await counters(user.id)).toEqual([{ level: 2, topic_no: 4, started: 1 }]);
  });

  it("the first grade of an own word adds 1 to the pair (0, 0)", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "бер", topic: 2 }]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const own = await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем"), note("икенче")]);
    await grade(repo, user, await newCard(repo, user, own[0]!), newMem(T));
    expect(await repo.progress(user.id)).toEqual([{ level: 0, topicNo: 0, started: 1 }]);
    await grade(repo, user, await newCard(repo, user, own[1]!), newMem(T));
    expect(await repo.progress(user.id)).toEqual([{ level: 0, topicNo: 0, started: 2 }]);
  });

  it("after a failed guard the statement writes nothing, and neither does what follows it", async () => {
    const [id] = await seedCatalog(env.DB, [{ level: 1, word: "бер", topic: 2 }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const card = await newCard(repo, user, id!);
    const res = await grade(repo, user, card, newMem(T), { reps: 5, sibling: true });
    expect(res.map((r) => r.meta.changes)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await counters(user.id)).toEqual([]);
    expect(await repo.getCardByNote(user.id, id!, "ru_tt")).toBeNull();
    // The same press arriving twice: the second write finds the card graded and counts nothing.
    await grade(repo, user, card, newMem(T), { sibling: true });
    const twice = await grade(repo, user, card, newMem(T), { sibling: true });
    expect(twice[4]!.meta.changes).toBe(0);
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 1 }]);
  });

  it("an undone first grade takes 1 back; an undone later grade, and a first grade undone while the other direction is started, take 0", async () => {
    const ids = await seedCatalog(env.DB, [{ level: 1, word: "бер", topic: 2 }, { level: 1, word: "ике", topic: 2 }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const one = await newCard(repo, user, ids[0]!);
    const two = await newCard(repo, user, ids[1]!);
    await grade(repo, user, one, newMem(T), { sibling: true });
    await grade(repo, user, two, newMem(T), { sibling: true });
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 2 }]);

    await undo(repo, user, two.id);
    expect((await repo.getCard(user.id, two.id))!.mem.state).toBe("new");
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 1 }]);

    // The reverse card of the first word is graded and that grade is undone: the word stays started.
    const reverse = (await repo.getCardByNote(user.id, ids[0]!, "ru_tt"))!;
    await grade(repo, user, { id: reverse.id, noteId: ids[0]!, direction: "ru_tt" }, reverse.mem, { sibling: true });
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 1 }]);
    await undo(repo, user, reverse.id);
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 1 }]);

    // A repetition of a started card is undone: the card goes back to a started state.
    await grade(repo, user, one, { ...gradedMem(T), reps: 1 });
    await undo(repo, user, one.id);
    expect((await repo.getCard(user.id, one.id))!.mem.state).toBe("review");
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 1 }]);

    // Now the first grade of the first word itself is undone: nothing of the word is started any more.
    await undo(repo, user, one.id);
    expect(await counters(user.id)).toEqual([{ level: 1, topic_no: 2, started: 0 }]);
  });

  it("an undo of an own word takes 1 back from the pair (0, 0), and a counter never falls below 0", async () => {
    const [catalog, second] = await seedCatalog(env.DB, [{ level: 1, word: "бер", topic: 2 }, { level: 1, word: "ике", topic: 2 }]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const [own] = await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем")]);
    const card = await newCard(repo, user, own!);
    await grade(repo, user, card, newMem(T));
    await grade(repo, user, await newCard(repo, user, catalog!), newMem(T - MIN));
    await env.DB.prepare("UPDATE review_log SET reviewed_at = ? WHERE card_id != ?").bind(T - MIN, card.id).run();
    await undo(repo, user, card.id);
    expect(await counters(user.id)).toEqual([{ level: 0, topic_no: 0, started: 0 }, { level: 1, topic_no: 2, started: 1 }]);
    // A counter that is already 0 (a card started before the counters existed and not yet recounted) stays 0.
    await repo.unprogressStmt(user.id, card.id).run();
    expect(await counters(user.id)).toEqual([{ level: 0, topic_no: 0, started: 0 }, { level: 1, topic_no: 2, started: 1 }]);
    // A card of another learner is not this learner's to take back.
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    const theirs = await newCard(repo, other.user, second!);
    await repo.unprogressStmt(user.id, theirs.id).run();
    expect(await counters(user.id)).toEqual([{ level: 0, topic_no: 0, started: 0 }, { level: 1, topic_no: 2, started: 1 }]);
  });
});

describe("what the catalog holds and what was done today", () => {
  it("catalogTotals lists the pairs of level and topic with their sizes", async () => {
    const repo = (await seedLearner(env.DB, { now: T })).repo;
    expect(await repo.catalogTotals()).toEqual([]);
    await seedCatalog(env.DB, [{ level: 2, word: "өч", topic: 0 }, { level: 1, word: "бер", topic: 2 }, { level: 1, word: "ике", topic: 2 }, { level: 1, word: "дүрт", topic: 1 }]);
    expect(await repo.catalogTotals()).toEqual([
      { level: 1, topicNo: 1, total: 1 }, { level: 1, topicNo: 2, total: 2 }, { level: 2, topicNo: 0, total: 1 },
    ]);
  });

  it("todayLog counts the grades of today that were not undone, and the words learned today", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    const dayStart = T - 6 * 60 * MIN;
    expect(await repo.todayLog(user.id, dayStart)).toEqual({ reviewsToday: 0, learnedToday: 0 });
    const log = (userId: number, reviewedAt: number) =>
      logStmt(env.DB, { cardId: 1, userId, rating: 3, stateBefore: newMem(T), intervalBeforeDays: 0, intervalAfterMs: MIN, reviewedAt, wasNew: false });
    await repo.batch([log(user.id, dayStart), log(user.id, T - 3 * MIN), log(user.id, T - 2 * MIN), log(user.id, T - MIN), log(user.id, dayStart - 1), log(other.user.id, T)]);
    await env.DB.prepare("UPDATE review_log SET learned_now = 1 WHERE user_id = ? AND reviewed_at IN (?, ?, ?)").bind(user.id, T - 3 * MIN, T - MIN, dayStart - 1).run();
    await env.DB.prepare("UPDATE review_log SET undone = 1 WHERE user_id = ? AND reviewed_at = ?").bind(user.id, T - MIN).run();
    expect(await repo.todayLog(user.id, dayStart)).toEqual({ reviewsToday: 3, learnedToday: 1 });
  });
});
