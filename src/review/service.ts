import { type GlossEntry, parseGloss } from "../content/gloss";
import type { CardRow, Direction, NewNote, NewScope, Queue, Repo, User } from "../db/repo";
import { type EmptyReason, emptyReason, mergeStreams, nextSpans, readSpans, scopeKey, writeSpans } from "../levels/order";
import { LEVELS, levelsOf, posCodesOf } from "../levels/scale";
import { formatInterval } from "../srs/interval";
import { DAY_ANSWERS, type Mem, type Rating, grade as ladderGrade, newMem, preview, stage } from "../srs/ladder";
import { type Lead, afterGrade, onCard, onDone } from "../tutorial/hints";
import { type Window, dayWindow, localDay } from "../users/service";
import { pick, recentOf } from "./pick";

/**
 * View-model types shared with the bot layer (kept here so services never import the bot). `gloss`: the breakdown of
 * the example word by word (spec B), null for a note without one — own and AI notes, a level not broken down yet.
 */
export interface CardView {
  cardId: number; noteId: number; reps: number; direction: Direction;
  word: string; transcription: string | null; pos: string; translation: string; exampleTt: string; exampleRu: string;
  hasAudio: boolean; sourceUrl: string | null; gloss: GlossEntry[] | null; mem: Mem;
  /**
   * The card is shown with the intervals of «enough for today» (spec A3): «Снова» and «Трудно» say «1 день». Their
   * buttons carry this, and the grade honours what the button said, not the count at the time of the press: the two
   * differ when the learner's day ends between the screen and the press.
   */
  tomorrow: boolean;
}
export interface Feedback { word: string; kind: "grow" | "step" | "lapse" | "first"; beforeDays: number; afterMs: number }
/** `n`: the new cards still to come today; while a level has a word to give it is what is left of the day's limit. */
export interface Counts { n: number; l: number; r: number }
/** `postponedToday`: the words «Снова» or «Трудно» sent to tomorrow today (spec A3), both cards of a word counted once. */
export interface DaySummary { reviewsToday: number; learnedToday: number; postponedToday: number; nextLearningInMs: number | null; streak: number }
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

/** D1 rows written per grade, index updates included (card, log and its two indexes, user, usage, the counter of started words). */
const ROWS_PER_REVIEW = 10;

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

function toView(row: CardRow | (NewNote & { id: number; mem: Mem }), answersToday: number): CardView {
  return {
    tomorrow: answersToday >= DAY_ANSWERS,
    cardId: row.id, noteId: row.noteId, reps: row.mem.reps, direction: row.direction, word: row.word, transcription: row.transcription, pos: row.pos,
    translation: row.translation, exampleTt: row.exampleTt, exampleRu: row.exampleRu,
    hasAudio: !!row.audioFileId, sourceUrl: row.sourceUrl, gloss: parseGloss(row.exampleGloss), mem: row.mem,
  };
}

