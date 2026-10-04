import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Direction, type DirectionSetting, Repo } from "../../src/db/repo";
import { mergeStreams } from "../../src/levels/order";
import { ALL_LEVELS, type NewMode, hasLevel, levelBit } from "../../src/levels/scale";
import { hub, setTopic, toggleLevel, togglePos, topicLines } from "../../src/levels/service";
import { tick } from "../../src/reminders/service";
import { newMem } from "../../src/srs/fsrs";
import { harness } from "../helpers/botHarness";
import { type CardSeed, type CatalogNote, bulkCards, bulkCatalog, numeralsAt } from "../helpers/catalog";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { readingDb } from "../helpers/readingDb";
import { gradedMem } from "../helpers/review";
import { note, recountProgress, seedLearner, seedTopics } from "../helpers/seed";

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
  /** `guided` only: the topic the learner has chosen. Every word of it but the last is started, besides what `where` says. */
  chosenTopic?: number;
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
  const topicNo = c.chosenTopic !== undefined ? c.chosenTopic
    : c.mode !== "topic" ? null
    : c.where === "start" ? 5
      : c.where === "middle" ? themed.find((n) => !half.includes(n))!.topicNo
        : themed[themed.length - 1]!.topicNo;
  const left = new Set(order.filter((n) => inPos(n) && (topicNo === null || n.topicNo === topicNo)).slice(-2).map((n) => n.id));
  const byWhere = c.where === "start" ? [] : c.where === "middle" ? half : c.where === "run" ? order.slice(1, -1) : scope.filter((n) => !left.has(n.id));
  const ofChosenTopic = c.chosenTopic === undefined ? [] : order.filter((n) => n.topicNo === c.chosenTopic).slice(0, -1);
  const started = [...byWhere, ...ofChosenTopic.filter((n) => !byWhere.includes(n))];

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
  await recountProgress(env.DB, user.id);
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
    it(`all five levels, all parts of speech, guided with a chosen topic, middle, ${direction}: the grade that finishes the topic reads the queue once more with no position stored, a first read; so is the grade after it, which stores the positions; the grades after that are within the grade budget`, async () => {
      // Half of the catalog is started in the guided order (the topics up to the tenth); the learner chose topic 15, and its last word is left.
      const { repo, userId } = await learner(await fullCatalog(), { levels: "all", pos: "all", mode: "guided", where: "middle", direction, chosenTopic: 15 });
      const bot = atTheBot();
      expect(await bot.learn()).toBeLessThanOrEqual(BUDGET.first);
      // The reviews due today, the cards that wait and the last word of the topic are graded; the grade after which the topic is cleared is the last of these.
      const rows: number[] = [];
      while ((await repo.getUser(userId))!.topicNo !== null && rows.length < 80) {
        expect(bot.h.lastText()).toContain("🔵");
        rows.push((await bot.grade(4))!);
      }
      expect((await repo.getUser(userId))!).toMatchObject({ topicNo: null, newCursors: null });
      // Class `first`: the second read of that grade is for the order without a topic, for which no position is stored: it walks over the started half.
      const clearing = rows.pop()!;
      expect(clearing).toBeLessThanOrEqual(BUDGET.first);
      expect(clearing).toBeGreaterThan(1925);
      expect(Math.max(...rows)).toBeLessThanOrEqual(BUDGET.grade);
      // Class `first` once more: the topic was cleared in the batch of that read, and the positions are stored by the next one.
      expect(await bot.grade(4)).toBeLessThanOrEqual(BUDGET.first);
      expect((await repo.getUser(userId))!.newCursors).not.toBeNull();
      // Class `grade` from here on.
      const plain = await grades(bot, 4);
      expect(plain).toHaveLength(4);
      expect(Math.max(...plain)).toBeLessThanOrEqual(BUDGET.grade);
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

describe("D1 rows read by /levels and by the reminder of one due learner with the whole catalog (3 850 notes) loaded", () => {
  /** The reminder and /levels of the learner in the database, whose reminder is due: each within its budget. */
  async function expectWithinBudget() {
    expect(await reminderRows()).toBeLessThanOrEqual(BUDGET.reminderPerUser);
    expect(await levelsRows()).toBeLessThanOrEqual(BUDGET.levels);
  }
  const cases: Case[] = [];
  for (const where of ["start", "middle", "end"] as const) {
    for (const direction of ["tt_ru", "both"] as const) cases.push({ levels: "all", pos: "all", mode: "guided", where, direction });
  }
  // The settings that narrow the new words do not change what these two read.
  cases.push({ levels: "all", pos: "num", mode: "topic", where: "middle", direction: "both" });
  cases.push({ levels: "all", pos: "all", mode: "freq", where: "run", direction: "tt_ru" });
  cases.push({ levels: "A2", pos: "all", mode: "guided", where: "middle", direction: "both" });
  for (const c of cases) {
    it(`${title(c)}: the reminder and /levels stay within the budget`, async () => {
      await seedTopics(env.DB);
      await learner(await fullCatalog(), c);
      await expectWithinBudget();
    });
  }

  it("all five levels, guided, middle, both: what «Темы» reads and what a tap on a checkbox or on a topic reads is within the budget of a settings screen", async () => {
    await seedTopics(env.DB);
    const { userId } = await learner(await fullCatalog(), { levels: "all", pos: "all", mode: "guided", where: "middle", direction: "both" });
    const db = readingDb(env.DB);
    const repo = new Repo(db);
    const user = (await repo.getUser(userId))!;
    const rowsOf = async (run: () => Promise<unknown>) => { db.rowsRead = 0; await run(); return db.rowsRead; };
    expect(await rowsOf(() => hub(repo, user))).toBeLessThanOrEqual(BUDGET.levels);
    expect(await rowsOf(async () => expect((await topicLines(repo, user)).length).toBe(21))).toBeLessThanOrEqual(BUDGET.levels);
    expect(await rowsOf(async () => expect(await toggleLevel(repo, user, 3)).toBe("ok"))).toBeLessThanOrEqual(BUDGET.levels);
    expect(await rowsOf(async () => expect(await togglePos(repo, user, 5)).toBe("ok"))).toBeLessThanOrEqual(BUDGET.levels);
    expect(await rowsOf(async () => expect(await setTopic(repo, user, 7)).toBe("ok"))).toBeLessThanOrEqual(BUDGET.levels);
  });

  it("all five levels, guided, middle, both: every screen of /levels and of the settings at the bot, and every tap on one, is within the budget of a settings screen", async () => {
    await seedTopics(env.DB);
    await learner(await fullCatalog(), { levels: "all", pos: "all", mode: "guided", where: "middle", direction: "both" });
    const db = readingDb(env.DB);
    const h = harness(db, { now });
    const rows: [string, number][] = [];
    const run = async (name: string, update: () => Promise<unknown>) => { db.rowsRead = 0; await update(); rows.push([name, db.rowsRead]); };
    await run("/levels", () => h.text("/levels"));
    for (const data of ["hub:lv", "lv:t:3", "lv:t:3", "hub:pos", "ps:t:5", "ps:t:5", "hub:mode", "md:topic", "md:guided", "hub:tp", "tp:7", "tp:none", "hub"]) await run(data, () => h.press(data));
    await run("/settings", () => h.text("/settings"));
    for (const data of ["set:tz", "tz:300", "set:tz", "set:back", "set:hub"]) await run(data, () => h.press(data, h.tg.lastMessageId()));
    expect(h.tg.of("answerCallbackQuery").map((c) => c.payload.text).filter(Boolean)).toEqual([]);
    for (const [name, read] of rows) expect(read, name).toBeLessThanOrEqual(BUDGET.levels);
  });

  it.each(["tt_ru", "both"] as const)("A2 alone, numerals only, guided, middle, %s: a button of the done screen that widens the settings changes them and reads the queue for the first time under them", async (direction) => {
    await seedTopics(env.DB);
    const { repo, userId } = await learner(await fullCatalog(), { levels: "A2", pos: "num", mode: "guided", where: "middle", direction });
    const db = readingDb(env.DB);
    const h = harness(db, { now });
    const rowsOf = async (data: string) => { db.rowsRead = 0; await h.press(data); return db.rowsRead; };
    expect(await rowsOf("fix:pos")).toBeLessThanOrEqual(BUDGET.first);
    expect(await rowsOf("fix:lv:1")).toBeLessThanOrEqual(BUDGET.first);
    expect(await repo.getUser(userId)).toMatchObject({ posGroups: 255, levels: 0b11 });
    expect(h.tg.of("sendMessage")).toHaveLength(2);
  });

  it("all five levels, a learner who went over to both directions with half the catalog started, own words typed before and after the catalog was loaded: the same budget", async () => {
    // The ids of the own words enclose the notes of the catalog, and a reverse card waits in state 'new' for every
    // started word, 1 925 of them: neither the reminder nor /levels may read those cards.
    await seedTopics(env.DB);
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now });
    const deck = await repo.customDeck(id, now);
    const early = await repo.insertNotes(deck, Array.from({ length: 5 }, (_, i) => note(`үзем${i + 1}`)));
    const catalog = await fullCatalog();
    const late = await repo.insertNotes(deck, Array.from({ length: 5 }, (_, i) => note(`үзем${i + 6}`)));
    expect(Math.min(...catalog.map((n) => n.id))).toBeGreaterThan(Math.max(...early));
    expect(Math.min(...late)).toBeGreaterThan(Math.max(...catalog.map((n) => n.id)));
    await repo.updateUser(id, { onboardingStep: null, tzOffsetMin: 180, direction: "both", newPerDay: 20, levels: ALL_LEVELS, nextDailyAt: now - 60 * MIN, nextEveningAt: now + 9 * 60 * MIN });
    const yesterday = gradedMem(now - DAY);
    const cards: CardSeed[] = [...early, ...late].flatMap((n) => BOTH.map((d): CardSeed => [n, d, yesterday, null]));
    mergeStreams([catalog], "guided").slice(0, catalog.length / 2).forEach((n, i) => {
      cards.push([n.id, "tt_ru", i < 20 ? { ...yesterday, due: now - MIN } : yesterday, null]);
      cards.push([n.id, "ru_tt", newMem(now - 2 * DAY), "2026-09-28"]);
    });
    await bulkCards(env.DB, id, cards);
    await recountProgress(env.DB, id);
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
