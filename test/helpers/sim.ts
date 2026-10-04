import type { Direction, Repo } from "../../src/db/repo";
import { type CardView, type LevelUp, ReviewService, type Screen } from "../../src/review/service";
import type { Rating } from "../../src/srs/fsrs";
import { localDay } from "../../src/users/service";

/** One card a learner was shown. `fresh`: it was shown as a new card, never graded before. */
export interface Shown { at: number; word: string; noteId: number; direction: Direction; fresh: boolean; levelUp: LevelUp | null }

/**
 * The new cards a learner has for the local day `today`, every one of them and in the documented order: own and AI
 * decks first, then the levels by number, inside a deck by note id, the directions of a note in the order asked.
 * A card is new while it was never graded; the cards of a word graded today are hidden until tomorrow; a level word
 * the learner owns a copy of is skipped. Written the plain way, note by note over every open deck — the query the
 * queue used before it was given a read budget (commit 7effa0b) — so it is the reference the queue is compared with.
 */
export async function allNewCards(db: D1Database, userId: number, today: string, directions: Direction[]): Promise<{ noteId: number; word: string; direction: Direction; levelNo: number | null }[]> {
  const { results } = await db.prepare(
    `SELECT n.id AS note_id, n.word, d.value AS direction, dk.level_no FROM notes n JOIN decks dk ON dk.id = n.deck_id JOIN json_each(?2) d
     WHERE n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)
       AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ?1 AND c.note_id = n.id AND ((c.direction = d.value AND c.state != 'new') OR c.buried_day = ?3))
       AND NOT (dk.kind = 'catalog' AND EXISTS (SELECT 1 FROM notes o JOIN decks od ON od.id = o.deck_id WHERE od.owner_id = ?1 AND o.word_key = n.word_key))
     ORDER BY (dk.kind = 'catalog'), COALESCE(dk.level_no, 0), n.id, d.key`,
  ).bind(userId, JSON.stringify(directions), today).all<{ note_id: number; word: string; direction: Direction; level_no: number | null }>();
  return results.map((r) => ({ noteId: r.note_id, word: r.word, direction: r.direction, levelNo: r.level_no }));
}

export interface StudyOptions {
  /** The grade for the card on screen; `nth` counts the cards of this sitting from 0. */
  rate: (view: CardView, nth: number) => Rating;
  /** The learner leaves when this card comes up, without grading it. */
  leaveAt?: (view: CardView, nth: number) => boolean;
  /** False: the learner leaves at the first «на сегодня всё» instead of coming back for the cards that are still being learned. */
  waitForSteps?: boolean;
  /** Called for every card screen before it is graded. */
  onCard?: (screen: Extract<Screen, { kind: "card" }>, now: number) => Promise<void>;
}

/**
 * One sitting of a learner through `ReviewService`: «Учить» at `start`, then every card is graded, five seconds a card,
 * until the bot has nothing more for today. When only cards on a learning step are left, the learner comes back when
 * the next one is due (the same local day). Returns the cards in the order they were shown.
 */
export async function study(repo: Repo, userId: number, start: number, o: StudyOptions): Promise<Shown[]> {
  const shown: Shown[] = [];
  const user = async () => (await repo.getUser(userId))!;
  let now = start;
  let s = await new ReviewService(repo, now).nextScreen(await user());
  for (let guard = 0; guard < 2000; guard++) {
    if (s.kind === "done" && (o.waitForSteps ?? true) && s.summary.nextLearningInMs != null) {
      const u = await user();
      const back = now + s.summary.nextLearningInMs + 1000;
      if (localDay(u.tzOffsetMin, back) !== localDay(u.tzOffsetMin, start)) break;
      now = back;
      s = await new ReviewService(repo, now).nextScreen(u);
      continue;
    }
    if (s.kind !== "card") break;
    if (o.leaveAt?.(s.view, shown.length)) break;
    await o.onCard?.(s, now);
    shown.push({ at: now, word: s.view.word, noteId: s.view.noteId, direction: s.view.direction, fresh: s.view.mem.state === "new", levelUp: s.levelUp });
    now += 5000;
    s = await new ReviewService(repo, now).grade(await user(), s.view.cardId, s.view.reps, o.rate(s.view, shown.length - 1));
  }
  return shown;
}

/** A small seeded generator (mulberry32): the same seed gives the same learner. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