function feedbackOf(word: string, before: Mem, after: Mem, now: number): Feedback {
  const afterMs = after.due - now;
  const beforeDays = before.state === "review" ? before.scheduledDays : 0;
  if (before.state === "review" && after.state === "relearning") return { word, kind: "lapse", beforeDays, afterMs };
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
   * What the four grade buttons of a card say: the interval each grade gives, in words. `answersToday`: the card's
   * answers today that were not undone, the same count the grade passes to the ladder (spec A3).
   */
  private intervalsOf(mem: Mem, user: Pick<User, "lang">, answersToday: number): Record<Rating, string> {
    const due = preview(mem, this.now, answersToday);
    const words = (rating: Rating) => formatInterval(due[rating] - this.now, user.lang);
    return { 1: words(1), 2: words(2), 3: words(3), 4: words(4) };
  }

  /**
   * The next screen of the session. It carries the hint that is due by what the user has seen (`user.hintsSeen`);
   * after a grade that is none, the grade having marked both of them. The card is picked with the last answers of
   * today (`recentOf`), so a hard word does not come straight back and new words are mixed in (spec A1, A2).
   */
  async nextScreen(user: User, feedback: Feedback | null = null): Promise<Screen> {
    const w = dayWindow(user.tzOffsetMin, this.now);
    const read = await this.sessionQueue(user, w);
    const { q, fresh } = read;
    const newLeft = newLeftOf(user, q.counts);
    const p = pick({ learning: q.learning, review: q.review, newNotes: fresh }, newLeft, this.now, user.mixCounter, recentOf(q.recent));
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
        kind: "done", feedback, empty, lead: onDone(user.hintsSeen),
        summary: { reviewsToday: end.reviewsToday, learnedToday: end.learnedToday, postponedToday: end.postponedToday, streak: user.streak,
          nextLearningInMs: nextDue == null ? null : Math.max(0, nextDue - this.now) },
      };
    }
    let row: CardRow;
    if (p.kind === "new") {
      const mem = newMem(this.now);
      const id = await this.repo.ensureNewCard(user.id, p.note.noteId, p.note.direction, mem);
      row = { ...p.note, id, mem, buriedDay: null };
    } else row = p.card;
    // Only a learning card can have answers today: a review is answered once a day, and a new card not yet.
    const answersToday = q.learning.find((x) => x.id === row.id)?.answersToday ?? 0;
    return {
      kind: "card", view: toView(row, answersToday), counts: this.countsOf(user, read), intervals: this.intervalsOf(row.mem, user, answersToday), feedback, canUndo: feedback != null,
      lead: onCard(user.hintsSeen),
    };
  }

  /**
   * Grades a card as its button said: `tomorrow` is the flag of a button that said «1 день» for «Снова» or «Трудно»
   * (spec A3, `CardView.tomorrow`). Without it there is no postponement, whatever the count of today's answers is now,
   * so a label never differs from what the grade stores, also across the start of the learner's day.
   */
  async grade(user: User, cardId: number, reps: number, rating: Rating, tomorrow = false): Promise<Screen> {
    const card = await this.repo.getCard(user.id, cardId);
    if (!card || card.mem.reps !== reps) return { kind: "stale" };
    const before = card.mem;
    const after = ladderGrade(before, rating, this.now, tomorrow ? DAY_ANSWERS : 0);
    const today = localDay(user.tzOffsetMin, this.now);
    const yesterday = localDay(user.tzOffsetMin, this.now - 86_400_000);
    const streak = user.lastStudyDay === today ? user.streak : user.lastStudyDay === yesterday ? user.streak + 1 : 1;
    const learnedNow = stage(before) !== "learned" && stage(after) === "learned";
    // The hints a graded card ends are marked as seen with the grade, in the user's statement.
    const hintsSeen = afterGrade(user.hintsSeen);
    const stmts = [
      this.repo.gradeCardStmt(card.id, reps, after),
      this.repo.guardedLogStmt({
        cardId: card.id, userId: user.id, rating, stateBefore: before, intervalBeforeDays: before.scheduledDays,
        intervalAfterMs: after.due - this.now, reviewedAt: this.now, wasNew: before.state === "new", learnedNow,
        streakBefore: user.streak, lastStudyDayBefore: user.lastStudyDay,
      }),
      this.repo.guardedUserStmt(user.id, { streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1, hintsSeen }),
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
    const updated: User = { ...user, streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1, hintsSeen };
    return this.nextScreen(updated, feedbackOf(card.word, before, after, this.now));
  }

  /**
   * The card a learner is looking at, drawn again for the button «🔎 Разбор» (spec B4): the same card with its counters
   * (one read of the queue) and nothing stored. Stale, like any button of an old card, when the card is not the
   * learner's, was graded since (`reps` differs) or has no breakdown. `canUndo` is what the card showed: the press
   * changes nothing that ↩ depends on.
   */
  async cardAgain(user: User, cardId: number, reps: number, canUndo: boolean): Promise<Screen> {
    const w = dayWindow(user.tzOffsetMin, this.now);
    const card = await this.repo.cardForGrade(user.id, cardId, w.dayStartMs);
    if (!card || card.mem.reps !== reps) return { kind: "stale" };
    const view = toView(card, card.answersToday);
    if (view.gloss === null) return { kind: "stale" };
    const read = await this.readQueue(user, w);
    return {
      kind: "card", view, intervals: this.intervalsOf(card.mem, user, card.answersToday), feedback: null, canUndo, counts: this.countsOf(user, read),
      lead: onCard(user.hintsSeen),
    };
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
    const w = dayWindow(user.tzOffsetMin, this.now);
    // Read after the undo: the undone answer is no longer one of today's (spec A3).
    const card = await this.repo.cardForGrade(user.id, log.cardId, w.dayStartMs);
    if (!card) return { kind: "noundo" };
    // The queue is read for the counters alone: nothing of it is stored.
    const read = await this.readQueue(user, w);
    return { kind: "card", view: toView(card, card.answersToday), intervals: this.intervalsOf(card.mem, user, card.answersToday), feedback: null, canUndo: false, counts: this.countsOf(user, read), lead: null };
  }
}
