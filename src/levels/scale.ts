export type LevelNo = 1 | 2 | 3 | 4 | 5;

export const LEVELS: readonly { no: LevelNo; code: "A1" | "A2" | "B1" | "B2" | "C1"; slug: "a1" | "a2" | "b1" | "b2" | "c1"; size: number }[] = [
  { no: 1, code: "A1", slug: "a1", size: 500 },
  { no: 2, code: "A2", slug: "a2", size: 850 },
  { no: 3, code: "B1", slug: "b1", size: 850 },
  { no: 4, code: "B2", slug: "b2", size: 800 },
  { no: 5, code: "C1", slug: "c1", size: 850 },
];

/** Mask with every level checked. */
export const ALL_LEVELS = 31;

export const levelCode = (no: number): string => LEVELS.find((l) => l.no === no)?.code ?? String(no);

/** Bit of level `no` (1..5) in a level mask. */
export const levelBit = (no: number): number => 1 << (no - 1);

export const hasLevel = (mask: number, no: number): boolean => (mask & levelBit(no)) !== 0;

export const levelsOf = (mask: number): LevelNo[] => LEVELS.filter((l) => hasLevel(mask, l.no)).map((l) => l.no);

export type PosGroup = "n" | "v" | "adj" | "adv" | "pron" | "num" | "func" | "phr";

/** `bit` is the bit index (0..7) in a part-of-speech mask; `codes` are the card `pos` values of the group. */
export const POS_GROUPS: readonly { bit: number; key: PosGroup; codes: readonly string[] }[] = [
  { bit: 0, key: "n", codes: ["n"] },
  { bit: 1, key: "v", codes: ["v"] },
  { bit: 2, key: "adj", codes: ["adj"] },
  { bit: 3, key: "adv", codes: ["adv"] },
  { bit: 4, key: "pron", codes: ["pron"] },
  { bit: 5, key: "num", codes: ["num"] },
  { bit: 6, key: "func", codes: ["post", "part", "conj", "intj"] },
  { bit: 7, key: "phr", codes: ["phr"] },
];

/** Mask with every group checked. */
export const ALL_POS = 255;

/** Card codes of the checked groups; `null` when every group is checked (no filter). */
export const posCodesOf = (mask: number): string[] | null =>
  (mask & ALL_POS) === ALL_POS ? null : POS_GROUPS.filter((g) => mask & (1 << g.bit)).flatMap((g) => g.codes);

/** The mask with bit index `bit` flipped; `null` when the result would be empty. */
export const toggled = (mask: number, bit: number): number | null => {
  const next = mask ^ (1 << bit);
  return next === 0 ? null : next;
};

export type NewMode = "guided" | "topic" | "freq";
export const NEW_MODES: readonly NewMode[] = ["guided", "topic", "freq"];

export const TSEQ_BASE = 1_000_000;

/** Sort key of a word inside the topic order: topic first, then its place in the topic. */
export const tseqOf = (topicNo: number, seq: number): number => topicNo * TSEQ_BASE + seq;
