import type { Repo, User } from "../../src/db/repo";
import { ReviewService, type Screen } from "../../src/review/service";
import { type Mem, type Rating, newMem } from "../../src/srs/ladder";

const DAY = 86_400_000;

/** Narrows a screen to the card variant; throws when another screen came. */
export const asCard = (s: Screen) => { if (s.kind !== "card") throw new Error(`expected card, got ${s.kind}`); return s; };

/** The memory of a card that was graded at `now` and stands on the 3-day rung of the ladder: started, and not due today. */
export const gradedMem = (now: number): Mem =>
  ({ ...newMem(now), state: "review", due: now + 3 * DAY, lastReview: now, scheduledDays: 3, reps: 1 });

/** Grades the card on screen `s` at `now` with the user's current database row, as its button would, and returns the next screen. */
export async function gradeShown(repo: Repo, user: Pick<User, "id">, s: Screen, rating: Rating, now: number): Promise<Screen> {
  const c = asCard(s);
  return new ReviewService(repo, now).grade((await repo.getUser(user.id))!, c.view.cardId, c.view.reps, rating, c.view.tomorrow);
}

/** A row of review_log as a grade writes it, for tests that need a history without grading: not undone, the streak fields at their defaults. */
export function logStmt(db: D1Database, l: { cardId: number; userId: number; rating: Rating; stateBefore: Mem; intervalBeforeDays: number; intervalAfterMs: number; reviewedAt: number; wasNew: boolean }): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(l.cardId, l.userId, l.rating, JSON.stringify(l.stateBefore), l.intervalBeforeDays, l.intervalAfterMs, l.reviewedAt, l.wasNew ? 1 : 0);
}
