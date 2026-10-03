import type { Repo, User } from "../../src/db/repo";
import { ReviewService, type Screen } from "../../src/review/service";
import { type Mem, type Rating, newMem } from "../../src/srs/fsrs";

const DAY = 86_400_000;

/** Narrows a screen to the card variant; throws when another screen came. */
export const asCard = (s: Screen) => { if (s.kind !== "card") throw new Error(`expected card, got ${s.kind}`); return s; };

/** The memory of a card that was graded at `now` and comes back in five days: started, and not due today. */
export const gradedMem = (now: number): Mem =>
  ({ ...newMem(now), state: "review", due: now + 5 * DAY, lastReview: now, scheduledDays: 5, stability: 5, difficulty: 5, reps: 1 });

/** Grades the card on screen `s` at `now` with the user's current database row and returns the next screen. */
export async function gradeShown(repo: Repo, user: Pick<User, "id">, s: Screen, rating: Rating, now: number): Promise<Screen> {
  const c = asCard(s);
  return new ReviewService(repo, now).grade((await repo.getUser(user.id))!, c.view.cardId, c.view.reps, rating);
}
