/**
 * The hints of the first cards: which one a screen carries and which are marked as seen. Each hint is shown until the
 * first grade and is one bit of `users.hints_seen`. Pure: what is seen is stored by the grade, in its own write
 * (review/service.ts). What each grade button does is not a hint: the practice card shows it (tutorial/practice.ts).
 */

/**
 * The bits of `users.hints_seen`. `update`: the notice about the levels A1–C1 for a learner who knew the bot before
 * them. The bits 2…32 belonged to the hints of the four grade buttons and of the order of a session, which the bot no
 * longer has: a row may still hold them, nothing reads them, and no write takes them away.
 */
export const HINT = { front: 1, update: 64 } as const;

/** The lines that stand before a card or before the screen that ends a session. `front`: what to do with a card. `update`: the update notice. */
export type Lead = { kind: "front" } | { kind: "update" };

/**
 * The hints seen after a grade: the hint of the first card and the update notice — the learner has graded a card, and
 * the notice stood above it. Every other bit stays as it was.
 */
export const afterGrade = (seen: number): number => seen | HINT.front | HINT.update;

/** The hint for a card that follows no grade: what to do with a card, for a learner who has graded none; else the update notice, once it is due. */
export function onCard(seen: number): Lead | null {
  if (!(seen & HINT.front)) return { kind: "front" };
  if (!(seen & HINT.update)) return { kind: "update" };
  return null;
}

/** The hint for the screen that ends a session and follows no grade: it shows no card, so only the update notice may stand there. */
export const onDone = (seen: number): Lead | null => onCard(seen | HINT.front);
