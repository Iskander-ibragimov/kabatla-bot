import { type CardRow, type Direction, LAST_LEVEL, type NewNote, type Repo, type User } from "../db/repo";
import { type Mem, type Rating, formatInterval, grade as fsrsGrade, memoryDays, newMem, preview, stage } from "../srs/fsrs";
import { dayWindow, localDay } from "../users/service";
import { pick } from "./pick";

/** View-model types shared with the bot layer (kept here so services never import the bot). */
export interface CardView {
  cardId: number; noteId: number; reps: number; direction: Direction;
  word: string; transcription: string | null; pos: string; translation: string; exampleTt: string; exampleRu: string;
  hasAudio: boolean; sourceUrl: string | null; mem: Mem;
}
export interface Feedback { word: string; kind: "grow" | "step" | "lapse" | "first"; beforeDays: number; afterMs: number; keptDays?: number }
export interface Counts { n: number; l: number; r: number }
export interface DaySummary {
  reviewsToday: number; learnedToday: number;
  totals: { learned: number; known: number; learning: number; new: number };
  nextLearningInMs: number | null; streak: number;
}
/**
 * The level that has just been opened, not always `from + 1`: a catalog may have gaps. `to` is null when level 20 is
 * finished and nothing is left to open. `total`: how many words level `from` has; null when the catalog has no deck of it.
 */
export interface LevelUp { from: number; to: number | null; coveragePct: number | null; total: number | null }
export type Screen =
  | { kind: "card"; view: CardView; counts: Counts; intervals: Record<Rating, string>; feedback: Feedback | null; canUndo: boolean; levelUp: LevelUp | null }
  | { kind: "done"; summary: DaySummary; feedback: Feedback | null; levelUp: LevelUp | null }
  | { kind: "stale" }
  | { kind: "noundo" }
  | { kind: "nothing" };

export { LAST_LEVEL };

/** At most this many new words per day may be graded Easy on first sight; after that no new words are offered. */
export const EASY_NEW_CAP = 200;

/** New words still allowed today: Easy-on-first-sight grades are free of the daily limit but capped. */
export const newLeftOf = (user: Pick<User, "newPerDay">, c: { newDoneToday: number; easyNewToday: number }): number =>
  c.easyNewToday >= EASY_NEW_CAP ? 0 : Math.max(0, user.newPerDay - c.newDoneToday);

/** D1 rows written per grade, index updates included (card, log, user, usage). */
const ROWS_PER_REVIEW = 8;

export const directionsOf = (u: Pick<User, "direction">): Direction[] =>
  u.direction === "both" ? ["tt_ru", "ru_tt"] : [u.direction];
export const displayDirection = (u: Pick<User, "direction">): Direction => (u.direction === "ru_tt" ? "ru_tt" : "tt_ru");

function toView(row: CardRow | (NewNote & { id: number; mem: Mem })): CardView {
  return {
    cardId: row.id, noteId: row.noteId, reps: row.mem.reps, direction: row.direction, word: row.word, transcription: row.transcription, pos: row.pos,
    translation: row.translation, exampleTt: row.exampleTt, exampleRu: row.exampleRu,
    hasAudio: !!row.audioFileId, sourceUrl: row.sourceUrl, mem: row.mem,
  };
}

function feedbackOf(word: string, before: Mem, after: Mem, now: number): Feedback {
  const afterMs = after.due - now;
  const beforeDays = before.state === "review" ? before.scheduledDays : 0;
  if (before.state === "review" && after.state === "relearning") return { word, kind: "lapse", beforeDays, afterMs, keptDays: memoryDays(after) };
  if (after.state === "review" && before.state === "review") return { word, kind: "grow", beforeDays, afterMs };
  if (after.state === "review") return { word, kind: "first", beforeDays, afterMs };
  return { word, kind: "step", beforeDays, afterMs };
}

export class ReviewService {
  constructor(private readonly repo: Repo, private readonly now: number) {}

