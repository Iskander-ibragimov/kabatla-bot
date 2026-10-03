import type { DeckRow, Repo, User } from "../db/repo";
import { displayDirection } from "../review/service";
import { dayWindow } from "../users/service";

export interface Cumulative {
  streak: number; learned: number; known: number; learning: number; fresh: number;
  memory: number; total: number; r30: number; retention30: number | null; forecast7: number[];
  /** Current level, 1…20; 21 when every level is done. */
  level: number;
  /** Share of ordinary text covered by the levels below the current one, in percent: the coverage of the nearest level below it. */
  coveragePct: number | null;
}

/** All-time progress: stages, total "memory days", reviews, 30-day retention and a 7-day forecast. */
export async function cumulative(repo: Repo, user: User, now: number): Promise<Cumulative> {
  const w = dayWindow(user.tzOffsetMin, now);
  const dir = displayDirection(user);
  const [s, x] = await Promise.all([repo.summary(user.id, w.dayStartMs, dir), repo.statsExtra(user.id, now, w.dayStartMs, dir)]);
  const forecast7 = Array.from({ length: 7 }, (_, d) => x.forecast.filter((f) => f.d === d).reduce((a, f) => a + f.n, 0));
  const alive = user.lastStudyDay === w.today || user.lastStudyDay === dayWindow(user.tzOffsetMin, now - 86_400_000).today;
  return {
    streak: alive ? user.streak : 0, learned: s.learned, known: s.known, learning: s.learning, fresh: s.new,
    memory: x.memory, total: x.total, r30: x.r30, retention30: x.rev30 ? x.ok30 / x.rev30 : null, forecast7,
    level: user.level, coveragePct: x.coveragePct,
  };
}

/** What /levels shows. */
export interface LevelsView {
  /** Levels below the current one that are finished, or were skipped at the placement test and never opened. */
  passed: number[];
  /** The current level (when the catalog has it and it is open) and the opened levels below it that still have unseen words, by level number. */
  inProgress: { levelNo: number; seen: number; total: number }[];
  /**
   * How many levels the catalog has that are still to be opened: those after the current one and the current one itself
   * when it was never opened (the session opens it next). Levels that are not published yet are not counted.
   */
  ahead: number;
  /** «Мои слова» and the AI decks. */
  own: Pick<DeckRow, "kind" | "titleRu" | "titleTt" | "total">[];
  /** Coverage of the levels below the current one, as in /stats. */
  coveragePct: number | null;
  /** Levels below the current one that were never opened. */
  skipped: number[];
}

/** Everything here is built from the levels the catalog has (ordered by number), so an unfinished catalog or one with gaps shows only what exists. */
export async function levelsView(repo: Repo, user: Pick<User, "id" | "level">): Promise<LevelsView> {
  const [levels, own] = await Promise.all([repo.levelsOverview(user.id), repo.ownDecks(user.id)]);
  const below = levels.filter((l) => l.levelNo < user.level);
  return {
    passed: below.filter((l) => !l.open || l.seen >= l.total).map((l) => l.levelNo),
    inProgress: levels.filter((l) => l.open && (l.levelNo === user.level || (l.levelNo < user.level && l.seen < l.total)))
      .map((l) => ({ levelNo: l.levelNo, seen: l.seen, total: l.total })),
    ahead: levels.filter((l) => l.levelNo > user.level || (l.levelNo === user.level && !l.open)).length,
    own: own.map((d) => ({ kind: d.kind, titleRu: d.titleRu, titleTt: d.titleTt, total: d.total })),
    coveragePct: below.at(-1)?.coveragePct ?? null,
    skipped: below.filter((l) => !l.open).map((l) => l.levelNo),
  };
}
