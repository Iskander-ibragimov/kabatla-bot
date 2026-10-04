import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type DayWindow, type Direction, type DirectionSetting, type NewScope, type Queue, Repo } from "../../src/db/repo";
import { CURSOR_STEP, type Spans, guidedTseq, mergeStreams, nextSpans } from "../../src/levels/order";
import { LEVELS, type NewMode } from "../../src/levels/scale";
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

interface CatalogNote { id: number; level: number; topicNo: number; seq: number; tseq: number; pos: string }

/**
 * The whole catalog, 3 850 notes in the five levels at their sizes, loaded with one statement a level. In every level
 * the topics 0…20 and the eleven part-of-speech codes follow one another note by note, so every topic holds every code.
 * The guided order is the one the catalog seed gives (`guidedTseq`): the basic words (topic 0, one note in 21) stand
 * among the themed ones at the beginning of the level.
 * `numerals`: how many of the notes are numerals. `even`: one in 11, like every other code. `rare`: one in 55 (70 in
 * the catalog), a small part of speech. `sparse`: three a level, at a tenth, a half and nine tenths of it, far apart.
 */
type Numerals = "even" | "rare" | "sparse";
async function fullCatalog(numerals: Numerals): Promise<CatalogNote[]> {
  const posAt = (i: number, size: number) =>
    numerals === "even" ? POS[i % POS.length]!
      : (numerals === "rare" ? i % 55 === 5 : [0.1, 0.5, 0.9].some((part) => i === Math.floor(size * part))) ? "num" : POS[i % 5]!;
  const repo = new Repo(env.DB);
  for (const lv of LEVELS) {
    const deckId = await repo.insertDeck({ slug: lv.slug, kind: "catalog", titleRu: lv.code, titleTt: lv.code, levelNo: lv.no, coveragePct: null, ownerId: null });
    const tseq = guidedTseq(Array.from({ length: lv.size }, (_, i) => ({ topicNo: i % TOPICS, seq: i + 1 })));
    const rows = Array.from({ length: lv.size }, (_, i) => ({ w: `сүз${lv.no}х${i + 1}`, p: posAt(i, lv.size), t: i % TOPICS, s: i + 1, q: tseq[i]! }));
    await env.DB.prepare(
      `INSERT INTO notes (deck_id, word, word_key, pos, translation, example_tt, example_ru, example_src, level, topic_no, seq, tseq)
       SELECT ?1, j.value ->> 'w', j.value ->> 'w', j.value ->> 'p', (j.value ->> 'w') || '-ru', (j.value ->> 'w') || '.', (j.value ->> 'w') || '-ru.', 'own',
              ?2, j.value ->> 't', j.value ->> 's', j.value ->> 'q' FROM json_each(?3) j ORDER BY j.key`,
    ).bind(deckId, lv.no, JSON.stringify(rows)).run();
  }
  const { results } = await env.DB.prepare("SELECT id, level, topic_no AS topicNo, seq, tseq, pos FROM notes WHERE level IS NOT NULL ORDER BY level, seq").all<CatalogNote>();
  expect(results.map((n) => n.level).filter((l) => l === 1)).toHaveLength(500);
  expect(results).toHaveLength(3850);
  return results;
}

type Where = "start" | "middle" | "end" | "run";
/** The level of the `run` learner: A2, 850 words. */
const RUN_LEVEL = 2;
type PosScope = "all" | "num";
interface Case { where: Where; mode: NewMode; pos: PosScope; direction: DirectionSetting; startedIn?: NewMode; numerals?: Numerals; topicNo?: number }

