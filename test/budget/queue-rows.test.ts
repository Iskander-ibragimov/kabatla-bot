import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type DayWindow, type Direction, type DirectionSetting, type NewScope, type Queue, Repo } from "../../src/db/repo";
import { CURSOR_STEP, type Spans, mergeStreams, nextSpans } from "../../src/levels/order";
import { LEVELS, type NewMode, tseqOf } from "../../src/levels/scale";
import { type Mem, newMem } from "../../src/srs/fsrs";
import { dayWindow } from "../../src/users/service";
import { readingDb } from "../helpers/readingDb";
import { gradedMem } from "../helpers/review";
import { note, seedLearner } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3. */
const now = Date.UTC(2026, 8, 30, 7, 0);
const TOPICS = 21;
const POS = ["n", "v", "adj", "adv", "pron", "num", "post", "part", "conj", "intj", "phr"];
const ALL_LEVELS = LEVELS.map((l) => l.no as number);
const BOTH: Direction[] = ["tt_ru", "ru_tt"];

interface CatalogNote { id: number; level: number; topicNo: number; seq: number; pos: string }

/**
 * The whole catalog, 3 850 notes in the five levels at their sizes, loaded with one statement a level. In every level
 * the topics 0…20 and the eleven part-of-speech codes follow one another note by note, so every topic holds every code.
 * `rareNumerals`: a numeral is one note in 55 instead of one in 11 (70 in the catalog): a small part of speech.
 */
async function fullCatalog(rareNumerals = false): Promise<CatalogNote[]> {
  const repo = new Repo(env.DB);
  for (const lv of LEVELS) {
    const deckId = await repo.insertDeck({ slug: lv.slug, kind: "catalog", titleRu: lv.code, titleTt: lv.code, levelNo: lv.no, coveragePct: null, ownerId: null });
    const rows = Array.from({ length: lv.size }, (_, i) => ({ w: `сүз${lv.no}х${i + 1}`, p: rareNumerals ? (i % 55 === 5 ? "num" : POS[i % 5]!) : POS[i % POS.length]!, t: i % TOPICS, s: i + 1, q: tseqOf(i % TOPICS, i + 1) }));
    await env.DB.prepare(
      `INSERT INTO notes (deck_id, word, word_key, pos, translation, example_tt, example_ru, example_src, level, topic_no, seq, tseq)
       SELECT ?1, j.value ->> 'w', j.value ->> 'w', j.value ->> 'p', (j.value ->> 'w') || '-ru', (j.value ->> 'w') || '.', (j.value ->> 'w') || '-ru.', 'own',
              ?2, j.value ->> 't', j.value ->> 's', j.value ->> 'q' FROM json_each(?3) j ORDER BY j.key`,
    ).bind(deckId, lv.no, JSON.stringify(rows)).run();
  }
  const { results } = await env.DB.prepare("SELECT id, level, topic_no AS topicNo, seq, pos FROM notes WHERE level IS NOT NULL ORDER BY level, seq").all<CatalogNote>();
  expect(results.map((n) => n.level).filter((l) => l === 1)).toHaveLength(500);
  expect(results).toHaveLength(3850);
  return results;
}

type Where = "start" | "middle" | "end";
type PosScope = "all" | "num";
interface Case { where: Where; mode: NewMode; pos: PosScope; direction: DirectionSetting; startedIn?: NewMode; rareNumerals?: boolean }

const inPos = (c: Case) => (n: CatalogNote) => c.pos === "all" || n.pos === "num";
const directionsOf = (d: DirectionSetting): Direction[] => (d === "both" ? BOTH : [d]);
const ordOf = (mode: NewMode) => (n: CatalogNote) => (mode === "freq" ? n.seq : tseqOf(n.topicNo, n.seq));

