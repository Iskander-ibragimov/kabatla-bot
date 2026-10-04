import type { CardRow, Direction, NewNote, NewScope, Queue, Repo, User } from "../db/repo";
import { type EmptyReason, emptyReason, mergeStreams, nextSpans, readSpans, scopeKey, writeSpans } from "../levels/order";
import { LEVELS, levelsOf, posCodesOf } from "../levels/scale";
import { type Mem, type Rating, formatInterval, grade as fsrsGrade, memoryDays, newMem, preview, stage } from "../srs/fsrs";
import { type Lead, afterGrade, onCard, onDone } from "../tutorial/hints";
import { type Window, dayWindow, localDay } from "../users/service";
import { pick } from "./pick";

/** View-model types shared with the bot layer (kept here so services never import the bot). */
export interface CardView {
  cardId: number; noteId: number; reps: number; direction: Direction;
  word: string; transcription: string | null; pos: string; translation: string; exampleTt: string; exampleRu: string;
  hasAudio: boolean; sourceUrl: string | null; mem: Mem;
}
export interface Feedback { word: string; kind: "grow" | "step" | "lapse" | "first"; beforeDays: number; afterMs: number; keptDays?: number }
/** `n`: the new cards still to come today; while a level has a word to give it is what is left of the day's limit. */
export interface Counts { n: number; l: number; r: number }
export interface DaySummary { reviewsToday: number; learnedToday: number; nextLearningInMs: number | null; streak: number }
export type { EmptyReason, Lead };
export type Screen =
  /** `lead`: the hint that stands before the card in the same message, see tutorial/hints.ts; null when there is none. */
  | { kind: "card"; view: CardView; counts: Counts; intervals: Record<Rating, string>; feedback: Feedback | null; canUndo: boolean; lead: Lead | null }
  /**
   * The session is over for now. `empty`: why no new word came although the day's limit is not spent, and what to
   * offer the learner; null when new words are not allowed any more today. `lead`: as on a card.
   */
  | { kind: "done"; summary: DaySummary; feedback: Feedback | null; empty: EmptyReason | null; lead: Lead | null }
  | { kind: "stale" }
  | { kind: "noundo" }
  /** The user has no card at all and there is no new word to give. */
  | { kind: "nothing" };

/** At most this many new words per day may be graded Easy on first sight; after that no new words are offered. */
export const EASY_NEW_CAP = 200;

/** New words still allowed today: Easy-on-first-sight grades are free of the daily limit but capped. */
export const newLeftOf = (user: Pick<User, "newPerDay">, c: { newDoneToday: number; easyNewToday: number }): number =>
  c.easyNewToday >= EASY_NEW_CAP ? 0 : Math.max(0, user.newPerDay - c.newDoneToday);

/** D1 rows written per grade, index updates included (card, log, user, usage, the counter of started words). */
const ROWS_PER_REVIEW = 9;

export const directionsOf = (u: Pick<User, "direction">): Direction[] =>
  u.direction === "both" ? ["tt_ru", "ru_tt"] : [u.direction];
export const displayDirection = (u: Pick<User, "direction">): Direction => (u.direction === "ru_tt" ? "ru_tt" : "tt_ru");

/** The settings of a user that decide which catalog words come as new ones. */
type ScopeSettings = Pick<User, "levels" | "posGroups" | "newMode" | "topicNo" | "direction" | "newCursors">;

/**
 * Which catalog words may come as new ones for a user: the checked levels and parts of speech, the order and the
 * chosen topic, with the read positions of the levels. The positions count only when they were stored for exactly
 * these settings (`scopeKey`); otherwise there are none, and the levels are read from their beginning.
 */
export function newScopeOf(user: ScopeSettings): NewScope {
  const stored = readSpans(user.newCursors, scopeKey(user));
  return { levels: levelsOf(user.levels), posCodes: posCodesOf(user.posGroups), mode: user.newMode, topicNo: user.topicNo, spans: stored.spans, spansVersion: stored.version };
}

