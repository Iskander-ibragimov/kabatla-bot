import { describe, expect, it } from "vitest";
import { HARD_BOTTOM_MS, RUNGS, type Rating, newMem, preview } from "../../src/srs/ladder";
import { PRACTICE_WORDS, newWordIntervals, parsePress, practiceData } from "../../src/tutorial/practice";

const RATINGS: Rating[] = [1, 2, 3, 4];
const MASKS = Array.from({ length: 16 }, (_, mask) => mask);

describe("the practice card, the pure part", () => {
  it("the intervals of its buttons are those the scheduler gives a new word: 1 minute, 5 minutes, 10 minutes, 1 day", () => {
    const MIN = 60_000;
    expect(newWordIntervals()).toEqual({ 1: MIN, 2: 5 * MIN, 3: 10 * MIN, 4: 1440 * MIN });
    expect(newWordIntervals()).toEqual({ 1: RUNGS[0], 2: HARD_BOTTOM_MS, 3: RUNGS[1], 4: RUNGS[2] });
    // The same at whatever moment a real new word is shown.
    for (const now of [0, 1, Date.UTC(2026, 9, 8, 21, 59, 59, 999)]) {
      const due = preview(newMem(now), now);
      expect(RATINGS.map((r) => due[r] - now)).toEqual(RATINGS.map((r) => newWordIntervals()[r]));
    }
  });

  it("the three words of the practice are китап — книга, су — вода, әни — мама", () => {
    expect(PRACTICE_WORDS).toEqual([
      { word: "китап", translation: "книга" },
      { word: "су", translation: "вода" },
      { word: "әни", translation: "мама" },
    ]);
  });

  it("the data of a button names the word and the button", () => {
    expect(practiceData(2, 3)).toBe("pr:s2:3");
    expect(practiceData(1, 1)).toBe("pr:s1:1");
    for (const word of [1, 2, 3] as const) for (const rating of RATINGS) expect(parsePress(practiceData(word, rating))).toEqual({ kind: "press", word, rating });
  });

  it("reads a press of the three-word card", () => {
    expect(parsePress("pr:s3:4")).toEqual({ kind: "press", word: 3, rating: 4 });
  });

  it("a button of the old four-button card restarts the practice", () => {
    expect(parsePress("pr:0:3")).toEqual({ kind: "restart" });
    expect(parsePress("pr:15:1")).toEqual({ kind: "restart" });
    for (const mask of MASKS) for (const rating of RATINGS) expect(parsePress(`pr:${mask}:${rating}`)).toEqual({ kind: "restart" });
  });

  it("a press of anything else is no practice button", () => {
    for (const data of ["pr:s4:1", "pr:s0:1", "pr:s1:5", "pr:s1:0", "pr:s1", "pr:s1:1:1", "pr:s01:1", "pr:16:1", "pr:x", "pr:start", "pr:", "g:3:1", "xpr:s1:1", "pr:s1:1 ", ""]) {
      expect(parsePress(data), data).toBeNull();
    }
  });
});
