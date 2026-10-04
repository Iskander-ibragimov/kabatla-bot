import { type NoteInput, Repo, type User } from "../../src/db/repo";
import { LEVELS, levelBit } from "../../src/levels/scale";
import { levelSlug, nextOccurrence } from "../../src/users/service";

export const WORDS: [string, string][] = [
  ["китап", "книга"], ["вакыт", "время"], ["авыл", "деревня"], ["су", "вода"], ["юл", "дорога"], ["көн", "день"],
  ["өй", "дом"], ["эш", "работа"], ["кеше", "человек"], ["сүз", "слово"], ["яңа", "новый"], ["зур", "большой"],
];

const NCHY = new Set([6, 9, 10, 16, 19]);
/** A catalog-style note for tests: translation `<word>-ru` unless given, examples `<word>.` and `<translation>.`. */
export const note = (word: string, translation = `${word}-ru`): NoteInput => ({
  word, transcription: null, pos: "n", translation, exampleTt: `${word}.`, exampleRu: `${translation}.`, exampleSrc: "own",
});

/** Adds notes to the catalog deck of a level, creating the deck (slug l01…) when it does not exist yet. */
async function seedLevel(repo: Repo, levelNo: number, notes: NoteInput[], coveragePct: number | null): Promise<{ deckId: number; noteIds: number[] }> {
  const existing = await repo.getDeckBySlug(levelSlug(levelNo));
  const deckId = existing?.id ?? (await repo.insertDeck({
    slug: levelSlug(levelNo), kind: "catalog", titleRu: `Уровень ${levelNo}`, titleTt: `${levelNo} ${NCHY.has(levelNo) ? "нчы" : "нче"} дәрәҗә`,
    levelNo, coveragePct, ownerId: null,
  }));
  const catalog = notes.map((n, i) => ({ ...n, level: levelNo, topicNo: 0, seq: i + 1 }));
  const noteIds = await repo.insertNotes(deckId, catalog);
  await repo.db.prepare(
    "INSERT OR REPLACE INTO catalog_groups (level, topic_no, total) VALUES (?1, 0, (SELECT COUNT(*) FROM notes WHERE level = ?1 AND topic_no = 0))",
  ).bind(levelNo).run();
  return { deckId, noteIds };
}

/**
 * Catalog words in the new shape: the decks a1…c1 (level_no 1–5, created when absent), `seq` counting per level in call order
 * (continuing after notes already there), topic 0 unless given, and `catalog_groups` in step. Returns the note ids in call order.
 * Transitional: do not use seedCatalog and seedLevels for the same level number in one test; decks.level_no is unique
 * and the slugs differ (a1… against l01…).
 */
export async function seedCatalog(
  db: D1Database,
  rows: { level: number; word: string; topic?: number; pos?: string; translation?: string }[],
): Promise<number[]> {
  const repo = new Repo(db);
  const ids: number[] = [];
  for (const r of rows) {
    const lv = LEVELS.find((l) => l.no === r.level);
    if (!lv) throw new Error(`seedCatalog: no level ${r.level}`);
    const deckId = (await repo.getDeckBySlug(lv.slug))?.id ?? (await repo.insertDeck({
      slug: lv.slug, kind: "catalog", titleRu: lv.code, titleTt: lv.code, levelNo: lv.no, coveragePct: null, ownerId: null,
    }));
    const seq = ((await db.prepare("SELECT MAX(seq) AS m FROM notes WHERE level = ?").bind(r.level).first<{ m: number | null }>())?.m ?? 0) + 1;
    const topicNo = r.topic ?? 0;
    const [id] = await repo.insertNotes(deckId, [{ ...note(r.word, r.translation), pos: r.pos ?? "n", level: r.level, topicNo, seq }]);
    await db.prepare(
      "INSERT OR REPLACE INTO catalog_groups (level, topic_no, total) VALUES (?1, ?2, (SELECT COUNT(*) FROM notes WHERE level = ?1 AND topic_no = ?2))",
    ).bind(r.level, topicNo).run();
    ids.push(id!);
  }
  return ids;
}

/**
 * Creates level decks l01… with one note per word (translation = word + "-ru", exampleTt = word + ".")
 * and returns the deck ids by level number. `coverage` sets coverage_pct, also for levels that already exist.
 */
export async function seedLevels(db: D1Database, levels: Record<number, string[]>, coverage: Record<number, number> = {}): Promise<Record<number, number>> {
  const repo = new Repo(db);
  const ids: Record<number, number> = {};
  for (const [no, words] of Object.entries(levels)) {
    const levelNo = Number(no);
    ids[levelNo] = (await seedLevel(repo, levelNo, words.map((w) => note(w)), coverage[levelNo] ?? null)).deckId;
  }
  for (const [no, pct] of Object.entries(coverage)) await db.prepare("UPDATE decks SET coverage_pct = ? WHERE level_no = ?").bind(pct, Number(no)).run();
  return ids;
}

/**
 * A user who finished onboarding and is subscribed to the deck of `level` (default 1).
 * When that deck does not exist yet, it is created from the first `words` (default 5) entries of WORDS.
 */
export async function seedUser(db: D1Database, opts: { now: number; level?: number; levels?: number; words?: number; patch?: Partial<User>; tgId?: number }) {
  const repo = new Repo(db);
  const level = opts.level ?? 1;
  const existing = await repo.getDeckBySlug(levelSlug(level));
  const { deckId, noteIds } = existing
    ? { deckId: existing.id, noteIds: (await db.prepare("SELECT id FROM notes WHERE deck_id = ? ORDER BY id").bind(existing.id).all<{ id: number }>()).results.map((r) => r.id) }
    : await seedLevel(repo, level, WORDS.slice(0, opts.words ?? 5).map(([word, translation]) => note(word, translation)), null);
  const userId = await repo.insertUser({ tgId: opts.tgId ?? 1, chatId: opts.tgId ?? 1, lang: "ru", now: opts.now });
  const tz = opts.patch?.tzOffsetMin ?? 180;
  await repo.updateUser(userId, {
    onboardingStep: null, tzOffsetMin: tz, level,
    ...(level <= 5 || opts.levels != null ? { levels: opts.levels ?? levelBit(level) } : {}),
    nextDailyAt: nextOccurrence(tz, opts.patch?.remindAt ?? "09:00", opts.now), nextEveningAt: nextOccurrence(tz, "20:00", opts.now),
    ...(opts.patch ?? {}),
  });
  await repo.subscribe(userId, deckId, opts.now);
  const user = (await repo.getUser(userId))!;
  return { repo, user, deckId, noteIds };
}

/**
 * A user who finished onboarding, with no deck and no subscription: the learner of the new model, whose new catalog
 * words come from the checked levels (`users.levels`, A1 by default) and not from subscribed level decks.
 */
export async function seedLearner(db: D1Database, opts: { now: number; tgId?: number; patch?: Partial<User> }): Promise<{ repo: Repo; user: User }> {
  const repo = new Repo(db);
  const userId = await repo.insertUser({ tgId: opts.tgId ?? 1, chatId: opts.tgId ?? 1, lang: "ru", now: opts.now });
  const tz = opts.patch?.tzOffsetMin ?? 180;
  await repo.updateUser(userId, {
    onboardingStep: null, tzOffsetMin: tz,
    nextDailyAt: nextOccurrence(tz, opts.patch?.remindAt ?? "09:00", opts.now), nextEveningAt: nextOccurrence(tz, "20:00", opts.now),
    ...(opts.patch ?? {}),
  });
  return { repo, user: (await repo.getUser(userId))! };
}
