import { describe, expect, it } from "vitest";
import { HARD_BOTTOM_MS, RUNGS, type Rating, newMem, preview } from "../../src/srs/ladder";
import { ALL, PRACTICE_WORD, newWordIntervals, parse, press, tried } from "../../src/tutorial/practice";

const RATINGS: Rating[] = [1, 2, 3, 4];
const MASKS = Array.from({ length: 16 }, (_, mask) => mask);
const BIT: Record<Rating, number> = { 1: 1, 2: 2, 3: 4, 4: 8 };

describe("the practice card, the pure part", () => {
  it("a press adds the button to the ones tried: from each of the sixteen states, each of the four buttons", () => {
    for (const mask of MASKS) {
      for (const rating of RATINGS) {
        const after = press(mask, rating);
        expect(after, `${mask} + ${rating}`).toBe(mask | BIT[rating]);
        // Nothing but the pressed button changes, and the state stays one of the sixteen.
        expect(after & ~BIT[rating], `${mask} + ${rating}`).toBe(mask & ~BIT[rating]);
        expect(after).toBeGreaterThanOrEqual(0);
        expect(after).toBeLessThanOrEqual(ALL);
      }
    }
  });

  it("a button already tried keeps the state: a second press changes nothing", () => {
    for (const mask of MASKS) for (const rating of RATINGS) expect(press(press(mask, rating), rating)).toBe(press(mask, rating));
    expect([press(4, 3), press(15, 1), press(5, 1), press(5, 3)]).toEqual([4, 15, 5, 5]);
  });

  it("counts the buttons tried", () => {
    expect([tried(0), tried(5), tried(15)]).toEqual([0, 2, 4]);
    expect(MASKS.map(tried)).toEqual([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);
  });

  it("all four are tried after the four buttons in any order, and not before", () => {
    expect(ALL).toBe(15);
    const orders = RATINGS.flatMap((a) => RATINGS.flatMap((b) => RATINGS.flatMap((c) => RATINGS.map((d) => [a, b, c, d] as Rating[])))).filter((o) => new Set(o).size === 4);
    expect(orders).toHaveLength(24);
    for (const order of orders) {
      const states = order.reduce<number[]>((seen, rating) => [...seen, press(seen.at(-1) ?? 0, rating)], []);
      expect(states.map(tried), order.join("")).toEqual([1, 2, 3, 4]);
      expect(states.map((s) => s === ALL), order.join("")).toEqual([false, false, false, true]);
    }
  });

  it("reads the data of a practice button: the buttons tried before the press, and the button", () => {
    expect(parse("pr:0:1")).toEqual({ mask: 0, rating: 1 });
    expect(parse("pr:15:4")).toEqual({ mask: 15, rating: 4 });
    for (const mask of MASKS) for (const rating of RATINGS) expect(parse(`pr:${mask}:${rating}`)).toEqual({ mask, rating });
  });

  it("refuses data that is no practice button", () => {
    for (const data of ["pr:16:1", "pr:3:5", "pr:x:1", "pr:3", "pr:3:1:1", "pr:3:0", "pr:-1:1", "pr::1", "pr:3:", "pr:03:1", "pr:1.5:1", "pr:start", "pr:", "g:3:1", "xpr:3:1", "pr:3:1 ", ""]) {
      expect(parse(data), data).toBeNull();
    }
  });

  it("the word of the card is «китап» — «книга»", () => {
    expect(PRACTICE_WORD).toEqual({ word: "китап", translation: "книга" });
  });

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
});
