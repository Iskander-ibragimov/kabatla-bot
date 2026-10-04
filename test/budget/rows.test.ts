import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Direction, type DirectionSetting, Repo } from "../../src/db/repo";
import { mergeStreams } from "../../src/levels/order";
import { ALL_LEVELS, type NewMode, hasLevel, levelBit } from "../../src/levels/scale";
import { tick } from "../../src/reminders/service";
import { newMem } from "../../src/srs/fsrs";
import { harness } from "../helpers/botHarness";
import { type CardSeed, type CatalogNote, bulkCards, bulkCatalog, numeralsAt } from "../helpers/catalog";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { readingDb } from "../helpers/readingDb";
import { gradedMem } from "../helpers/review";
import { note, seedLearner, seedLevels } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3; the reminder of the learners below is due at 09:00. */
const now = Date.UTC(2026, 8, 30, 7, 0);
const BOTH: Direction[] = ["tt_ru", "ru_tt"];
const directionsOf = (d: DirectionSetting): Direction[] => (d === "both" ? BOTH : [d]);

/**
 * The most rows one update may read with the whole catalog loaded (spec §9.3), by the class of its queue read:
 * `grade` — a grade whose read starts at the stored read positions, the one that ends the session included;
 * `first` — the first read after a change of the settings (no position is stored for them yet: «Учить» of a learner
 * seeded here, the grade after the mode or the direction was changed), and a read that walks over a long run of words
 * started under another order behind the head of a level: each such word is walked over once.
 */
const BUDGET = { grade: 2500, first: 20_000, levels: 2500, reminderPerUser: 300 } as const;

/**
 * The whole catalog: 3 850 notes in the five levels at their sizes, the topics 0…20 in turn. One note in 55 is a
 * numeral — a rare part of speech, 70 in the catalog; the others are nouns, verbs, adjectives, adverbs and pronouns.
 */
async function fullCatalog(): Promise<CatalogNote[]> {
  const notes = await bulkCatalog(env.DB, { pos: numeralsAt("rare") });
  expect(notes).toHaveLength(3850);
  expect(new Set(notes.map((n) => n.topicNo)).size).toBe(21);
  return notes;
}

type Where = "start" | "middle" | "end" | "run";
interface Case {
  /** The checked levels: all five, or A2 alone (850 words). */
  levels: "all" | "A2";
  /** Every part of speech, or numerals only. */
  pos: "all" | "num";
  mode: NewMode;
  where: Where;
  direction: DirectionSetting;
  /** The order the started words were started in, when it is not the order of `mode`: the learner changed the mode. */
  startedIn?: NewMode;
}

/**
 * A learner at the bot (Telegram id 42) with ten own words.
 * `start`: no catalog word is started; nine own words are, five of them due today. `middle`: the first half of the
 * checked levels in the order of `startedIn` (the mode unless given). `end`: every word of the checked levels but the
 * last two the settings still give. `run`: the checked levels are started but for their first and their last word in
 * the order of the mode, and every own word is — a long run of started words stands right behind the head.
 * Started means a card graded yesterday in every asked direction; twenty of them are due today. With «оба», of the
 * thirty words started last every third has its reverse card waiting in state 'new', hidden on an earlier day.
 * The counters of started words are what the cards say. No read position is stored.
 */
