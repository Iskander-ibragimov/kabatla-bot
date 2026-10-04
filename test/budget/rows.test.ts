import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Direction, type DirectionSetting, Repo } from "../../src/db/repo";
import { tick } from "../../src/reminders/service";
import { harness } from "../helpers/botHarness";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { readingDb } from "../helpers/readingDb";
import { gradedMem } from "../helpers/review";
import { newMem } from "../../src/srs/fsrs";
import { note, seedLevels } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3; the reminder of the learner below is due at 09:00. */
const now = Date.UTC(2026, 8, 30, 7, 0);
const LEVELS = 20;
const PER_LEVEL = 100;

/** The catalog, 100 words a level: all 20 levels, or the levels `from`…`to`. Returns the note ids by level number, in the order of the level. */
async function fullCatalog(from = 1, to = LEVELS): Promise<Record<number, number[]>> {
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

const BOTH: Direction[] = ["tt_ru", "ru_tt"];
const directionsOf = (d: DirectionSetting): Direction[] => (d === "both" ? BOTH : [d]);

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
async function learner(catalog: Record<number, number[]>, level: number, direction: DirectionSetting, progress: Progress, existing?: { id: number; own: number[] }) {
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

const gradeButton = (h: ReturnType<typeof harness>, rating: 1 | 2 | 3 | 4): string =>
  (h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.callback_data).find((c) => new RegExp(`^g:\\d+:\\d+:${rating}$`).test(c))!;

/** The rows read by each of `n` grades in a row, each answered with the next card. */
async function gradeRows(n: number): Promise<number[]> {
  const db = readingDb(env.DB);
  const h = harness(db, { now });
  await h.text("/learn");
  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    db.rowsRead = 0;
    await h.press(gradeButton(h, i % 2 ? 4 : 3), h.tg.lastMessageId());
    expect(h.lastText()).toContain("🔵");
    rows.push(db.rowsRead);
  }
  return rows;
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

/** Ruling F4: the most rows one update or one reminder may read, with all 2 000 catalog notes loaded. */
const BUDGET = { grade: 2500, levels: 2500, reminderPerUser: 300 } as const;

describe("D1 rows read with the whole catalog loaded (ruling F4)", () => {
  /** The six grades, /levels and the reminder of the learner in the database: each within its budget. */
  async function expectWithinBudget() {
    const reminder = await reminderRows();
    const levels = await levelsRows();
    const grades = await gradeRows(6);
    expect(Math.max(...grades)).toBeLessThanOrEqual(BUDGET.grade);
    expect(levels).toBeLessThanOrEqual(BUDGET.levels);
    expect(reminder).toBeLessThanOrEqual(BUDGET.reminderPerUser);
  }
  const shapes: [DirectionSetting, Progress][] = [
    ["tt_ru", "in order"], ["tt_ru", "none"], ["both", "in order"], ["both", "none"],
    ["both", "scattered"], ["both", "stragglers"], ["both", "switched"],
  ];
  for (const level of [1, 5, 20]) {
    for (const [direction, progress] of shapes) {
      it(`level ${level}, direction ${direction}, progress ${progress}: a grade, /levels and the reminder stay within the budget`, async () => {
        const catalog = await fullCatalog();
        const id = await learner(catalog, level, direction, progress);
        await expectWithinBudget();
        if (progress !== "stragglers") return;
        // The budget is met by giving the cards that wait, not by passing them over: new cards were graded, and they
        // can only be those thirteen — no word of the open levels is untouched, and no further level was opened.
        const asked = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log WHERE user_id = ? AND was_new = 1").bind(id).first<{ n: number }>();
        expect(asked!.n).toBeGreaterThanOrEqual(2);
        expect((await env.DB.prepare("SELECT level FROM users WHERE id = ?").bind(id).first<{ level: number }>())!.level).toBe(level);
      });
    }
  }

  it("level 20, direction both, progress switched, own words typed before and after the upper levels were published: the same budget", async () => {
    // The ids of the own words enclose the notes of the levels 11…20, with a thousand cards in state 'new' among them:
    // the queue must not read those cards to learn that the own deck, finished in both directions, has nothing new.
    const lower = await fullCatalog(1, 10);
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now });
    const deck = await repo.customDeck(id, now);
    const early = await repo.insertNotes(deck, ownWords(1, 5));
    const upper = await fullCatalog(11, 20);
    const late = await repo.insertNotes(deck, ownWords(6, 10));
    expect(Math.min(...upper[11]!)).toBeGreaterThan(Math.max(...early));
    expect(Math.min(...late)).toBeGreaterThan(Math.max(...upper[20]!));
    await learner({ ...lower, ...upper }, 20, "both", "switched", { id, own: [...early, ...late] });
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
