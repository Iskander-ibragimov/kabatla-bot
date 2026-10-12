import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type DayWindow, type Direction, type NewScope, Repo } from "../../src/db/repo";
import { type Mem, type Rating, newMem } from "../../src/srs/ladder";
import { dayWindow } from "../../src/users/service";
import { bulkCards } from "../helpers/catalog";
import { logStmt } from "../helpers/review";
import { seedUser } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3 on 2026-09-30; the learner's day began at 04:00 local, six hours earlier. */
const T = Date.UTC(2026, 8, 30, 7, 0);
const win = (now = T, directions: Direction[] = ["tt_ru"]): DayWindow => ({ ...dayWindow(180, now), directions });
const scope: NewScope = { levels: [1], posCodes: null, mode: "freq", topicNo: null, spans: {}, spansVersion: 0 };
const learning = (due: number, lastReview: number): Mem => ({ ...newMem(T), state: "learning", step: 0, due, lastReview, reps: 2 });

async function cardIds(userId: number): Promise<number[]> {
  return (await env.DB.prepare("SELECT id FROM cards WHERE user_id = ? ORDER BY id").bind(userId).all<{ id: number }>()).results.map((r) => r.id);
}
function answer(cardId: number, userId: number, reviewedAt: number, state: Mem["state"] = "learning", rating: Rating = 2): D1PreparedStatement {
  return logStmt(env.DB, { cardId, userId, rating, stateBefore: { ...newMem(T), state }, intervalBeforeDays: 0, intervalAfterMs: 5 * MIN, reviewedAt, wasNew: state === "new" });
}

describe("the queue and hard words (spec A)", () => {
  it("learning rows carry the answers of today that were not undone", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T });
    await bulkCards(env.DB, user.id, [[noteIds[0]!, "tt_ru", learning(T - 1, T - 10 * MIN), null]]);
    const [id] = await cardIds(user.id);
    await env.DB.batch([
      answer(id!, user.id, T - DAY), answer(id!, user.id, T - 30 * MIN), answer(id!, user.id, T - 20 * MIN),
      answer(id!, user.id, T - 15 * MIN), answer(id!, user.id, T - 10 * MIN),
    ]);
    await env.DB.prepare("UPDATE review_log SET undone = 1 WHERE reviewed_at = ?").bind(T - 15 * MIN).run();
    const q = await repo.queue(user.id, win(), scope);
    expect(q.learning).toHaveLength(1);
    expect(q.learning[0]!.answersToday).toBe(3);
  });

  it("recent: the last two answers of today, newest first, undone ones skipped", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T });
    expect((await repo.queue(user.id, win(), scope)).recent).toEqual([]);
    await bulkCards(env.DB, user.id, noteIds.slice(0, 3).map((n): [number, Direction, Mem, null] => [n, "tt_ru", learning(T - 1, T - 10 * MIN), null]));
    const [a, b, c] = await cardIds(user.id);
    await env.DB.batch([
      answer(c!, user.id, T - DAY, "review"), answer(a!, user.id, T - 30 * MIN, "review"), answer(b!, user.id, T - 20 * MIN, "new"),
      answer(a!, user.id, T - 10 * MIN, "learning"), answer(c!, user.id, T - 5 * MIN, "relearning"),
    ]);
    await env.DB.prepare("UPDATE review_log SET undone = 1 WHERE reviewed_at = ?").bind(T - 5 * MIN).run();
    const q = await repo.queue(user.id, win(), scope);
    expect(q.recent).toEqual([
      { cardId: a, noteId: noteIds[0], stateBefore: "learning" },
      { cardId: b, noteId: noteIds[1], stateBefore: "new" },
    ]);
    // A new day: no answers yet.
    expect((await repo.queue(user.id, win(T + DAY), scope)).recent).toEqual([]);
  });

  it("a card sent to tomorrow is out of the learning list and the 🔴 count until the day it is due", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T });
    const { dayEndMs } = win();
    await bulkCards(env.DB, user.id, [
      [noteIds[0]!, "tt_ru", learning(T + DAY, T), null],
      // An ordinary 10-minute step that ends 5 minutes after the day ends stays a learning card of today.
      [noteIds[1]!, "tt_ru", learning(dayEndMs + 5 * MIN, dayEndMs - 5 * MIN), null],
    ]);
    const [postponed, step] = await cardIds(user.id);
    const q = await repo.queue(user.id, win(), scope);
    expect(q.learning.map((x) => x.id)).toEqual([step]);
    expect(q.counts.learning).toBe(1);
    const next = await repo.queue(user.id, win(T + DAY), scope);
    expect(next.learning.map((x) => x.id)).toEqual([step, postponed]);
    expect(next.counts.learning).toBe(2);
  });

  it("cardForGrade gives the card with today's answers, and null for another user's card", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T });
    const other = await repo.insertUser({ tgId: 2, chatId: 2, lang: "ru", now: T });
    await bulkCards(env.DB, user.id, [[noteIds[0]!, "tt_ru", learning(T - 1, T - 10 * MIN), null]]);
    const [id] = await cardIds(user.id);
    await env.DB.batch([answer(id!, user.id, T - DAY), answer(id!, user.id, T - 20 * MIN), answer(id!, user.id, T - 10 * MIN)]);
    const { dayStartMs } = win();
    const c = await repo.cardForGrade(user.id, id!, dayStartMs);
    expect(c).toMatchObject({ id, noteId: noteIds[0], answersToday: 2, mem: { state: "learning", due: T - 1 } });
    expect(await repo.cardForGrade(other, id!, dayStartMs)).toBeNull();
    expect(await repo.cardForGrade(user.id, id! + 100, dayStartMs)).toBeNull();
  });

  it("dayEnd counts the words sent to tomorrow today, once per word", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, patch: { direction: "both" } });
    await bulkCards(env.DB, user.id, [
      [noteIds[0]!, "tt_ru", learning(T + DAY, T - 5 * MIN), null],
      [noteIds[0]!, "ru_tt", learning(T + DAY, T), null],
      [noteIds[1]!, "tt_ru", { ...learning(T + DAY, T), state: "relearning" }, null],
      // Sent to tomorrow yesterday: due today, not a word of today.
      [noteIds[2]!, "tt_ru", learning(T, T - DAY), null],
      // An ordinary learning step.
      [noteIds[3]!, "tt_ru", learning(T + 10 * MIN, T), null],
    ]);
    const { dayStartMs } = win();
    expect((await repo.dayEnd(user.id, dayStartMs, false)).postponedToday).toBe(2);
    expect((await repo.dayEnd(user.id, dayStartMs + DAY, false)).postponedToday).toBe(0);
  });
});