async function learner(catalog: CatalogNote[], c: Case) {
  const checked = c.levels === "all" ? ALL_LEVELS : levelBit(2);
  const scope = catalog.filter((n) => hasLevel(checked, n.level));
  const order = mergeStreams([scope], c.mode);
  const inPos = (n: CatalogNote) => c.pos === "all" || n.pos === "num";
  const themed = order.filter((n) => inPos(n) && n.topicNo >= 1);
  const half = mergeStreams([scope], c.startedIn ?? c.mode).slice(0, Math.floor(scope.length / 2));
  // `topic`: a learner at the start chose the fifth topic; in the middle, the topic of the next themed word; at the end, the last topic.
  const topicNo = c.mode !== "topic" ? null
    : c.where === "start" ? 5
      : c.where === "middle" ? themed.find((n) => !half.includes(n))!.topicNo
        : themed[themed.length - 1]!.topicNo;
  const left = new Set(order.filter((n) => inPos(n) && (topicNo === null || n.topicNo === topicNo)).slice(-2).map((n) => n.id));
  const started = c.where === "start" ? [] : c.where === "middle" ? half : c.where === "run" ? order.slice(1, -1) : scope.filter((n) => !left.has(n.id));

  const { repo, user } = await seedLearner(env.DB, {
    now, tgId: 42,
    patch: { direction: c.direction, newPerDay: 20, levels: checked, posGroups: c.pos === "all" ? 255 : 1 << 5, newMode: c.mode, topicNo, nextDailyAt: now - 60 * MIN, nextEveningAt: now + 9 * 60 * MIN },
  });
  const own = await repo.insertNotes(await repo.customDeck(user.id, now), Array.from({ length: 10 }, (_, i) => note(`үзем${i + 1}`)));
  const directions = directionsOf(c.direction);
  const yesterday = gradedMem(now - DAY);
  const dueToday = { ...yesterday, due: now - MIN };
  const cards: CardSeed[] = [];
  started.forEach((n, i) => {
    const waiting = c.direction === "both" && i >= started.length - 30 && i % 3 === 0;
    for (const d of directions) {
      if (waiting && d === "ru_tt") cards.push([n.id, d, newMem(now - 2 * DAY), "2026-09-28"]);
      else cards.push([n.id, d, i < 20 && d === directions[0] ? dueToday : yesterday, null]);
    }
  });
  own.slice(0, c.where === "run" ? 10 : 9).forEach((id, i) => directions.forEach((d) => cards.push([id, d, c.where === "start" && i < 5 && d === directions[0] ? dueToday : yesterday, null])));
  await bulkCards(env.DB, user.id, cards);
  await env.DB.prepare(
    `INSERT INTO user_progress (user_id, level, topic_no, started)
     SELECT c.user_id, COALESCE(n.level, 0), COALESCE(n.topic_no, 0), COUNT(DISTINCT c.note_id) FROM cards c JOIN notes n ON n.id = c.note_id
     WHERE c.user_id = ? AND c.state <> 'new' GROUP BY 2, 3`,
  ).bind(user.id).run();
  return { repo, userId: user.id };
}

const gradeButton = (h: ReturnType<typeof harness>, rating: 1 | 2 | 3 | 4): string | undefined =>
  (h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.callback_data).find((c) => new RegExp(`^g:\\d+:\\d+:${rating}$`).test(c));

/** The learner of the database at the bot: `learn` and `grade` give the rows the update read; `grade` gives null when no card is on the screen. */
function atTheBot() {
  const db = readingDb(env.DB);
  const h = harness(db, { now });
  const rowsOf = async (run: () => Promise<unknown>) => { db.rowsRead = 0; await run(); return db.rowsRead; };
  return {
    h,
    learn: () => rowsOf(() => h.text("/learn")),
    grade: async (rating: 3 | 4) => {
      const button = gradeButton(h, rating);
      return button === undefined ? null : rowsOf(() => h.press(button, h.tg.lastMessageId()));
    },
  };
}
/** The rows of up to `n` grades in a row, «Хорошо» and «Легко» in turn, each answered with the next card. */
async function grades(bot: ReturnType<typeof atTheBot>, n: number): Promise<number[]> {
  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    const read = await bot.grade(i % 2 ? 4 : 3);
    if (read === null) break;
    rows.push(read);
  }
  return rows;
}
/** Every card that is left is graded «Легко» until the session ends; the rows of each grade, the one that ended the session last. */
async function toTheEnd(bot: ReturnType<typeof atTheBot>): Promise<number[]> {
  const rows: number[] = [];
  for (let i = 0; i < 60; i++) {
    const read = await bot.grade(4);
    if (read === null) break;
    rows.push(read);
  }
  expect(bot.h.lastText()).toContain("Сегодня:");
  return rows;
}
/** How many catalog words got their first grade in this session. */
const catalogWordsStarted = async (userId: number) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log l JOIN cards c ON c.id = l.card_id JOIN notes n ON n.id = c.note_id WHERE l.user_id = ? AND l.was_new = 1 AND n.level IS NOT NULL").bind(userId).first<{ n: number }>())!.n;