/**
 * One read of the queue. `fresh`: the new cards in the order they are given — own words, then the cards of catalog
 * words that exist and were never graded, then the heads of the checked levels in the order of the mode.
 * `streamed`: a level gave a word, so more new words lie behind the ones listed. `cursors`: the read positions after
 * this read, as stored on the user's row; `moved`: they are worth storing.
 */
interface QueueRead { q: Queue; fresh: NewNote[]; streamed: boolean; cursors: string; moved: boolean }

/** Sums `n` over the pairs of each level A1…C1; the pair of own words (level 0) is no level. */
const byLevel = (pairs: { level: number; n: number }[]): Record<number, number> =>
  Object.fromEntries(LEVELS.map((l) => [l.no, pairs.reduce((sum, p) => (p.level === l.no ? sum + p.n : sum), 0)]));

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

  /**
   * Reads the queue for the user's settings; it writes nothing but what `pre` holds, statements that run in the batch
   * of the read, before it. Positions stored for another catalog version
   * were not used by the read, so what this read saw replaces them whatever it is; otherwise the positions are worth
   * storing when one of them moved far enough (`nextSpans`).
   */
  private async readQueue(user: User, w: Window, pre: D1PreparedStatement[] = []): Promise<QueueRead> {
    const scope = newScopeOf(user);
    const q = await this.repo.queue(user.id, { ...w, directions: directionsOf(user) }, scope, pre);
    const stream = mergeStreams(Object.values(q.streams).map((level) => level ?? []), user.newMode);
    const reset = q.catalogVersion !== scope.spansVersion;
    const next = nextSpans(reset ? {} : scope.spans, q.seen);
    return {
      q, fresh: [...q.ownNew, ...q.newRows, ...stream], streamed: stream.length > 0,
      cursors: writeSpans(scopeKey(user), q.catalogVersion, next.spans), moved: reset || next.save,
    };
  }

  /**
   * The queue of a session: one read, and the read positions are stored when they moved (one more D1 call, only then).
   * In the guided order a chosen topic that has no word left is cleared: the queue is read once more without it, and
   * the choice is cleared in the batch of that second read, with the positions that were stored for it. The positions
   * of the order without a topic are not stored by this read — it would be a write of its own — but by the next one,
   * which finds none stored, as after any change of the settings.
   */
  private async sessionQueue(user: User, w: Window): Promise<QueueRead> {
    const read = await this.readQueue(user, w);
    if (user.newMode === "guided" && user.topicNo != null && !read.streamed) {
      return this.readQueue({ ...user, topicNo: null }, w, [this.repo.clearTopicStmt(user.id, user.topicNo)]);
    }
    if (read.moved) await this.repo.updateUser(user.id, { newCursors: read.cursors });
    return read;
  }

  /** The counters of a card screen. While a level has a word to give, the new cards to come are not counted: they are as many as the day still allows. */
  private countsOf(user: User, { q, streamed }: QueueRead): Counts {
    const candidates = streamed ? Infinity : q.ownNew.length + q.newRows.length;
    return { n: Math.min(newLeftOf(user, q.counts), candidates), l: q.counts.learning, r: q.counts.review };
  }

  /**
   * The next screen of the session. `hint`: the hint of the grade this screen follows. A screen that follows no grade,
   * or a grade without a hint, carries the hint that is due by what the user has seen (`user.hintsSeen`); after a
   * grade that is none, the grade having marked both of them.
   */
  async nextScreen(user: User, feedback: Feedback | null = null, hint: Lead | null = null): Promise<Screen> {
    const w = dayWindow(user.tzOffsetMin, this.now);
    const read = await this.sessionQueue(user, w);
    const { q, fresh } = read;
    const newLeft = newLeftOf(user, q.counts);
    const p = pick({ learning: q.learning, review: q.review, newNotes: fresh }, newLeft, this.now, user.mixCounter);
    if (!p) {
      if (!q.hasCards && !feedback && !fresh.length) return { kind: "nothing" };
      // Why there is no new word is said only when one could still be given today; then the counters are read with the day's log.
      const noNew = newLeft > 0 && !fresh.length;
      const end = await this.repo.dayEnd(user.id, w.dayStartMs, noNew);
      const empty = noNew
        ? emptyReason({
          mode: user.newMode, topicNo: user.topicNo, levels: user.levels, posGroups: user.posGroups,
          totals: byLevel(end.totals.map((t) => ({ level: t.level, n: t.total }))),
          started: byLevel(end.progress.map((s) => ({ level: s.level, n: s.started }))),
        })
        : null;
      const nextDue = q.learning.length ? Math.min(...q.learning.map((x) => x.mem.due)) : null;
      return {
        kind: "done", feedback, empty, lead: hint ?? onDone(user.hintsSeen),
        summary: { reviewsToday: end.reviewsToday, learnedToday: end.learnedToday, streak: user.streak,
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
    return {
      kind: "card", view: toView(row), counts: this.countsOf(user, read), intervals: intervals as Record<Rating, string>, feedback, canUndo: feedback != null,
      lead: hint ?? onCard(user.hintsSeen),
    };
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
    // The hint of the button names the interval that stood on it: the scheduler's preview, without the fuzz that moves the stored
    // interval of a card by a day or so. What is seen is stored with the grade, in the user's statement.
    const hint = afterGrade(user.hintsSeen, rating, formatInterval(preview(before, this.now, user.retention)[rating] - this.now, user.lang));
    const stmts = [
      this.repo.gradeCardStmt(card.id, reps, after),
      this.repo.guardedLogStmt({
        cardId: card.id, userId: user.id, rating, stateBefore: before, intervalBeforeDays: before.scheduledDays,
        intervalAfterMs: after.due - this.now, reviewedAt: this.now, wasNew: before.state === "new", learnedNow,
        streakBefore: user.streak, lastStudyDayBefore: user.lastStudyDay,
      }),
      this.repo.guardedUserStmt(user.id, { streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1, hintsSeen: hint.seen }),
      this.repo.guardedUsageStmt(new Date(this.now).toISOString().slice(0, 10), 1, ROWS_PER_REVIEW),
      // The counter of started words changes exactly one row whenever the grade was applied, so the statement after it is still guarded.
      this.repo.progressStmt(user.id, card.noteId, card.id, before.state === "new"),
    ];
    if (user.direction === "both") {
      const sibling: Direction = card.direction === "tt_ru" ? "ru_tt" : "tt_ru";
      stmts.push(this.repo.guardedSiblingStmt(user.id, card.noteId, sibling, today, this.now));
    }
    const res = await this.repo.batch(stmts);
    if (!res[0]?.meta.changes) return { kind: "stale" };
    const updated: User = { ...user, streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1, hintsSeen: hint.seen };
    return this.nextScreen(updated, feedbackOf(card.word, before, after, this.now), hint.lead);
  }

  /**
   * Restores the last graded card (one level, like Anki’s undo). The word is taken back from the counter of started
   * words when the grade had started it; that statement stands right after the mark of the undone grade, which guards
   * it: a second undo of the same grade takes nothing.
   */
  async undo(user: User): Promise<Screen> {
    const log = await this.repo.lastReviewLog(user.id);
    if (!log) return { kind: "noundo" };
    await this.repo.batch([
      this.repo.updateCardStmt(log.cardId, log.stateBefore),
      this.repo.markUndoneStmt(log.id),
      this.repo.unprogressStmt(user.id, log.cardId),
      this.repo.updateUserStmt(user.id, { streak: log.streakBefore, lastStudyDay: log.lastStudyDayBefore }),
    ]);
    const card = await this.repo.getCard(user.id, log.cardId);
    if (!card) return { kind: "noundo" };
    const pv = preview(card.mem, this.now, user.retention);
    const intervals = {} as Record<Rating, string>;
    for (const g of [1, 2, 3, 4] as Rating[]) intervals[g] = formatInterval(pv[g] - this.now, user.lang);
    // The queue is read for the counters alone: nothing of it is stored.
    const read = await this.readQueue(user, dayWindow(user.tzOffsetMin, this.now));
    return { kind: "card", view: toView(card), intervals, feedback: null, canUndo: false, counts: this.countsOf(user, read), lead: null };
  }
}
