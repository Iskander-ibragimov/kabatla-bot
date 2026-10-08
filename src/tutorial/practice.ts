/**
 * The practice card of the introduction and of /howto, the pure part: which of the four grade buttons the learner has
 * tried, and what a new word gets from each. The card writes nothing: the buttons tried travel in the data of its own
 * buttons, `pr:<mask>:<rating>`, where the mask (bit `rating − 1` for each button) is what was tried before the press.
 */
import { type Rating, newMem, preview } from "../srs/ladder";

/** The word the card practises on, the same for both interface languages: a Tatar word and its Russian translation, as on a real card. */
export const PRACTICE_WORD = { word: "китап", translation: "книга" } as const;

/** All four buttons tried. */
export const ALL = 15;

/** The buttons tried after `rating` is pressed; a button already tried changes nothing. */
export const press = (mask: number, rating: Rating): number => mask | (1 << (rating - 1));

/** How many of the four buttons are tried, 0…4. */
export const tried = (mask: number): number => ([1, 2, 3, 4] as const).filter((rating) => press(mask, rating) === mask).length;

/** The data of a practice button, `pr:<mask>:<rating>` with the mask 0…15 and the rating 1…4; null for anything else. */
export function parse(data: string): { mask: number; rating: Rating } | null {
  const m = /^pr:(0|[1-9]\d?):([1-4])$/.exec(data);
  if (!m || Number(m[1]) > ALL) return null;
  return { mask: Number(m[1]), rating: Number(m[2]) as Rating };
}

/**
 * In how many ms a new word comes back after each button: what the scheduler of the real cards answers for a new word,
 * so the card shows the intervals the first real card will show. The moment does not matter: the ladder counts every
 * interval from the grade.
 */
export function newWordIntervals(): Record<Rating, number> {
  return preview(newMem(0), 0);
}
