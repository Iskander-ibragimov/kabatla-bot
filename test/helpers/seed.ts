import { type NoteInput, Repo, type User } from "../../src/db/repo";
import { nextOccurrence } from "../../src/users/service";

export const WORDS: [string, string][] = [
  ["китап", "книга"], ["вакыт", "время"], ["авыл", "деревня"], ["су", "вода"], ["юл", "дорога"], ["көн", "день"],
  ["өй", "дом"], ["эш", "работа"], ["кеше", "человек"], ["сүз", "слово"], ["яңа", "новый"], ["зур", "большой"],
];

const levelSlug = (n: number) => `l${String(n).padStart(2, "0")}`;
const NCHY = new Set([6, 9, 10, 16, 19]);
const note = (word: string, translation: string): NoteInput => ({
  word, transcription: null, pos: "n", translation, exampleTt: `${word}.`, exampleRu: `${translation}.`, exampleSrc: "own",
});

/** Adds notes to the catalog deck of a level, creating the deck (slug l01…) when it does not exist yet. */
async function seedLevel(repo: Repo, levelNo: number, notes: NoteInput[], coveragePct: number | null): Promise<{ deckId: number; noteIds: number[] }> {
  const existing = await repo.getDeckBySlug(levelSlug(levelNo));
  const deckId = existing?.id ?? (await repo.insertDeck({
    slug: levelSlug(levelNo), kind: "catalog", titleRu: `Уровень ${levelNo}`, titleTt: `${levelNo} ${NCHY.has(levelNo) ? "нчы" : "нче"} дәрәҗә`,
    levelNo, coveragePct, ownerId: null,
  }));
  return { deckId, noteIds: await repo.insertNotes(deckId, notes) };
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
    ids[levelNo] = (await seedLevel(repo, levelNo, words.map((w) => note(w, `${w}-ru`)), coverage[levelNo] ?? null)).deckId;
  }
  for (const [no, pct] of Object.entries(coverage)) await db.prepare("UPDATE decks SET coverage_pct = ? WHERE level_no = ?").bind(pct, Number(no)).run();
  return ids;
}

/**
 * A user who finished onboarding and is subscribed to the deck of `level` (default 1).
 * When that deck does not exist yet, it is created from the first `words` (default 5) entries of WORDS.
 */
export async function seedUser(db: D1Database, opts: { now: number; level?: number; words?: number; patch?: Partial<User>; tgId?: number }) {
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
    nextDailyAt: nextOccurrence(tz, opts.patch?.remindAt ?? "09:00", opts.now), nextEveningAt: nextOccurrence(tz, "20:00", opts.now),
    ...(opts.patch ?? {}),
  });
  await repo.subscribe(userId, deckId, opts.now);
  const user = (await repo.getUser(userId))!;
  return { repo, user, deckId, noteIds };
}
