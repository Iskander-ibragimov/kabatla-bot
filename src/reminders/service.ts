import { PREVIEW_TTL_MS } from "../content/service";
import { type Asked, type Lang, type Repo, deckHasUnshown, newCardRows, unshownInTail } from "../db/repo";
import { dict } from "../i18n";
import { claim, completeMany, fail } from "../jobs/queue";
import { LEVELS } from "../levels/scale";
import { type TgApi, tgErrorInfo } from "../tg/client";
import { EVENING_AT, localDay, nextOccurrence } from "../users/service";

export interface TickDeps { repo: Repo; tg: TgApi; now: number }

const MAX_SENDS = 35;
/** A finished job is kept this long (the admin screen counts the failures of the last day), then deleted. */
const DONE_JOBS_KEPT_MS = 7 * 86_400_000;
const EVENING_SCAN = 100;

/* SQL fragments; ?1 = now (ms). Local day uses the 04:00 boundary. */
const NOW = "CAST(?1 AS INTEGER)";
const LOCAL_MIN = `(((${NOW} / 60000) + u.tz_offset_min) % 1440)`;
const DAY_START = `(((${NOW} + (u.tz_offset_min - 240) * 60000) / 86400000) * 86400000 - (u.tz_offset_min - 240) * 60000)`;
const READY = "+u.active = 1 AND u.onboarding_step IS NULL";
/** The most new words a user may ask for in a day (`NEW_PER_DAY` of users/service.ts): no more of a deck's new words need counting. */
const MOST_NEW = 20;
/** The directions the user learns. A reminder comes before the day's first review, so no card counts as buried today. */
const ASKED: Asked = { today: "''", tt: "(u.direction != 'ru_tt')", ru: "(u.direction != 'tt_ru')" };
/**
 * The new words that wait for the user, an estimate that costs a few rows however large the catalog is. Three kinds
 * are added up:
 * - the cards that exist in state 'new' in a direction the user asks for — with both directions, the other card of a
 *   word that was graded, which waits for its day — up to MOST_NEW;
 * - the words of the user's own decks («Мои слова», AI decks) that were never shown in such a direction, up to
 *   MOST_NEW per deck. Every own deck is asked through its last note, and only a deck that has such words is
 *   counted, through its last MOST_NEW notes;
 * - the cards of the checked levels that are not started, by the counters: for every checked level, the cards in its
 *   deck less the words the user has started in it (`user_progress`), never below 0. Five decks through
 *   idx_decks_level and the counters of the checked levels are read, no note and no card.
 * The last one takes no notice of the checked parts of speech, of the chosen topic or of the direction: with narrow
 * settings the number says more than the session gives, and a learner who went over to another direction with
 * every checked level started is told of no new word though the session has some.
 */
const NEW_WAITING = `(${newCardRows("u.id", ASKED, MOST_NEW)}
  + (SELECT COALESCE(SUM(${unshownInTail("u.id", "dk", ASKED, MOST_NEW)}), 0) FROM user_decks ud JOIN decks dk ON dk.id = ud.deck_id
     WHERE ud.user_id = u.id AND dk.owner_id IS NOT NULL AND ${deckHasUnshown("u.id", "dk", ASKED)})
  + (SELECT COALESCE(SUM(MAX(0, d.total - COALESCE((SELECT SUM(p.started) FROM user_progress p WHERE p.user_id = u.id AND p.level = d.level_no), 0))), 0)
     FROM decks d WHERE d.level_no BETWEEN 1 AND ${LEVELS.length} AND d.kind = 'catalog' AND (u.levels >> (d.level_no - 1)) & 1))`;

interface Push { chat_id: number; text: string; reply_markup: unknown; parse_mode: "HTML" }
interface Planned { userId: number; push: Push }

const button = (text: string) => ({ inline_keyboard: [[{ text, callback_data: "learn", style: "primary" }]] });

/**
 * Runs every minute. Candidates come from indexed columns (next_daily_at, next_evening_at, last_review_at),
 * so only due users are read. The same first batch deletes previews that can no longer be confirmed and old finished jobs. The reviews due today are counted in the index idx_cards_user_state_due alone, one row
 * per due card: a deck, once open, is never closed, so the deck of a card is not looked up. Users are marked before sending (at-most-once), so a crashed or slow tick never repeats a push.
 * The daily push counts the reviews due today and, apart from them, the new words today's limit still allows, of those
 * that wait (NEW_WAITING); with no review due and new words waiting it calls to learn them. The bot checks no level by itself: a learner whose checked levels are started whole, with nothing
 * due and no word of their own to learn, gets no push.
 */
