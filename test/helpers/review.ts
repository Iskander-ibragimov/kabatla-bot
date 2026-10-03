import type { Repo, User } from "../../src/db/repo";
import { ReviewService, type Screen } from "../../src/review/service";
import type { Rating } from "../../src/srs/fsrs";

/** Narrows a screen to the card variant; throws when another screen came. */
export const asCard = (s: Screen) => { if (s.kind !== "card") throw new Error(`expected card, got ${s.kind}`); return s; };

/** Grades the card on screen `s` at `now` with the user's current database row and returns the next screen. */
export async function gradeShown(repo: Repo, user: Pick<User, "id">, s: Screen, rating: Rating, now: number): Promise<Screen> {
  const c = asCard(s);
  return new ReviewService(repo, now).grade((await repo.getUser(user.id))!, c.view.cardId, c.view.reps, rating);
}
