import type { CardRow, NewNote, RecentAnswer } from "../db/repo";

/** What a card is picked from: the cards on a learning step and the reviews due today, each by due time, and the new cards in the order they are to be given. */
export interface Candidates { learning: CardRow[]; review: CardRow[]; newNotes: NewNote[] }
export type Pick = { kind: "card"; card: CardRow } | { kind: "new"; note: NewNote };
/**
 * What the last answers of today say about the next card: the note of the card answered last (null: none today), and
 * how many of the last answers in a row were given to cards on a learning step.
 */
export interface Recent { noteId: number | null; learningRun: number }
export const NO_RECENT: Recent = { noteId: null, learningRun: 0 };
/** After this many learning cards in a row a new word comes before the next due learning card (spec A1). */
export const NEW_AFTER_LEARNING = 2;
const LEARN_AHEAD_MS = 60_000;

/** The `Recent` of the last answers of today, newest first. */
export function recentOf(log: RecentAnswer[]): Recent {
  if (log.length === 0) return NO_RECENT;
  let learningRun = 0;
  while (learningRun < log.length && (log[learningRun]!.stateBefore === "learning" || log[learningRun]!.stateBefore === "relearning")) learningRun++;
  return { noteId: log[0]!.noteId, learningRun };
}

/**
 * Anki-style order: due learning cards, then reviews with new cards spread evenly
 * (one new after every ceil(reviews/newLeft) reviews), then learn-ahead within 60 s.
 * Two rules keep hard words from going round in a circle (spec part A):
 * - A1: after NEW_AFTER_LEARNING learning cards in a row, a new word (within the day's limit) comes before a due learning card;
 * - A2: no card of the note answered last (in direction «both», neither of its two cards) while any other card can be
 *   shown, due, new or learn-ahead. Only when nothing else can be shown does the same card come again (decision L6).
 */
export function pick(c: Candidates, newLeft: number, now: number, mix: number, recent: Recent = NO_RECENT): Pick | null {
  if (recent.noteId !== null) {
    const other = (x: { noteId: number }) => x.noteId !== recent.noteId;
    const p = pickFrom({ learning: c.learning.filter(other), review: c.review.filter(other), newNotes: c.newNotes.filter(other) }, newLeft, now, mix, recent.learningRun);
    if (p) return p;
  }
  return pickFrom(c, newLeft, now, mix, recent.learningRun);
}

function pickFrom(c: Candidates, newLeft: number, now: number, mix: number, learningRun: number): Pick | null {
  const fresh = newLeft > 0 ? c.newNotes[0] : undefined;
  const due = c.learning.find((x) => x.mem.due <= now);
  if (due) return fresh && learningRun >= NEW_AFTER_LEARNING ? { kind: "new", note: fresh } : { kind: "card", card: due };
  const review = c.review[0];
  if (review && fresh) {
    const every = Math.max(1, Math.ceil(c.review.length / newLeft));
    return mix % (every + 1) === every ? { kind: "new", note: fresh } : { kind: "card", card: review };
  }
  if (review) return { kind: "card", card: review };
  if (fresh) return { kind: "new", note: fresh };
  const ahead = c.learning.find((x) => x.mem.due - now <= LEARN_AHEAD_MS);
  return ahead ? { kind: "card", card: ahead } : null;
}
