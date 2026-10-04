import type { Repo, User } from "../db/repo";
import { coverageOf, levelLines, unstartedIn } from "../levels/service";
import { displayDirection } from "../review/service";
import { dayWindow } from "../users/service";

export interface Cumulative {
  streak: number; learned: number; known: number; learning: number;
  /** The cards of the checked levels that are not started: the new words ahead, by the counters of started words. */
  fresh: number;
  memory: number; total: number; r30: number; retention30: number | null; forecast7: number[];
  /** The checked levels, by number (1 = A1 … 5 = C1). */
  levels: number[];
  /** Share of ordinary text covered, in percent: the coverage of the highest level up to which every level is started whole; null while A1 is not. */
  coveragePct: number | null;
}

/**
 * All-time progress: stages, total "memory days", reviews, 30-day retention and a 7-day forecast, with the checked
 * levels and what is left of them. Three D1 calls; the stages are counted over the learner's cards, not over the catalog.
 */
export async function cumulative(repo: Repo, user: User, now: number): Promise<Cumulative> {
  const w = dayWindow(user.tzOffsetMin, now);
  const dir = displayDirection(user);
  const [s, x, levels] = await Promise.all([repo.stageCounts(user.id, dir), repo.statsExtra(user.id, now, w.dayStartMs, dir), levelLines(repo, user)]);
  const forecast7 = Array.from({ length: 7 }, (_, d) => x.forecast.filter((f) => f.d === d).reduce((a, f) => a + f.n, 0));
  const alive = user.lastStudyDay === w.today || user.lastStudyDay === dayWindow(user.tzOffsetMin, now - 86_400_000).today;
  return {
    streak: alive ? user.streak : 0, learned: s.learned, known: s.known, learning: s.learning, fresh: unstartedIn(levels),
    memory: x.memory, total: x.total, r30: x.r30, retention30: x.rev30 ? x.ok30 / x.rev30 : null, forecast7,
    levels: levels.filter((l) => l.checked).map((l) => l.no), coveragePct: coverageOf(levels),
  };
}
