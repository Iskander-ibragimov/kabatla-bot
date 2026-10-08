/**
 * The hints of the first cards: which one a screen carries and which are marked as seen. Each hint is shown once and
 * is one bit of `users.hints_seen`. Pure: what is seen is stored by the grade, in its own write (review/service.ts).
 */
import type { Rating } from "../srs/ladder";

/** The bits of `users.hints_seen`. `update`: the notice about the levels A1–C1 for a learner who knew the bot before them. */
export const HINT = { front: 1, again: 2, hard: 4, good: 8, easy: 16, order: 32, update: 64 } as const;
/** Every hint of a new learner; the update notice is not among them. */
export const ALL_HINTS = 63;

/**
 * The lines that stand before a card or before the screen that ends a session. `front`: what to do with a card.
 * `button`: what the button just pressed did to the word, with the interval that stood on it; `withOrder` adds the
 * line about the order of a session. `update`: the update notice.
 */
export type Lead = { kind: "front" } | { kind: "update" } | { kind: "button"; rating: Rating; interval: string; withOrder: boolean };

const BUTTON: Record<Rating, number> = { 1: HINT.again, 2: HINT.hard, 3: HINT.good, 4: HINT.easy };

/**
 * The hint for the screen that follows a grade, and the hints seen after it. A button pressed for the first time
 * gives its hint, with the line about the order when it is the first of the four. Any grade marks the hint of the
 * first card and the update notice as seen: the learner has graded a card, and the notice stood above it.
 */
export function afterGrade(seen: number, rating: Rating, interval: string): { lead: Lead | null; seen: number } {
  const marked = seen | HINT.front | HINT.update;
  if (seen & BUTTON[rating]) return { lead: null, seen: marked };
  return { lead: { kind: "button", rating, interval, withOrder: !(seen & HINT.order) }, seen: marked | BUTTON[rating] | HINT.order };
}

/** The hint for a card that follows no grade: what to do with a card, for a learner who has graded none; else the update notice, once it is due. */
export function onCard(seen: number): Lead | null {
  if (!(seen & HINT.front)) return { kind: "front" };
  if (!(seen & HINT.update)) return { kind: "update" };
  return null;
}

/** The hint for the screen that ends a session and follows no grade: it shows no card, so only the update notice may stand there. */
export const onDone = (seen: number): Lead | null => onCard(seen | HINT.front);

/** The hints seen after «Показать обучение заново»: every hint comes again; the update notice, if it was seen, does not. */
export const HINTS_KEPT_ON_REPLAY = HINT.update;