const inPos = (c: Case) => (n: CatalogNote) => c.pos === "all" || n.pos === "num";
const directionsOf = (d: DirectionSetting): Direction[] => (d === "both" ? BOTH : [d]);
const ordOf = (mode: NewMode) => (n: CatalogNote) => (mode === "freq" ? n.seq : n.tseq);

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
 * `run`: one level (A2) is started but for its first and its last word in the order of the mode, and nothing else of
 * the catalog — a long run of started words stands right behind the head of that level, as after a change of the mode.
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
  // The scope of a chosen topic: the topic of the case, or any themed topic when the case leaves the choice open.
  const inTopic = (n: CatalogNote) => c.mode !== "topic" || (c.topicNo == null ? n.topicNo >= 1 : n.topicNo === c.topicNo);
  const left = new Set(order.filter((n) => inPos(c)(n) && inTopic(n)).slice(-2).map((n) => n.id));
  const started = c.where === "start" ? []
    : c.where === "middle" ? mergeStreams([catalog], c.startedIn ?? c.mode).slice(0, 1900)
      : c.where === "run" ? order.filter((n) => n.level === RUN_LEVEL).slice(1, -1)
        : catalog.filter((n) => !left.has(n.id));
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
  // `topic`: the topic of the case, or the topic in work — that of the next themed word; the fifth for a learner at the start.
  const topicNo = c.mode !== "topic" ? null : c.topicNo ?? (c.where === "start" ? 5 : order.find((n) => !startedIds.has(n.id) && inPos(c)(n) && inTopic(n))!.topicNo);
  const todo = order.filter((n) => !startedIds.has(n.id) && inPos(c)(n) && (topicNo === null || n.topicNo === topicNo));
  const w: DayWindow = { ...dayWindow(180, now), directions };
  const scope: NewScope = { levels: ALL_LEVELS, posCodes: c.pos === "all" ? null : ["num"], mode: c.mode, topicNo, spans: {}, spansVersion: 0 };
  return { userId: user.id, w, scope, todo };
}

/** The new catalog words a read gave, as note ids in the order of the mode: the heads of the levels. */
const given = (q: Queue, mode: NewMode) => [...new Set(mergeStreams(Object.values(q.streams).map((s) => s ?? []), mode).map((x) => x.noteId))];

/**
 * `stored`: the plan's target for one read of the queue, whatever the read positions stored are worth: fresh, after
 * the walk of one level, or lagging. `first`: the spec's limit for the read that finds the positions after a change
 * of the settings. The walk over a long run of started words behind a head (the `run` learner) belongs to that
 * limit as well: each such word is walked over once, and the position stored then lies past it.
 */
const BUDGET = { stored: 1500, first: 20_000 } as const;

/**
 * Four reads of one learner, the rows of each:
 * - `first`: with no read positions;
 * - `stored`: with the positions the first read found;
 * - `walk`: right after the word that is next was started, before the new position is stored — the level of that
 *   word is walked on to its next word, however far that is; the position this read finds is stored when the
 *   session would store it (`nextSpans` says `save`). For a learner at the end of the scope this goes on to the last
 *   word, and the largest of these reads is taken: the last one walks a level to its end. For the `run` learner the
 *   word started is the head of the level with the run: the read walks over every started word behind it, once;
 * - `after`: the read that follows the walk, with the position the walk found;
 * - `lagging`: with positions that lag as far as they may: a position is stored only when it moved by CURSOR_STEP,
 *   so in every level the words are started up to the last one that lies within CURSOR_STEP of the position.
 * Every read must give, as the first of the merged heads, the word that is next in the order of the mode.
 */