const POS = { all: "all parts of speech", num: "numerals only" } as const;
const title = (c: Case) => `${c.levels === "all" ? "all five levels" : "A2 alone"}, ${POS[c.pos]}, ${c.mode}${c.startedIn ? ` after ${c.startedIn}` : ""}, ${c.where}, ${c.direction}`;

describe("D1 rows read by a session with the whole catalog (3 850 notes) loaded", () => {
  const matrix: Case[] = [];
  for (const levels of ["all", "A2"] as const) {
    for (const pos of ["all", "num"] as const) {
      for (const mode of ["guided", "topic", "freq"] as const) {
        for (const where of ["start", "middle", "end"] as const) {
          for (const direction of ["tt_ru", "both"] as const) matrix.push({ levels, pos, mode, where, direction });
        }
      }
    }
  }
  // A learner who changed the mode in the middle of a level: the words were started in the order of the other mode.
  for (const direction of ["tt_ru", "both"] as const) {
    for (const pos of ["all", "num"] as const) {
      matrix.push({ levels: "all", pos, mode: "guided", startedIn: "freq", where: "middle", direction });
      matrix.push({ levels: "all", pos, mode: "freq", startedIn: "guided", where: "middle", direction });
    }
  }
  for (const c of matrix) {
    it(`${title(c)}: «Учить» is a first read; every grade, the one that ends the session included, is within the grade budget`, async () => {
      const { userId } = await learner(await fullCatalog(), c);
      const bot = atTheBot();
      // Class `first`: no read position is stored for these settings.
      expect(await bot.learn()).toBeLessThanOrEqual(BUDGET.first);
      // Class `grade`: every read starts at the stored positions.
      const plain = await grades(bot, 8);
      expect(Math.max(...plain)).toBeLessThanOrEqual(BUDGET.grade);
      // Eight grades, or fewer when the settings give so few words that the session ended before (a rare part of speech in one topic).
      if (plain.length < 8) expect(bot.h.lastText()).toContain("Сегодня:");
      expect(plain.length).toBeGreaterThanOrEqual(5);
      if (c.where !== "end") return;
      // The learner at the end goes on to the last card: the last words the settings give are started, the levels are
      // read to their ends, and the last grade is answered with the end of the session.
      const rest = await toTheEnd(bot);
      expect(Math.max(...plain, ...rest)).toBeLessThanOrEqual(BUDGET.grade);
      expect(await catalogWordsStarted(userId)).toBeGreaterThanOrEqual(1);
    });
  }

  /** The learner in the middle changes a setting between two grades; the rows of the grade that follows and of the four after it. */
  async function afterChange(c: Case, change: string, value: string) {
    await learner(await fullCatalog(), c);
    const bot = atTheBot();
    await bot.learn();
    expect(await grades(bot, 2)).toHaveLength(2);
    await env.DB.prepare(`UPDATE users SET ${change} = ? WHERE tg_id = 42`).bind(value).run();
    const [first, ...plain] = await grades(bot, 5);
    expect(plain).toHaveLength(4);
    return { first: first!, plain: Math.max(...plain) };
  }
  for (const direction of ["tt_ru", "both"] as const) {
    for (const pos of ["all", "num"] as const) {
      for (const [from, to] of [["guided", "freq"], ["freq", "guided"]] as const) {
        it(`all five levels, ${POS[pos]}, middle, ${direction}: the first grade after the mode is changed from ${from} to ${to} is a first read; the grades after it are within the grade budget`, async () => {
          const r = await afterChange({ levels: "all", pos, mode: from, where: "middle", direction }, "new_mode", to);
          expect(r.first).toBeLessThanOrEqual(BUDGET.first);
          expect(r.plain).toBeLessThanOrEqual(BUDGET.grade);
        });
      }
    }
  }
  for (const mode of ["guided", "freq"] as const) {
    it(`all five levels, all parts of speech, ${mode}, middle: the first grade after a switch from tt_ru to both directions is a first read; the grades after it, which give the reverse cards of the started words, are within the grade budget`, async () => {
      const r = await afterChange({ levels: "all", pos: "all", mode, where: "middle", direction: "tt_ru" }, "direction", "both");
      expect(r.first).toBeLessThanOrEqual(BUDGET.first);
      expect(r.plain).toBeLessThanOrEqual(BUDGET.grade);
    });
  }

  for (const direction of ["tt_ru", "both"] as const) {
    it(`A2 alone, all parts of speech, guided, ${direction}, the level started but for its first and its last word: the grade of the first word walks over the run once, as a first read; the next grades are within the grade budget`, async () => {
      const c: Case = { levels: "A2", pos: "all", mode: "guided", where: "run", direction };
      const { userId } = await learner(await fullCatalog(), c);
      const head = (await env.DB.prepare("SELECT id FROM notes WHERE level = 2 ORDER BY tseq LIMIT 1").first<{ id: number }>())!.id;
      const headStarted = async () =>
        (await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND note_id = ? AND state != 'new'").bind(userId, head).first<{ n: number }>())!.n > 0;
      const bot = atTheBot();
      expect(await bot.learn()).toBeLessThanOrEqual(BUDGET.first);
      // The reviews due today and the reverse cards that wait are graded first; then the head of the level is on the screen.
      const rows: number[] = [];
      while (!(await headStarted())) {
        expect(bot.h.lastText()).toContain("🔵");
        rows.push((await bot.grade(4))!);
      }
      // Class `first`: the read after the head was started walks over the 848 started words behind it and stores the position.
      const walk = rows.pop()!;
      expect(walk).toBeLessThanOrEqual(BUDGET.first);
      expect(walk).toBeGreaterThan(848);
      expect(Math.max(...rows)).toBeLessThanOrEqual(BUDGET.grade);
      const rest = await toTheEnd(bot);
      expect(rest.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...rest)).toBeLessThanOrEqual(BUDGET.grade);
    });
  }
});

