import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Direction, type DirectionSetting, Repo } from "../../src/db/repo";
import { tick } from "../../src/reminders/service";
import { harness } from "../helpers/botHarness";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { readingDb } from "../helpers/readingDb";
import { gradedMem } from "../helpers/review";
import { note, seedLevels } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3; the reminder of the learner below is due at 09:00. */
const now = Date.UTC(2026, 8, 30, 7, 0);
const LEVELS = 20;
const PER_LEVEL = 100;

/** The whole catalog: 20 levels of 100 words. Returns the note ids by level number, in the order of the level. */
async function fullCatalog(): Promise<Record<number, number[]>> {
  const levels: Record<number, string[]> = {};
  for (let l = 1; l <= LEVELS; l++) levels[l] = Array.from({ length: PER_LEVEL }, (_, i) => `сүз${l}х${i + 1}`);
  const decks = await seedLevels(env.DB, levels, Object.fromEntries(Array.from({ length: LEVELS }, (_, i) => [i + 1, 30 + 3 * i])));
  const ids: Record<number, number[]> = {};
  for (let l = 1; l <= LEVELS; l++) {
    ids[l] = (await env.DB.prepare("SELECT id FROM notes WHERE deck_id = ? ORDER BY id").bind(decks[l]).all<{ id: number }>()).results.map((r) => r.id);
  }
  expect(Object.values(ids).flat()).toHaveLength(LEVELS * PER_LEVEL);
  return ids;
}

const directionsOf = (d: DirectionSetting): Direction[] => (d === "both" ? ["tt_ru", "ru_tt"] : [d]);

/**
 * A learner (Telegram id 42) on level `level` with the levels 1…`level` open, ten own words, and a reminder that is due.
 * `progress: "in order"` — the levels below are finished, half of the current one and half of the own words are started,
 * twenty of the started cards are due today. `progress: "none"` — the levels were opened and nothing was started.
 */
async function learner(catalog: Record<number, number[]>, level: number, direction: DirectionSetting, progress: "in order" | "none") {
  const repo = new Repo(env.DB);
  const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now });
  await repo.updateUser(id, { onboardingStep: null, tzOffsetMin: 180, level, direction, newPerDay: 20, nextDailyAt: now - 60 * MIN, nextEveningAt: now + 9 * 60 * MIN });
  await env.DB.prepare("INSERT INTO user_decks (user_id, deck_id, added_at) SELECT ?1, id, ?2 FROM decks WHERE level_no <= ?3").bind(id, now, level).run();
  const own = await repo.insertNotes(await repo.customDeck(id, now), Array.from({ length: 10 }, (_, i) => note(`үзем${i + 1}`)));
  if (progress === "in order") {
    const started = [...own.slice(0, 5), ...Array.from({ length: level - 1 }, (_, i) => catalog[i + 1]!).flat(), ...catalog[level]!.slice(0, PER_LEVEL / 2)];
    const cards = started.flatMap((noteId, i) => directionsOf(direction).map((d) =>
      repo.insertCardStmt(id, noteId, d, { ...gradedMem(now - DAY), ...(i < 20 ? { due: now - MIN } : {}) })));
    for (let i = 0; i < cards.length; i += 100) await repo.batch(cards.slice(i, i + 100));
  }
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
  for (const level of [1, 5, 20]) {
    for (const direction of ["tt_ru", "both"] as const) {
      for (const progress of ["in order", "none"] as const) {
        it(`level ${level}, direction ${direction}, progress ${progress}: a grade, /levels and the reminder stay within the budget`, async () => {
          const catalog = await fullCatalog();
          await learner(catalog, level, direction, progress);
          const reminder = await reminderRows();
          const levels = await levelsRows();
          const grades = await gradeRows(6);
          expect(Math.max(...grades)).toBeLessThanOrEqual(BUDGET.grade);
          expect(levels).toBeLessThanOrEqual(BUDGET.levels);
          expect(reminder).toBeLessThanOrEqual(BUDGET.reminderPerUser);
        });
      }
    }
  }
});
