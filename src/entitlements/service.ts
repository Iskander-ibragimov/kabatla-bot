import type { Repo, User } from "../db/repo";
import { localDay } from "../users/service";

/** What a user may do a limited number of times in a local day: `gen` — make an AI deck, `add` — send a message with words. */
export type Feature = "gen" | "add";
export const DAILY_LIMITS: Record<Feature, number> = { gen: 3, add: 50 };
/** Where the day and its count are kept: two columns of `users` per feature, and the same two as fields of `User`. */
const KEPT = {
  gen: { columns: { day: "gens_day", count: "gens_count" }, day: "gensDay", count: "gensCount" },
  add: { columns: { day: "adds_day", count: "adds_count" }, day: "addsDay", count: "addsCount" },
} as const;

/**
 * Uses one unit of a daily-limited feature; false when today's limit is reached. The unit is taken in the database
 * row, not in the copy of the user the caller holds, so concurrent calls cannot take more than the limit.
 * `also` is written to the user's row in the same D1 call when the unit is taken.
 */
export async function consume(repo: Repo, user: User, feature: Feature, now: number, also: Partial<Omit<User, "id">> = {}): Promise<boolean> {
  return repo.takeDailyUnit(user.id, KEPT[feature].columns, localDay(user.tzOffsetMin, now), DAILY_LIMITS[feature], also);
}

/** Units left today, by the copy of the user the caller holds. */
export async function remaining(user: User, feature: Feature, now: number): Promise<number> {
  const used = user[KEPT[feature].day] === localDay(user.tzOffsetMin, now) ? user[KEPT[feature].count] : 0;
  return Math.max(0, DAILY_LIMITS[feature] - used);
}

/** Gives back one unit when the feature failed (e.g. AI deck generation errored). */
export async function refund(repo: Repo, user: User, feature: Feature, now: number): Promise<void> {
  await repo.returnDailyUnit(user.id, KEPT[feature].columns, localDay(user.tzOffsetMin, now));
}
