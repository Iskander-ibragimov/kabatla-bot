/** Ten words of rising difficulty for the 30-second level check. */
export const PLACEMENT_WORDS = [
  "house", "answer", "borrow", "journey", "improve", "reliable", "approach", "thorough", "reluctant", "ubiquitous",
] as const;

/** Start level (1…4) from the number of known placement words. */
export function placementLevel(known: number): number {
  if (known <= 2) return 1;
  if (known <= 5) return 2;
  if (known <= 8) return 3;
  return 4;
}