async function reads(catalog: CatalogNote[], c: Case) {
  const l = await learner(catalog, c);
  const db = readingDb(env.DB);
  const repo = new Repo(db);
  const ord = ordOf(c.mode);
  const yesterday = gradedMem(now - DAY);
  let todo = l.todo;
  const start = async (notes: CatalogNote[]) => {
    await insertCards(l.userId, notes.flatMap((n) => l.w.directions.map((d): CardSeed => [n.id, d, yesterday, null])));
    const gone = new Set(notes.map((n) => n.id));
    todo = todo.filter((n) => !gone.has(n.id));
  };
  const read = async (spans: Spans, version: number) => {
    db.rowsRead = 0;
    const q = await repo.queue(l.userId, l.w, { ...l.scope, spans, spansVersion: version });
    expect(db.calls).toBe(1);
    db.calls = 0;
    expect(given(q, c.mode).slice(0, 1)).toEqual(todo.slice(0, 1).map((n) => n.id));
    return { q, rows: db.rowsRead };
  };
  const first = await read({}, -1);
  const version = first.q.catalogVersion;
  let { spans } = nextSpans({}, first.q.seen);
  const stored = await read(spans, version);
  expect(stored.q.streams).toEqual(first.q.streams);
  expect(stored.q.seen).toEqual(first.q.seen);

  let walk = 0;
  const step = async (head = todo[0]) => {
    await start(head ? [head] : []);
    const r = await read(spans, version);
    walk = Math.max(walk, r.rows);
    const moved = nextSpans(spans, r.q.seen);
    if (moved.save) spans = moved.spans;
    return r.q;
  };
  if (c.where === "run") {
    // The head of the level with the run is started: the stream walks over the run and gives the last word of the level.
    const inLevel = todo.filter((n) => n.level === RUN_LEVEL);
    expect(inLevel).toHaveLength(2);
    const q = await step(inLevel[0]);
    expect(q.streams[RUN_LEVEL]!.map((x) => x.noteId)).toEqual(l.w.directions.map(() => inLevel[1]!.id));
    expect(spans[RUN_LEVEL]).toEqual({ from: ord(inLevel[1]!) - 1, to: null });
  } else {
    await step();
  }
  // At the end of the scope the last words are started one by one: the read after the last word of a level walks
  // that level to its end and finds nothing.
  if (c.where === "end") while (todo.length) await step();
  const after = await read(spans, version);

  const behind = ALL_LEVELS.flatMap((level) => {
    const s = spans[level];
    const near = todo.filter((n) => n.level === level && s != null && ord(n) > s.from && ord(n) <= s.from + CURSOR_STEP);
    return near.slice(0, -1);
  });
  await start(behind);
  const lagging = await read(spans, version);
  expect(nextSpans(spans, lagging.q.seen).save).toBe(false);
  return { first: first.rows, stored: stored.rows, walk, after: after.rows, lagging: lagging.rows };
}

const WHERE = { start: "start", middle: "middle", end: "end", run: "a level started but for its first and last word" } as const;
const NUMERALS = { even: "numerals only", rare: "numerals only and rare", sparse: "numerals only, three a level far apart" } as const;
const title = (c: Case) =>
  `${WHERE[c.where]}, ${c.mode}${c.topicNo === 0 ? " of the basic words" : ""}${c.startedIn ? ` after ${c.startedIn}` : ""}, ${c.pos === "all" ? "all parts of speech" : NUMERALS[c.numerals ?? "even"]}, ${c.direction}`;

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
  // A rare part of speech (one note in 55), and one whose few words lie far apart: the walk to the next word is long.
  for (const numerals of ["rare", "sparse"] as const) {
    for (const where of ["start", "middle"] as const) {
      for (const mode of ["guided", "freq"] as const) {
        for (const direction of ["tt_ru", "both"] as const) cases.push({ where, mode, pos: "num", direction, numerals });
      }
    }
    cases.push({ where: "middle", mode: "freq", startedIn: "guided", pos: "num", direction: "both", numerals });
  }
  // The topic of the basic words: they stand among the themed words of the beginning of a level, and a level whose
  // basic words are all started is walked to its end once.
  for (const where of ["start", "middle", "end"] as const) {
    for (const direction of ["tt_ru", "both"] as const) cases.push({ where, mode: "topic", topicNo: 0, pos: "all", direction });
  }
  cases.push({ where: "middle", mode: "topic", topicNo: 0, startedIn: "freq", pos: "all", direction: "both" });
  cases.push({ where: "middle", mode: "topic", topicNo: 0, pos: "num", direction: "both" });
  // A level started in another order: all of it but the first and the last word of the guided order.
  for (const direction of ["tt_ru", "both"] as const) cases.push({ where: "run", mode: "guided", pos: "all", direction });
  for (const c of cases) {
    it(`${title(c)}: the first read, the reads with stored positions and the walk of one level stay within the budgets`, async () => {
      const r = await reads(await fullCatalog(c.numerals ?? "even"), c);
      expect(r.first).toBeLessThanOrEqual(BUDGET.first);
      expect(r.stored).toBeLessThanOrEqual(BUDGET.stored);
      expect(r.walk).toBeLessThanOrEqual(c.where === "run" ? BUDGET.first : BUDGET.stored);
      expect(r.after).toBeLessThanOrEqual(BUDGET.stored);
      expect(r.lagging).toBeLessThanOrEqual(BUDGET.stored);
    });
  }
});
