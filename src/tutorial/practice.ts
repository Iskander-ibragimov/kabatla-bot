/**
 * The practice of the introduction and of /howto, the pure part. The practice is three cards, shown one after another
 * in one message; on each the learner presses one grade button, and the next card explains what that press means.
 * Nothing is written: the state travels in the data of the card's own buttons, `pr:s<word>:<rating>`, which names the
 * word the button belongs to (1…3) and the button. A button of the earlier four-button card, `pr:<mask>:<rating>`, may
 * still stand in an old message: its press starts the practice again from the first word.
 */
import { type Rating, newMem, preview } from "../srs/ladder";

/** The three words of the practice, the same for both interface languages: a Tatar word and its Russian translation, as in the A1 catalog. */
export const PRACTICE_WORDS = [
  { word: "китап", translation: "книга" },
  { word: "су", translation: "вода" },
  { word: "әни", translation: "мама" },
] as const;

/** The number of a practice word, 1…3. */
export type PracticeWordNo = 1 | 2 | 3;

/** The data of the button `rating` on the card of the practice word `word`. */
export const practiceData = (word: PracticeWordNo, rating: Rating): string => `pr:s${word}:${rating}`;

/** A press of a practice button: a grade on one of the three cards, or a button of the old card, which restarts. */
export type PracticePress = { kind: "press"; word: PracticeWordNo; rating: Rating } | { kind: "restart" };

/** Reads the data of a practice button: `pr:s<1…3>:<1…4>` is a press, the old `pr:<mask 0…15>:<1…4>` a restart; anything else null. */
export function parsePress(data: string): PracticePress | null {
  const m = /^pr:s([1-3]):([1-4])$/.exec(data);
  if (m) return { kind: "press", word: Number(m[1]) as PracticeWordNo, rating: Number(m[2]) as Rating };
  return /^pr:(0|[1-9]\d?):[1-4]$/.exec(data) && Number(data.split(":")[1]) <= 15 ? { kind: "restart" } : null;
}

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
