import { describe, expect, it } from "vitest";
import type { Rating } from "../../src/srs/fsrs";
import { ALL_HINTS, HINT, HINTS_KEPT_ON_REPLAY, afterGrade, onCard, onDone } from "../../src/tutorial/hints";

describe("hints", () => {
  it("the bits are fixed: they are stored in users.hints_seen", () => {
    expect(HINT).toEqual({ front: 1, again: 2, hard: 4, good: 8, easy: 16, order: 32, update: 64 });
    expect(ALL_HINTS).toBe(63);
    expect(ALL_HINTS & HINT.update).toBe(0);
  });

  it("the first grade gives the hint of its button with the line about the order, and marks the first card and the update notice too", () => {
    expect(afterGrade(0, 3, "10 мин")).toEqual({ lead: { kind: "button", rating: 3, interval: "10 мин", withOrder: true }, seen: 1 | 8 | 32 | 64 });
  });

  it("the second «Хорошо» gives no hint and changes nothing", () => {
    const first = afterGrade(0, 3, "10 мин");
    expect(afterGrade(first.seen, 3, "4 дн.")).toEqual({ lead: null, seen: first.seen });
  });

  it("another button after it gives its own hint, without the line about the order", () => {
    expect(afterGrade(HINT.good | HINT.order, 1, "1 мин")).toEqual({
      lead: { kind: "button", rating: 1, interval: "1 мин", withOrder: false },
      seen: HINT.front | HINT.again | HINT.good | HINT.order | HINT.update,
    });
  });

  it.each([[1, HINT.again], [2, HINT.hard], [3, HINT.good], [4, HINT.easy]] as [Rating, number][])("button %i has the bit %i", (rating, bit) => {
    expect(afterGrade(HINT.order, rating, "x").seen).toBe(HINT.front | HINT.order | HINT.update | bit);
    expect(afterGrade(ALL_HINTS & ~bit, rating, "x").lead).toEqual({ kind: "button", rating, interval: "x", withOrder: false });
    expect(afterGrade(bit, rating, "x").lead).toBeNull();
  });

  it("each of the four buttons gives its hint once, the line about the order comes with the first of them only", () => {
    let seen = 0;
    const leads = ([3, 3, 1, 4, 1, 2, 2, 4] as Rating[]).map((rating) => { const r = afterGrade(seen, rating, "x"); seen = r.seen; return r.lead; });
    expect(leads.map((l) => (l?.kind === "button" ? `${l.rating}${l.withOrder ? "+" : ""}` : "-"))).toEqual(["3+", "-", "1", "4", "-", "2", "-", "-"]);
    expect(seen).toBe(127);
  });

  it("a learner who has seen every hint gets none after a grade, and the grade marks the update notice", () => {
    for (const rating of [1, 2, 3, 4] as Rating[]) expect(afterGrade(ALL_HINTS, rating, "x")).toEqual({ lead: null, seen: 127 });
  });

  it("a card that follows no grade: the hint of the first card, else the update notice, else nothing", () => {
    expect(onCard(0)).toEqual({ kind: "front" });
    expect(onCard(HINT.update)).toEqual({ kind: "front" });
    expect(onCard(ALL_HINTS)).toEqual({ kind: "update" });
    expect(onCard(HINT.front)).toEqual({ kind: "update" });
    expect(onCard(127)).toBeNull();
    expect(onCard(HINT.front | HINT.update)).toBeNull();
  });

  it("the screen that ends a session and follows no grade: the update notice when it is due, never the hint of the first card", () => {
    expect(onDone(0)).toEqual({ kind: "update" });
    expect(onDone(ALL_HINTS)).toEqual({ kind: "update" });
    expect(onDone(HINT.update)).toBeNull();
    expect(onDone(127)).toBeNull();
  });

  it("«Показать обучение заново» keeps the update notice as it is and nothing else", () => {
    expect(HINTS_KEPT_ON_REPLAY).toBe(HINT.update);
    expect([127 & HINTS_KEPT_ON_REPLAY, ALL_HINTS & HINTS_KEPT_ON_REPLAY]).toEqual([HINT.update, 0]);
    expect(onCard(127 & HINTS_KEPT_ON_REPLAY)).toEqual({ kind: "front" });
  });
});