  async nextScreen(user: User, feedback: Feedback | null = null): Promise<Screen> {
    const w = dayWindow(user.tzOffsetMin, this.now);
    const opts = { ...w, directions: directionsOf(user) };
    let c = await this.repo.candidateCards(user.id, opts);
    let levelUp: LevelUp | null = null;
    // The open decks have no unseen words and today's limit is not spent: a level is opened in the same D1 call that
    // re-reads the queue. The first read already tells whether there is a level to open, so the second call is made
    // only at the moment of a transition, not on every screen of a learner who is waiting for the next level.
    if (c.counts.newAvailable === 0 && newLeftOf(user, c.counts) > 0 && user.level <= LAST_LEVEL) {
      if (c.currentLevelClosed) {
        // The deck of the current level exists but was never opened (the learner finished onboarding before it was
        // published): that deck is opened, the level stays, and nothing is announced — no level was finished.
        c = await this.repo.candidateCards(user.id, opts, [this.repo.openCurrentLevelStmt(user.id, this.now)]);
      } else if (c.nextLevelExists) {
        // The next level the catalog has is opened. Only the call whose UPDATE moved users.level gets the new level back
        // and announces it (double taps, stale `user`).
        const from = user.level;
        const reread = await this.repo.candidateCards(user.id, opts, this.repo.openLevelStmts(user.id, from, LAST_LEVEL, this.now));
        const [moved, , finished] = reread.pre;
        const opened = moved!.results[0]?.level as number | undefined;
        const deck = finished!.results[0] as { coverage_pct: number | null; total: number } | undefined;
        if (opened != null) levelUp = { from, to: opened <= LAST_LEVEL ? opened : null, coveragePct: deck?.coverage_pct ?? null, total: deck?.total ?? null };
        c = reread;
      }
    }
    const newLeft = newLeftOf(user, c.counts);
    const p = pick(c, newLeft, this.now, user.mixCounter);
    const counts: Counts = { n: Math.min(newLeft, c.counts.newAvailable), l: c.counts.learning, r: c.counts.review };
    if (!p) {
      const s = await this.repo.summary(user.id, w.dayStartMs, displayDirection(user));
      const totals = { learned: s.learned, known: s.known, learning: s.learning, new: s.new };
      if (!feedback && !levelUp && Object.values(totals).every((x) => x === 0)) return { kind: "nothing" };
      const nextDue = c.learning.length ? Math.min(...c.learning.map((x) => x.mem.due)) : null;
      return {
        kind: "done", feedback, levelUp,
        summary: { reviewsToday: s.reviewsToday, learnedToday: s.learnedToday, totals, streak: user.streak,
          nextLearningInMs: nextDue == null ? null : Math.max(0, nextDue - this.now) },
      };
    }
    let row: CardRow;
    if (p.kind === "new") {
      const mem = newMem(this.now);
      const id = await this.repo.ensureNewCard(user.id, p.note.noteId, p.note.direction, mem);
      row = { ...p.note, id, mem, buriedDay: null };
    } else row = p.card;
    const pv = preview(row.mem, this.now, user.retention);
    const intervals = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Rating, string | number>;
    for (const g of [1, 2, 3, 4] as Rating[]) intervals[g] = formatInterval(pv[g] - this.now, user.lang);
    return { kind: "card", view: toView(row), counts, intervals: intervals as Record<Rating, string>, feedback, canUndo: feedback != null, levelUp };
  }

  async grade(user: User, cardId: number, reps: number, rating: Rating): Promise<Screen> {
    const card = await this.repo.getCard(user.id, cardId);
    if (!card || card.mem.reps !== reps) return { kind: "stale" };
    const before = card.mem;
    const after = fsrsGrade(before, rating, this.now, user.retention);
    const today = localDay(user.tzOffsetMin, this.now);
    const yesterday = localDay(user.tzOffsetMin, this.now - 86_400_000);
    const streak = user.lastStudyDay === today ? user.streak : user.lastStudyDay === yesterday ? user.streak + 1 : 1;
    const learnedNow = stage(before) !== "learned" && stage(after) === "learned";
    const stmts = [
      this.repo.gradeCardStmt(card.id, reps, after),
      this.repo.guardedLogStmt({
        cardId: card.id, userId: user.id, rating, stateBefore: before, intervalBeforeDays: before.scheduledDays,
        intervalAfterMs: after.due - this.now, reviewedAt: this.now, wasNew: before.state === "new", learnedNow,
        streakBefore: user.streak, lastStudyDayBefore: user.lastStudyDay,
      }),
      this.repo.guardedUserStmt(user.id, { streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1 }),
      this.repo.guardedUsageStmt(new Date(this.now).toISOString().slice(0, 10), 1, ROWS_PER_REVIEW),
    ];
    if (user.direction === "both") {
      const sibling: Direction = card.direction === "tt_ru" ? "ru_tt" : "tt_ru";
      stmts.push(this.repo.guardedSiblingStmt(user.id, card.noteId, sibling, today, this.now));
    }
    const res = await this.repo.batch(stmts);
    if (!res[0]?.meta.changes) return { kind: "stale" };
    const updated: User = { ...user, streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1 };
    return this.nextScreen(updated, feedbackOf(card.word, before, after, this.now));
  }

  /** Restores the last graded card (one level, like Anki’s undo). */
  async undo(user: User): Promise<Screen> {
    const log = await this.repo.lastReviewLog(user.id);
    if (!log) return { kind: "noundo" };
    await this.repo.batch([
      this.repo.updateCardStmt(log.cardId, log.stateBefore),
      this.repo.markUndoneStmt(log.id),
      this.repo.updateUserStmt(user.id, { streak: log.streakBefore, lastStudyDay: log.lastStudyDayBefore }),
    ]);
    const card = await this.repo.getCard(user.id, log.cardId);
    if (!card) return { kind: "noundo" };
    const pv = preview(card.mem, this.now, user.retention);
    const intervals = {} as Record<Rating, string>;
    for (const g of [1, 2, 3, 4] as Rating[]) intervals[g] = formatInterval(pv[g] - this.now, user.lang);
    const w = dayWindow(user.tzOffsetMin, this.now);
    const c = await this.repo.candidateCards(user.id, { ...w, directions: directionsOf(user) });
    const newLeft = newLeftOf(user, c.counts);
    return { kind: "card", view: toView(card), intervals, feedback: null, canUndo: false, levelUp: null,
      counts: { n: Math.min(newLeft, c.counts.newAvailable), l: c.counts.learning, r: c.counts.review } };
  }
}