/** The catalog of the screens that are not switched yet: twenty levels of a hundred words. */
const HUNDREDS = 20;
const PER_LEVEL = 100;

/** The catalog, 100 words a level: all 20 levels, or the levels `from`…`to`. Returns the note ids by level number, in the order of the level. */
async function hundredsCatalog(from = 1, to = HUNDREDS): Promise<Record<number, number[]>> {
  const levels: Record<number, string[]> = {};
  for (let l = from; l <= to; l++) levels[l] = Array.from({ length: PER_LEVEL }, (_, i) => `сүз${l}х${i + 1}`);
  const decks = await seedLevels(env.DB, levels, Object.fromEntries(Object.keys(levels).map((l) => [l, 27 + 3 * Number(l)])));
  const ids: Record<number, number[]> = {};
  for (let l = from; l <= to; l++) {
    ids[l] = (await env.DB.prepare("SELECT id FROM notes WHERE deck_id = ? ORDER BY id").bind(decks[l]).all<{ id: number }>()).results.map((r) => r.id);
  }
  expect(Object.values(ids).flat()).toHaveLength((to - from + 1) * PER_LEVEL);
  return ids;
}

const ownWords = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => note(`үзем${from + i}`));

type Progress = "in order" | "none" | "scattered" | "stragglers" | "switched";

/**
 * A learner (Telegram id 42) on level `level` with the levels 1…`level` open, ten own words, and a reminder that is due.
 * `progress: "in order"` — the levels below are finished, half of the current one and half of the own words are started,
 * twenty of the started cards are due today. `progress: "none"` — the levels were opened and nothing was started.
 *
 * Three more shapes, for the direction «оба» only, where the cards of a level are not started in the order of its words:
 * `"scattered"` — as "in order", but in the current level and in the own deck every third started word and the ten
 * started last were asked Tatar → Russian only: their reverse cards wait in state 'new', hidden on an earlier day.
 * `"stragglers"` — every word of every open level and every own word is started in both directions, the last word of
 * each deck included, except twelve words spread over the lowest, the middle and the current level and one own word,
 * whose reverse cards were hidden on the days the rest was asked and still wait in state 'new'.
 * `"switched"` — the learner learned everything Tatar → Russian and then switched to «оба»: every word of every open
 * level is started in one direction, and the repetitions since the switch have created the reverse card of every
 * word in state 'new'; the own words are finished in both directions.
 */