export async function tick(d: TickDeps): Promise<{ sent: number }> {
  const { repo, tg, now } = d;
  const db = repo.db;
  const [daily, evening, step] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT u.id, u.chat_id, u.lang, u.tz_offset_min, u.remind_at,
        (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','review','relearning') AND c.due < ${DAY_START} + 86400000) AS due_n,
        MIN(MAX(0, u.new_per_day - (SELECT COUNT(*) FROM review_log r WHERE r.user_id = u.id AND r.was_new = 1 AND r.undone = 0 AND r.reviewed_at >= ${DAY_START})),
            ${NEW_WAITING}) AS new_n
      FROM users u WHERE u.next_daily_at <= ${NOW} AND ${READY}
      ORDER BY u.next_daily_at, u.id LIMIT ${MAX_SENDS}`).bind(now),
    db.prepare(`SELECT u.id, u.chat_id, u.lang, u.tz_offset_min, u.streak, u.last_study_day FROM users u
      WHERE u.next_evening_at <= ${NOW} AND ${READY} ORDER BY u.next_evening_at, u.id LIMIT ${EVENING_SCAN}`).bind(now),
    db.prepare(`SELECT u.id, u.chat_id, u.lang,
        (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','relearning') AND c.due <= ${NOW}) AS waiting
      FROM users u WHERE u.last_review_at BETWEEN ${NOW} - 86400000 AND ${NOW} - 180000 AND ${READY}
        AND (u.last_step_ping_at IS NULL OR u.last_step_ping_at < u.last_review_at)
        AND ${LOCAL_MIN} >= 480 AND ${LOCAL_MIN} < 1380
        AND EXISTS (SELECT 1 FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','relearning') AND c.due <= ${NOW})
      ORDER BY u.id LIMIT ${MAX_SENDS}`).bind(now),
    // Housekeeping rides in the batch the tick makes anyway: expired previews and old finished jobs go.
    ...repo.purgeStmts(now - PREVIEW_TTL_MS, now - DONE_JOBS_KEPT_MS),
  ]);

  const marks: D1PreparedStatement[] = [];
  const plan: Planned[] = [];
  const room = () => MAX_SENDS - plan.length;

  for (const r of daily!.results as { id: number; chat_id: number; lang: Lang; tz_offset_min: number; remind_at: string; due_n: number; new_n: number }[]) {
    marks.push(repo.updateUserStmt(r.id, { nextDailyAt: nextOccurrence(r.tz_offset_min, r.remind_at, now) }));
    // The reviews due and the new words are named apart; the minutes are those of the reviews, as in bot-anki.
    if (r.due_n + r.new_n > 0) {
      const t = dict(r.lang);
      plan.push({ userId: r.id, push: { chat_id: r.chat_id, text: t.pushDaily(r.due_n, Math.max(1, Math.ceil(r.due_n / 3)), r.new_n), reply_markup: button(t.startBtn), parse_mode: "HTML" } });
    }
  }
  for (const r of evening!.results as { id: number; chat_id: number; lang: Lang; tz_offset_min: number; streak: number; last_study_day: string | null }[]) {
    const atRisk = r.streak >= 2 && r.last_study_day === localDay(r.tz_offset_min, now - 86_400_000);
    if (atRisk && room() <= 0) continue; // stays due; handled next minute
    marks.push(repo.updateUserStmt(r.id, { nextEveningAt: nextOccurrence(r.tz_offset_min, EVENING_AT, now) }));
    if (!atRisk) continue;
    const t = dict(r.lang);
    plan.push({ userId: r.id, push: { chat_id: r.chat_id, text: t.pushEvening(r.streak), reply_markup: button(t.saveStreakBtn), parse_mode: "HTML" } });
  }
  for (const r of step!.results as { id: number; chat_id: number; lang: Lang; waiting: number }[]) {
    if (room() <= 0) break;
    marks.push(repo.updateUserStmt(r.id, { lastStepPingAt: now }));
    const t = dict(r.lang);
    plan.push({ userId: r.id, push: { chat_id: r.chat_id, text: t.pushStep(r.waiting), reply_markup: button(t.continueBtn), parse_mode: "HTML" } });
  }
  if (marks.length) await repo.batch(marks);

  let sent = 0;
  let limitedUntil: number | null = null;
  const after: D1PreparedStatement[] = [];
  /** Sends one push; on 429 the rest of this tick's pushes are queued for later. */
  const send = async (userId: number | null, p: Push): Promise<"ok" | "limited" | "error"> => {
    if (limitedUntil != null) { after.push(enqueueStmt(db, p, limitedUntil)); return "limited"; }
    try {
      await tg.call("sendMessage", p as unknown as Record<string, unknown>);
      sent++;
      return "ok";
    } catch (e) {
      const info = tgErrorInfo(e);
      if (info?.code === 429) {
        limitedUntil = now + (info.retryAfter ?? 30) * 1000;
        after.push(enqueueStmt(db, p, limitedUntil));
        return "limited";
      }
      if (info?.code === 403 && userId != null) after.push(repo.updateUserStmt(userId, { active: false }));
      else console.error("push failed", info ?? String(e));
      return "error";
    }
  };
  for (const p of plan) await send(p.userId, p.push);

  if (limitedUntil == null && sent < MAX_SENDS) {
    const jobs = await claim(db, now, Math.min(10, MAX_SENDS - sent));
    const done: number[] = [];
    for (const j of jobs) {
      try {
        if (j.kind === "push") {
          const res = await send(null, j.payload as unknown as Push);
          done.push(j.id);
          if (res === "limited") break;
        } else done.push(j.id);
      } catch (e) {
        await fail(db, j.id, String((e as Error).message ?? e), now);
      }
    }
    await completeMany(db, done, now);
  }
  if (after.length) await repo.batch(after);
  return { sent };
}

function enqueueStmt(db: D1Database, payload: Push, runAt: number): D1PreparedStatement {
  return db.prepare("INSERT INTO jobs (kind, payload, run_at) VALUES ('push', ?, ?)").bind(JSON.stringify(payload), runAt);
}
