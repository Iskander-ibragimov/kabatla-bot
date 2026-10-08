import { describe, expect, it } from "vitest";
import { HINT, afterGrade, onCard, onDone } from "../../src/tutorial/hints";

/** What `users.hints_seen` held while each grade button had a hint of its own: bits 2…32, and all of them with the first card. */
const OLD_BITS = [2, 4, 8, 16, 32];
const OLD_ALL = 63;

describe("hints", () => {
  it("the bits are fixed: they are stored in users.hints_seen, and the two that are left kept their numbers", () => {
    expect(HINT).toEqual({ front: 1, update: 64 });
  });

  it("a grade marks the hint of the first card and the update notice as seen, and nothing else", () => {
    expect(afterGrade(0)).toBe(HINT.front | HINT.update);
    expect(afterGrade(HINT.update)).toBe(HINT.front | HINT.update);
    expect(afterGrade(HINT.front)).toBe(HINT.front | HINT.update);
    expect(afterGrade(HINT.front | HINT.update)).toBe(HINT.front | HINT.update);
  });

  it("a grade keeps the bits a row stored for the hints that are gone", () => {
    for (const bit of OLD_BITS) expect(afterGrade(bit), String(bit)).toBe(bit | HINT.front | HINT.update);
    expect(afterGrade(OLD_ALL)).toBe(127);
    expect(afterGrade(127)).toBe(127);
    for (let seen = 0; seen < 256; seen++) expect(afterGrade(seen) & seen, String(seen)).toBe(seen);
  });

  it("a card that follows no grade: the hint of the first card, else the update notice, else nothing", () => {
    expect(onCard(0)).toEqual({ kind: "front" });
    expect(onCard(HINT.update)).toEqual({ kind: "front" });
    expect(onCard(OLD_ALL)).toEqual({ kind: "update" });
    expect(onCard(HINT.front)).toEqual({ kind: "update" });
    expect(onCard(127)).toBeNull();
    expect(onCard(HINT.front | HINT.update)).toBeNull();
  });

  it("the bits of the hints that are gone change no hint: only the first card and the update notice are looked at", () => {
    for (let seen = 0; seen < 256; seen++) {
      const kept = seen & (HINT.front | HINT.update);
      expect(onCard(seen), String(seen)).toEqual(onCard(kept));
      expect(onDone(seen), String(seen)).toEqual(onDone(kept));
    }
  });

  it("the screen that ends a session and follows no grade: the update notice when it is due, never the hint of the first card", () => {
    expect(onDone(0)).toEqual({ kind: "update" });
    expect(onDone(OLD_ALL)).toEqual({ kind: "update" });
    expect(onDone(HINT.update)).toBeNull();
    expect(onDone(127)).toBeNull();
  });

  it("after a grade no screen carries a hint", () => {
    for (let seen = 0; seen < 256; seen++) {
      expect(onCard(afterGrade(seen)), String(seen)).toBeNull();
      expect(onDone(afterGrade(seen)), String(seen)).toBeNull();
    }
  });
});