async function hundredsLearner(catalog: Record<number, number[]>, level: number, direction: DirectionSetting, progress: Progress, existing?: { id: number; own: number[] }) {
  const repo = new Repo(env.DB);
  const id = existing?.id ?? (await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now }));
  await repo.updateUser(id, { onboardingStep: null, tzOffsetMin: 180, level, direction, newPerDay: 20, nextDailyAt: now - 60 * MIN, nextEveningAt: now + 9 * 60 * MIN });
  await env.DB.prepare("INSERT INTO user_decks (user_id, deck_id, added_at) SELECT ?1, id, ?2 FROM decks WHERE level_no <= ?3").bind(id, now, level).run();
  const own = existing?.own ?? (await repo.insertNotes(await repo.customDeck(id, now), ownWords(1, 10)));
  const below = Array.from({ length: level - 1 }, (_, i) => catalog[i + 1]!).flat();
  const current = catalog[level]!;
  /** A card that was graded yesterday; the first twenty of a shape are due today. */
  const graded = (noteId: number, d: Direction, due: boolean) => repo.insertCardStmt(id, noteId, d, { ...gradedMem(now - DAY), ...(due ? { due: now - MIN } : {}) });
  /** The reverse card of a word whose other card was graded on an earlier day: never graded itself, hidden on that day. */
  const waiting = (noteId: number) => repo.insertCardStmt(id, noteId, "ru_tt", newMem(now - 2 * DAY), "2026-09-28");
  const cards: D1PreparedStatement[] = [];
  if (progress === "in order") {
    [...own.slice(0, 5), ...below, ...current.slice(0, PER_LEVEL / 2)].forEach((noteId, i) => directionsOf(direction).forEach((d) => cards.push(graded(noteId, d, i < 20))));
  } else if (progress === "scattered") {
    below.forEach((noteId, i) => BOTH.forEach((d) => cards.push(graded(noteId, d, i < 20))));
    const half = (deck: number[], started: number) => deck.slice(0, started).forEach((noteId, i) => {
      cards.push(graded(noteId, "tt_ru", false));
      cards.push(i % 3 === 0 || i >= started - 10 ? waiting(noteId) : graded(noteId, "ru_tt", false));
    });
    half(own, 5);
    half(current, PER_LEVEL / 2);
  } else if (progress === "stragglers") {
    // Twelve level words in all: the same places in each of the (up to three) levels, more places when the levels are fewer.
    const levels = [...new Set([1, Math.ceil(level / 2), level])];
    const places = [7, 31, 58, 90, 3, 19, 44, 45, 46, 61, 77, 83].slice(0, 12 / levels.length);
    const left = new Set([own[3]!, ...levels.flatMap((l) => places.map((i) => catalog[l]![i]!))]);
    [...own, ...below, ...current].forEach((noteId, i) => {
      cards.push(graded(noteId, "tt_ru", i < 20));
      cards.push(left.has(noteId) ? waiting(noteId) : graded(noteId, "ru_tt", false));
    });
  } else if (progress === "switched") {
    own.forEach((noteId) => BOTH.forEach((d) => cards.push(graded(noteId, d, false))));
    [...below, ...current].forEach((noteId, i) => { cards.push(graded(noteId, "tt_ru", i < 20)); cards.push(waiting(noteId)); });
  }
  for (let i = 0; i < cards.length; i += 100) await repo.batch(cards.slice(i, i + 100));
  return id;
}

async function levelsRows(): Promise<number> {
  const db = readingDb(env.DB);
  const h = harness(db, { now });
  await h.text("/levels");
  expect(h.lastText()).toContain("📚");
  return db.rowsRead;
}

async function reminderRows(): Promise<number> {
  const db = readingDb(env.DB);
  const tg = fakeTelegram();
  await tick({ repo: new Repo(db), tg, now });
  expect(tg.of("sendMessage")).toHaveLength(1);
  return db.rowsRead;
}