type CardSeed = [noteId: number, direction: Direction, mem: Mem, buriedDay: string | null];
/** Cards written straight into the table, two thousand to a statement. */
async function insertCards(userId: number, rows: CardSeed[]) {
  const json = rows.map(([n, d, m, b]) => ({ n, d, st: m.state, sp: m.step, sb: m.stability, df: m.difficulty, du: m.due, lr: m.lastReview, sd: m.scheduledDays, rp: m.reps, lp: m.lapses, b }));
  for (let i = 0; i < json.length; i += 2000) {
    await env.DB.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, step, stability, difficulty, due, last_review, scheduled_days, reps, lapses, buried_day)
       SELECT ?1, j.value ->> 'n', j.value ->> 'd', j.value ->> 'st', j.value ->> 'sp', j.value ->> 'sb', j.value ->> 'df', j.value ->> 'du', j.value ->> 'lr',
              j.value ->> 'sd', j.value ->> 'rp', j.value ->> 'lp', j.value ->> 'b' FROM json_each(?2) j`,
    ).bind(userId, JSON.stringify(json.slice(i, i + 2000))).run();
  }
}

/**
 * A learner (Telegram id 42) with all five levels in the scope and ten own words, subscribed to the five level decks in
 * the old way as well, as the learners who came before the checkboxes are.
 * `start`: nothing is started. `middle`: the first 1 900 catalog words in the order of `startedIn` (the mode of the
 * case unless given: a learner who changed the mode in the middle of a level started them in another order) and five
 * own words are started. `end`: every catalog word is started but the last two of the scope, and five own words.
 * Started means a card graded yesterday in every asked direction; twenty of them are due today. With «оба», of the
 * thirty words started last every third has its reverse card waiting in state 'new', hidden on an earlier day.
 * Returns what a read needs and the catalog words that are left, in the order of the mode.
 */
async function learner(catalog: CatalogNote[], c: Case) {
  const { repo, user } = await seedLearner(env.DB, { now, tgId: 42, patch: { direction: c.direction, newPerDay: 20, levels: 31 } });
  const own = await repo.insertNotes(await repo.customDeck(user.id, now), Array.from({ length: 10 }, (_, i) => note(`үзем${i + 1}`)));
  await env.DB.prepare("INSERT INTO user_decks (user_id, deck_id, added_at) SELECT ?1, id, ?2 FROM decks WHERE kind = 'catalog'").bind(user.id, now).run();
  const directions = directionsOf(c.direction);
  const order = mergeStreams([catalog], c.mode);
  const left = new Set(order.filter(inPos(c)).slice(-2).map((n) => n.id));
  const started = c.where === "start" ? [] : c.where === "middle" ? mergeStreams([catalog], c.startedIn ?? c.mode).slice(0, 1900) : catalog.filter((n) => !left.has(n.id));
  const cards: CardSeed[] = [];
  const yesterday = gradedMem(now - DAY);
  started.forEach((n, i) => {
    const waiting = c.direction === "both" && i >= started.length - 30 && i % 3 === 0;
    for (const d of directions) {
      if (waiting && d === "ru_tt") cards.push([n.id, d, newMem(now - 2 * DAY), "2026-09-28"]);
      else cards.push([n.id, d, i < 20 && d === directions[0] ? { ...yesterday, due: now - MIN } : yesterday, null]);
    }
  });
  if (c.where !== "start") own.slice(0, 5).forEach((id) => directions.forEach((d) => cards.push([id, d, yesterday, null])));
  await insertCards(user.id, cards);
  const startedIds = new Set(started.map((n) => n.id));
  // `topic`: the topic in work — the topic of the next word in the topic order; the fifth for a learner at the start.
  const topicNo = c.mode !== "topic" ? null : c.where === "start" ? 5 : order.find((n) => !startedIds.has(n.id) && inPos(c)(n))!.topicNo;
  const todo = order.filter((n) => !startedIds.has(n.id) && inPos(c)(n) && (topicNo === null || n.topicNo === topicNo));
  const w: DayWindow = { ...dayWindow(180, now), directions };
  const scope: NewScope = { levels: ALL_LEVELS, posCodes: c.pos === "all" ? null : ["num"], mode: c.mode, topicNo, spans: {}, spansVersion: 0 };
  return { userId: user.id, w, scope, todo };
}

/** The new catalog words a read gave, as note ids in the order of the mode. */
const given = (q: Queue, mode: NewMode) => [...new Set(mergeStreams(Object.values(q.streams).map((s) => s ?? []), mode).map((x) => x.noteId))];

/**
 * `stored`: the plan's target for one read of the queue once the read positions are stored. `first`: the spec's limit
 * for the read that finds them. `storedRare`: a scope whose words are rare in the levels does not meet the target —
 * a stream walks every note from the read position to its third note, one row each, and with one numeral in 55 that
 * is some hundred notes a level; measured up to 1 768. The binding limit is the 2 500 rows of a whole grade; this
 * figure leaves the rest of a grade 500 of them.
 */
const BUDGET = { stored: 1500, storedRare: 2000, first: 20_000 } as const;

/**
 * Three reads of one learner, the rows of each: the first with no read positions; the next with the positions the
 * first one found; and one with those same positions after the learner went on as far as a position may lag behind
 * (it is saved only when it moved by CURSOR_STEP): in every level the words up to CURSOR_STEP - 1 order values past
 * the position are started. Every read must give the words that are next in the order of the mode.
 */
async function reads(catalog: CatalogNote[], c: Case) {
  const l = await learner(catalog, c);
  const db = readingDb(env.DB);
  const repo = new Repo(db);
  const read = async (spans: Spans, version: number) => {
    db.rowsRead = 0;
    const q = await repo.queue(l.userId, l.w, { ...l.scope, spans, spansVersion: version });
    expect(db.calls).toBe(1);
    db.calls = 0;
    return { q, rows: db.rowsRead };
  };
  const expectNext = (q: Queue, todo: CatalogNote[]) => expect(given(q, c.mode).slice(0, 3)).toEqual(todo.slice(0, 3).map((n) => n.id));
  const first = await read({}, -1);
  expectNext(first.q, l.todo);
  const { spans } = nextSpans({}, first.q.seen);
  const stored = await read(spans, first.q.catalogVersion);
  expect(stored.q.streams).toEqual(first.q.streams);
  expect(stored.q.seen).toEqual(first.q.seen);

  const ord = ordOf(c.mode);
  const ahead = l.todo.filter((n) => { const s = spans[n.level]; return s != null && ord(n) > s.from && ord(n) < s.from + CURSOR_STEP; });
  const yesterday = gradedMem(now - DAY);
  await insertCards(l.userId, ahead.flatMap((n) => l.w.directions.map((d): CardSeed => [n.id, d, yesterday, null])));
  const gone = new Set(ahead.map((n) => n.id));
  const lagging = await read(spans, first.q.catalogVersion);
  expectNext(lagging.q, l.todo.filter((n) => !gone.has(n.id)));
  return { first: first.rows, stored: stored.rows, lagging: lagging.rows };
}

const title = (c: Case) =>
  `${c.where}, ${c.mode}${c.startedIn ? ` after ${c.startedIn}` : ""}, ${c.pos === "all" ? "all parts of speech" : c.rareNumerals ? "numerals only and rare" : "numerals only"}, ${c.direction}`;

describe("D1 rows read by repo.queue with the whole catalog (3 850 notes) and all five levels in the scope", () => {
  const cases: Case[] = [];
  for (const where of ["start", "middle", "end"] as const) {
    for (const mode of ["guided", "topic", "freq"] as const) {
      for (const pos of ["all", "num"] as const) {
        for (const direction of ["tt_ru", "both"] as const) cases.push({ where, mode, pos, direction });
      }
    }
  }
  // A learner who changed the mode in the middle of a level: the words were started in the order of the other mode.
  for (const direction of ["tt_ru", "both"] as const) {
    for (const pos of ["all", "num"] as const) {
      cases.push({ where: "middle", mode: "guided", startedIn: "freq", pos, direction });
      cases.push({ where: "middle", mode: "freq", startedIn: "guided", pos, direction });
    }
  }
  // A rare part of speech: the stream of a level walks far to its third note.
  for (const mode of ["guided", "freq"] as const) {
    for (const where of ["start", "middle"] as const) cases.push({ where, mode, pos: "num", direction: "tt_ru", rareNumerals: true });
  }
  cases.push({ where: "middle", mode: "freq", startedIn: "guided", pos: "num", direction: "both", rareNumerals: true });
  for (const c of cases) {
    it(`${title(c)}: the first read and the reads with stored positions stay within the budget`, async () => {
      const r = await reads(await fullCatalog(c.rareNumerals), c);
      const stored = c.rareNumerals ? BUDGET.storedRare : BUDGET.stored;
      expect(r.first).toBeLessThanOrEqual(BUDGET.first);
      expect(r.stored).toBeLessThanOrEqual(stored);
      expect(r.lagging).toBeLessThanOrEqual(stored);
    });
  }
});
