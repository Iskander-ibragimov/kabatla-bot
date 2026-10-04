import { describe, expect, it } from "vitest";
import { ALL_LEVELS, ALL_POS, LEVELS, NEW_MODES, POS_GROUPS, TSEQ_BASE, hasLevel, levelBit, levelCode, levelsOf, posCodesOf, toggled, tseqOf } from "../../src/levels/scale";

describe("level scale", () => {
  it("has the five CEFR levels with exact sizes", () => {
    expect(LEVELS.map((l) => [l.no, l.code, l.slug, l.size])).toEqual([
      [1, "A1", "a1", 500], [2, "A2", "a2", 850], [3, "B1", "b1", 850], [4, "B2", "b2", 800], [5, "C1", "c1", 850],
    ]);
    expect(LEVELS.reduce((s, l) => s + l.size, 0)).toBe(3850);
    expect(ALL_LEVELS).toBe(31);
  });

  it("converts between numbers, codes and masks", () => {
    expect(levelCode(3)).toBe("B1");
    expect(levelBit(1)).toBe(1);
    expect(levelBit(5)).toBe(16);
    expect(levelsOf(0b10110)).toEqual([2, 3, 5]);
    expect(levelsOf(0)).toEqual([]);
    expect(levelsOf(ALL_LEVELS)).toEqual([1, 2, 3, 4, 5]);
    expect(hasLevel(0b10110, 3)).toBe(true);
    expect(hasLevel(0b10110, 1)).toBe(false);
  });
});

describe("part-of-speech groups", () => {
  it("uses the exact bits", () => {
    expect(POS_GROUPS.map((g) => [g.bit, g.key])).toEqual([[0, "n"], [1, "v"], [2, "adj"], [3, "adv"], [4, "pron"], [5, "num"], [6, "func"], [7, "phr"]]);
    expect(ALL_POS).toBe(255);
  });

  it("maps masks to card codes, null for no filter", () => {
    expect(posCodesOf(255)).toBeNull();
    expect(posCodesOf(1 << 6)).toEqual(["post", "part", "conj", "intj"]);
    expect(posCodesOf(0b11)).toEqual(["n", "v"]);
  });

  it("flips a bit but never to an empty mask", () => {
    expect(toggled(1, 0)).toBeNull();
    expect(toggled(3, 0)).toBe(2);
    expect(toggled(2, 0)).toBe(3);
  });
});

describe("modes and topic sequence", () => {
  it("lists the modes", () => {
    expect(NEW_MODES).toEqual(["guided", "topic", "freq"]);
  });
  it("builds tseq", () => {
    expect(TSEQ_BASE).toBe(1_000_000);
    expect(tseqOf(7, 12)).toBe(7_000_012);
  });
});