describe("D1 rows read by /levels and the reminder, which still go by the twenty levels of a hundred words (2 000 notes)", () => {
  /** /levels and the reminder of the learner in the database: each within its budget. */
  async function expectWithinBudget() {
    expect(await reminderRows()).toBeLessThanOrEqual(BUDGET.reminderPerUser);
    expect(await levelsRows()).toBeLessThanOrEqual(BUDGET.levels);
  }
  const shapes: [DirectionSetting, Progress][] = [
    ["tt_ru", "in order"], ["tt_ru", "none"], ["both", "in order"], ["both", "none"],
    ["both", "scattered"], ["both", "stragglers"], ["both", "switched"],
  ];
  for (const level of [1, 5, 20]) {
    for (const [direction, progress] of shapes) {
      it(`level ${level}, direction ${direction}, progress ${progress}: /levels and the reminder stay within the budget`, async () => {
        await hundredsLearner(await hundredsCatalog(), level, direction, progress);
        await expectWithinBudget();
      });
    }
  }

  it("level 20, direction both, progress switched, own words typed before and after the upper levels were published: the same budget", async () => {
    // The ids of the own words enclose the notes of the levels 11…20, with a thousand cards in state 'new' among them:
    // the reminder must not read those cards to learn that the own deck, finished in both directions, has nothing new.
    const lower = await hundredsCatalog(1, 10);
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now });
    const deck = await repo.customDeck(id, now);
    const early = await repo.insertNotes(deck, ownWords(1, 5));
    const upper = await hundredsCatalog(11, 20);
    const late = await repo.insertNotes(deck, ownWords(6, 10));
    expect(Math.min(...upper[11]!)).toBeGreaterThan(Math.max(...early));
    expect(Math.min(...late)).toBeGreaterThan(Math.max(...upper[20]!));
    await hundredsLearner({ ...lower, ...upper }, 20, "both", "switched", { id, own: [...early, ...late] });
    await expectWithinBudget();
  });
});

describe("D1 rows read by a tick with nobody due", () => {
  it("does not grow with the previews and the finished jobs that are kept", async () => {
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now });
    await repo.updateUser(id, { onboardingStep: null, nextDailyAt: now + DAY, nextEveningAt: now + DAY });
    const fresh = Array.from({ length: 300 }, (_, i) => env.DB.prepare("INSERT INTO previews (user_id, kind, payload, created_at) VALUES (?, 'add', '[]', ?)").bind(id, now - i * MIN));
    const done = Array.from({ length: 300 }, (_, i) => env.DB.prepare("INSERT INTO jobs (kind, payload, run_at, done_at) VALUES ('push', '{}', ?, ?)").bind(now - DAY, now - i * MIN));
    for (let i = 0; i < 300; i += 100) await env.DB.batch([...fresh.slice(i, i + 100), ...done.slice(i, i + 100)]);
    const db = readingDb(env.DB);
    await tick({ repo: new Repo(db), tg: fakeTelegram(), now });
    expect(db.rowsRead).toBeLessThanOrEqual(20);
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM previews) AS p, (SELECT COUNT(*) FROM jobs) AS j").first()).toEqual({ p: 300, j: 300 });
  });
});

describe("D1 rows read by an undo", () => {
  it("finds the last grade without reading the history: the newest row that is not undone, by time and then by id", async () => {
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now });
    const log = (cardId: number, reviewedAt: number, undone = 0) => env.DB.prepare(
      "INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, undone) VALUES (?, ?, 3, ?, 0, 0, ?, ?)",
    ).bind(cardId, id, JSON.stringify(gradedMem(now)), reviewedAt, undone);
    const history = Array.from({ length: 300 }, (_, i) => log(i + 1, now - (300 - i) * MIN));
    for (let i = 0; i < 300; i += 100) await env.DB.batch(history.slice(i, i + 100));
    // Two grades in the same millisecond, then one that was undone already.
    await env.DB.batch([log(901, now), log(902, now), log(903, now + 1, 1)]);
    const db = readingDb(env.DB);
    expect((await new Repo(db).lastReviewLog(id))!.cardId).toBe(902);
    expect(db.rowsRead).toBeLessThanOrEqual(10);
  });
});
