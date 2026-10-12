import { type Direction, Repo } from "../../src/db/repo";
import { hasLevel, posCodesOf } from "../../src/levels/scale";
import { type CardView, ReviewService, type Screen, directionsOf } from "../../src/review/service";
import type { Rating } from "../../src/srs/ladder";
import { localDay } from "../../src/users/service";

/** One card a learner was shown. `fresh`: it was shown as a new card, never graded before. */
export interface Shown { at: number; word: string; noteId: number; direction: Direction; fresh: boolean }

/**
 * A new card of the reference list and the part of the list it stands in: `own` — a word of the learner's own decks;
 * `row` — a card of a catalog word that exists and was never graded; `stream` — a card of a catalog word that has no
 * row yet. `level`: the level of a catalog word, null for an own one.
 */
export interface NewCard { noteId: number; word: string; direction: Direction; from: "own" | "row" | "stream"; level: number | null }

/**
 * The new cards a learner has for the local day `today`, every one of them and in the documented order, written the
 * plain way — every note and every card of the learner is read and the rules are applied one by one — so it is the
 * reference the queue is compared with. The settings are read from the learner's row; `directions` replaces the
 * directions the learner asks for.
 *
 * 1. The words of the own and the AI decks, by note id. No setting applies to them.
 * 2. The cards of catalog words that exist and were never graded (the reverse card of a word, a card that was shown
 *    and not graded), by note id, whatever is checked: the learner has met these words.
 * 3. The catalog words with no card yet in an asked direction, of the checked levels and parts of speech. `freq`: the
 *    lower level first, then the order of the level. `guided` and `topic`: by the anchor topic, then the lower level,
 *    then the guided order of the level; with a topic chosen only the words of that topic; `topic` with no topic
 *    chosen gives none.
 * In every part the directions of a word come in the order asked. A card is new while it was never graded; the cards
 * of a word graded today are hidden until tomorrow; a catalog word the learner owns a copy of is never given.
 */
export async function allNewCards(db: D1Database, userId: number, today: string, directions?: Direction[]): Promise<NewCard[]> {
  const user = (await new Repo(db).getUser(userId))!;
  const asked = directions ?? directionsOf(user);
  const cards = (await db.prepare("SELECT note_id, direction, state, buried_day FROM cards WHERE user_id = ?").bind(userId)
    .all<{ note_id: number; direction: Direction; state: string; buried_day: string | null }>()).results;
  const notes = (await db.prepare(
    `SELECT n.id, n.word, n.word_key, n.pos, n.level, n.topic_no, n.seq, n.tseq, dk.owner_id,
            EXISTS (SELECT 1 FROM user_decks ud WHERE ud.user_id = ?1 AND ud.deck_id = dk.id) AS subscribed
     FROM notes n JOIN decks dk ON dk.id = n.deck_id ORDER BY n.id`,
  ).bind(userId).all<{ id: number; word: string; word_key: string; pos: string; level: number | null; topic_no: number | null; seq: number | null; tseq: number | null; owner_id: number | null; subscribed: number }>()).results;
  const stateOf = new Map(cards.map((c) => [`${c.note_id}:${c.direction}`, c.state]));
  const hidden = new Set(cards.filter((c) => c.buried_day === today).map((c) => c.note_id));
  const owned = new Set(notes.filter((n) => n.owner_id === userId).map((n) => n.word_key));
  const card = (n: (typeof notes)[number], direction: Direction, from: NewCard["from"]): NewCard => ({ noteId: n.id, word: n.word, direction, from, level: n.level });

  const own = notes.filter((n) => n.owner_id !== null && n.subscribed === 1 && !hidden.has(n.id))
    .flatMap((n) => asked.filter((d) => (stateOf.get(`${n.id}:${d}`) ?? "new") === "new").map((d) => card(n, d, "own")));
  const catalog = notes.filter((n) => n.level !== null && !owned.has(n.word_key) && !hidden.has(n.id));
  const rows = catalog.flatMap((n) => asked.filter((d) => stateOf.get(`${n.id}:${d}`) === "new").map((d) => card(n, d, "row")));
  const codes = posCodesOf(user.posGroups);
  const topic = user.newMode === "freq" ? null : user.topicNo;
  const noTopic = user.newMode === "topic" && user.topicNo === null;
  const anchor = (n: (typeof notes)[number]) => Math.floor(n.tseq! / 1_000_000);
  const stream = catalog
    .filter((n) => !noTopic && hasLevel(user.levels, n.level!) && (codes === null || codes.includes(n.pos)) && (topic === null || n.topic_no === topic))
    .sort((a, b) => (user.newMode === "freq" ? a.level! - b.level! || a.seq! - b.seq! : anchor(a) - anchor(b) || a.level! - b.level! || a.tseq! - b.tseq!))
    .flatMap((n) => asked.filter((d) => !stateOf.has(`${n.id}:${d}`)).map((d) => card(n, d, "stream")));
  return [...own, ...rows, ...stream];
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
    shown.push({ at: now, word: s.view.word, noteId: s.view.noteId, direction: s.view.direction, fresh: s.view.mem.state === "new" });
    now += 5000;
    s = await new ReviewService(repo, now).grade(await user(), s.view.cardId, s.view.reps, o.rate(s.view, shown.length - 1), s.view.tomorrow);
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
