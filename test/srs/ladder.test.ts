import { describe, expect, it } from "vitest";
import { RUNGS, TOP, HARD_BOTTOM_MS, grade, memoryDays, newMem, preview, rungOf, stage, type Mem, type Rating } from "../../src/srs/ladder";

const NOW = Date.UTC(2026, 9, 8, 6, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const RATINGS: Rating[] = [1, 2, 3, 4];

/** The stored form of a card on the given rung (constraints.md), reached by climbing, not fallen. */
function at(rung: number, over: Partial<Mem> = {}): Mem {
  const base: Mem =
    rung === 0
      ? newMem(NOW)
      : rung <= 2
        ? { state: "learning", step: rung - 1, stability: null, difficulty: null, due: NOW, lastReview: NOW - 1, scheduledDays: 0, reps: 3, lapses: 1 }
        : { state: "review", step: null, stability: null, difficulty: null, due: NOW, lastReview: NOW - 1, scheduledDays: RUNGS[rung - 1]! / DAY, reps: 3, lapses: 1 };
  return { ...base, ...over };
}

describe("RUNGS", () => {
  it("is the ten fixed intervals", () => {
    expect(RUNGS).toEqual([1 * MIN, 10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 120 * DAY, 180 * DAY]);
    expect(TOP).toBe(10);
    expect(HARD_BOTTOM_MS).toBe(5 * MIN);
  });
});

describe("new word", () => {
  it("previews the four buttons", () => {
    const p = preview(newMem(NOW), NOW);
    expect(p).toEqual({ 1: NOW + 1 * MIN, 2: NOW + 5 * MIN, 3: NOW + 10 * MIN, 4: NOW + 1 * DAY });
  });
  it("Снова lands on rung 1", () => {
    expect(grade(newMem(NOW), 1, NOW)).toEqual({
      state: "learning", step: 0, scheduledDays: 0, reps: 1, lapses: 0, stability: null, difficulty: null, lastReview: NOW, due: NOW + 1 * MIN,
    });
  });
  it("Хорошо lands on rung 2, Легко on rung 3", () => {
    const g = grade(newMem(NOW), 3, NOW);
    expect(g).toMatchObject({ state: "learning", step: 1, scheduledDays: 0, due: NOW + 10 * MIN });
    const e = grade(newMem(NOW), 4, NOW);
    expect(e).toMatchObject({ state: "review", step: null, scheduledDays: 1, due: NOW + DAY });
  });
  it("Трудно lands on rung 1 with 5 minutes", () => {
    expect(grade(newMem(NOW), 2, NOW)).toMatchObject({ state: "learning", step: 0, scheduledDays: 0, due: NOW + 5 * MIN });
  });
});

describe("minute rungs", () => {
  it("rung 1", () => {
    expect(grade(at(1), 2, NOW)).toMatchObject({ state: "learning", step: 0, due: NOW + 5 * MIN });
    expect(grade(at(1), 3, NOW)).toMatchObject({ state: "learning", step: 1, due: NOW + 10 * MIN });
    expect(grade(at(1), 4, NOW)).toMatchObject({ state: "review", scheduledDays: 1, due: NOW + DAY });
  });
  it("rung 2", () => {
    expect(grade(at(2), 2, NOW)).toMatchObject({ state: "learning", step: 1, due: NOW + 10 * MIN });
    expect(grade(at(2), 3, NOW)).toMatchObject({ state: "review", step: null, scheduledDays: 1, due: NOW + DAY });
    expect(grade(at(2), 4, NOW)).toMatchObject({ state: "review", scheduledDays: 3, due: NOW + 3 * DAY });
  });
  it("Снова does not raise lapses", () => {
    expect(grade(at(1), 1, NOW).lapses).toBe(1);
    expect(grade(at(2), 1, NOW)).toMatchObject({ state: "learning", step: 0, lapses: 1, due: NOW + MIN });
  });
});

describe.each([3, 4, 5, 6, 7, 8, 9, 10])("day rung %i", (rung) => {
  const days = (r: number) => RUNGS[Math.min(r, TOP) - 1]! / DAY;
  it("Трудно keeps the rung", () => {
    const g = grade(at(rung), 2, NOW);
    expect(g).toMatchObject({ state: "review", step: null, scheduledDays: days(rung), due: NOW + days(rung) * DAY });
    expect(rungOf(g)).toBe(rung);
  });
  it("Хорошо goes one rung up", () => {
    const g = grade(at(rung), 3, NOW);
    expect(g).toMatchObject({ state: "review", scheduledDays: days(rung + 1), due: NOW + days(rung + 1) * DAY });
    expect(rungOf(g)).toBe(Math.min(rung + 1, TOP));
  });
  it("Легко goes two rungs up", () => {
    const g = grade(at(rung), 4, NOW);
    expect(g).toMatchObject({ state: "review", scheduledDays: days(rung + 2), due: NOW + days(rung + 2) * DAY });
    expect(rungOf(g)).toBe(Math.min(rung + 2, TOP));
  });
  it("Снова falls to relearning rung 1 and counts a lapse", () => {
    const g = grade(at(rung), 1, NOW);
    expect(g).toMatchObject({ state: "relearning", step: 0, scheduledDays: 0, lapses: 2, due: NOW + MIN });
    expect(rungOf(g)).toBe(1);
  });
});

describe("relearning word", () => {
  const rel = (step: number) => at(step + 1, { state: "relearning", step });
  it("Хорошо from rung 1 stays relearning on step 1", () => {
    expect(grade(rel(0), 3, NOW)).toMatchObject({ state: "relearning", step: 1, due: NOW + 10 * MIN });
  });
  it("Хорошо from rung 2 returns to review at 1 day", () => {
    expect(grade(rel(1), 3, NOW)).toMatchObject({ state: "review", step: null, scheduledDays: 1, due: NOW + DAY });
  });
  it("Снова and Трудно stay relearning", () => {
    expect(grade(rel(1), 1, NOW)).toMatchObject({ state: "relearning", step: 0, lapses: 1 });
    expect(grade(rel(0), 2, NOW)).toMatchObject({ state: "relearning", step: 0, due: NOW + 5 * MIN });
  });
});

describe("invariants", () => {
  it("reps grows, due is exactly now + interval, stability stays null, preview matches grade", () => {
    const cards: Mem[] = [];
    for (let rung = 0; rung <= TOP; rung++) cards.push(at(rung));
    cards.push(at(1, { state: "relearning", step: 0 }), at(2, { state: "relearning", step: 1 }));
    for (const m of cards) {
      const rung = rungOf(m);
      const p = preview(m, NOW);
      for (const r of RATINGS) {
        const g = grade(m, r, NOW);
        expect(g.reps).toBe(m.reps + 1);
        expect(g.lastReview).toBe(NOW);
        expect(g.lapses).toBe(r === 1 && m.state === "review" ? m.lapses + 1 : m.lapses);
        expect(g.stability).toBeNull();
        expect(g.difficulty).toBeNull();
        expect(g.due).toBe(p[r]);
        expect(g.due).toBeGreaterThan(NOW);
        const next = rungOf(g);
        expect(next).toBeGreaterThanOrEqual(1);
        expect(next).toBeLessThanOrEqual(TOP);
        expect(g.due - NOW).toBe(r === 2 && rung <= 1 ? HARD_BOTTOM_MS : RUNGS[next - 1]);
      }
    }
  });
  it("rung table by rating", () => {
    const expected = (rung: number, r: Rating) =>
      r === 1 ? 1 : r === 2 ? Math.max(rung, 1) : r === 3 ? (rung === 0 ? 2 : Math.min(rung + 1, TOP)) : rung === 0 ? 3 : Math.min(rung + 2, TOP);
    for (let rung = 0; rung <= TOP; rung++) for (const r of RATINGS) expect(rungOf(grade(at(rung), r, NOW))).toBe(expected(rung, r));
  });
});

describe("rungOf of cards from the old scheduler", () => {
  it.each([
    [0, 3], [2, 3], [3, 4], [8, 5], [11, 5], [46, 7], [200, 10],
    [13, 5], [14, 6], [29, 6], [30, 7], [59, 7], [60, 8], [119, 8], [120, 9], [179, 9], [180, 10], [2.6, 3],
  ])("review with %i days is rung %i", (scheduledDays, rung) => {
    expect(rungOf(at(3, { scheduledDays }))).toBe(rung);
  });
  it("learning and relearning", () => {
    expect(rungOf(at(1, { step: null }))).toBe(1);
    expect(rungOf(at(2, { state: "relearning", step: 1 }))).toBe(2);
    expect(rungOf(at(1, { step: 5 }))).toBe(2);
    expect(rungOf(at(1, { step: -1 }))).toBe(1);
    expect(rungOf(at(2, { state: "relearning", step: -3 }))).toBe(1);
    expect(rungOf(newMem(NOW))).toBe(0);
  });
});

describe("stage and memoryDays", () => {
  it("stages", () => {
    expect(stage(newMem(NOW))).toBe("new");
    expect(stage(at(2))).toBe("learning");
    expect(stage(at(4))).toBe("learning");
    expect(stage(at(5))).toBe("known");
    expect(stage(at(7))).toBe("learned");
  });
  it("memoryDays", () => {
    expect(memoryDays(at(6))).toBe(14);
    expect(memoryDays(at(1, { state: "relearning", step: 0 }))).toBe(0);
    expect(memoryDays(at(2))).toBe(0);
    expect(memoryDays(newMem(NOW))).toBe(0);
  });
});
