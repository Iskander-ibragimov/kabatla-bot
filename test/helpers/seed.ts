import { type NoteInput, Repo, type User } from "../../src/db/repo";
import { guidedTseq } from "../../src/levels/order";
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

/** Every hint and the update notice are seen: the cards of such a learner carry no first lines. */
const HINTS_ALL_SEEN = 127;

/**
 * A user who finished onboarding and is subscribed to the deck of `level` (default 1).
 * When that deck does not exist yet, it is created from the first `words` (default 5) entries of WORDS.
 * The hints are seen (`hintsSeen` 127) unless the patch says otherwise.
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
    onboardingStep: null, tzOffsetMin: tz, level, hintsSeen: HINTS_ALL_SEEN,
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
 * words come from the checked levels (`users.levels`, A1 by default) and not from subscribed level decks. The hints are
 * seen (`hintsSeen` 127) unless the patch says otherwise: 64 is a learner fresh from the introduction, 63 one who
 * knew the bot before the levels A1–C1.
 */
export async function seedLearner(db: D1Database, opts: { now: number; tgId?: number; patch?: Partial<User> }): Promise<{ repo: Repo; user: User }> {
  const repo = new Repo(db);
  const userId = await repo.insertUser({ tgId: opts.tgId ?? 1, chatId: opts.tgId ?? 1, lang: "ru", now: opts.now });
  const tz = opts.patch?.tzOffsetMin ?? 180;
  await repo.updateUser(userId, {
    onboardingStep: null, tzOffsetMin: tz, hintsSeen: HINTS_ALL_SEEN,
    nextDailyAt: nextOccurrence(tz, opts.patch?.remindAt ?? "09:00", opts.now), nextEveningAt: nextOccurrence(tz, "20:00", opts.now),
    ...(opts.patch ?? {}),
  });
  return { repo, user: (await repo.getUser(userId))! };
}

/**
 * Gives every catalog note the place in the guided order that the catalog seed gives it (levels/order.ts `guidedTseq`):
 * themed and basic words in turn. `seedCatalog` and `seedLevels` write the simple `topic × 1 000 000 + seq` instead.
 */
export async function seedGuidedOrder(db: D1Database): Promise<void> {
  const { results } = await db.prepare("SELECT id, level, topic_no AS topicNo, seq FROM notes WHERE level IS NOT NULL ORDER BY level, seq")
    .all<{ id: number; level: number; topicNo: number; seq: number }>();
  for (const level of new Set(results.map((n) => n.level))) {
    const rows = results.filter((n) => n.level === level);
    const tseq = guidedTseq(rows);
    await db.batch(rows.map((n, i) => db.prepare("UPDATE notes SET tseq = ? WHERE id = ?").bind(tseq[i]!, n.id)));
  }
}

/** The topics of the catalog, as the catalog seed loads them into `topics` (design spec §3.2). */
export const TOPICS: { no: number; slug: string; titleRu: string; titleTt: string }[] = [
  { no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" },
  { no: 1, slug: "greet", titleRu: "Знакомство и вежливость", titleTt: "Танышу һәм әдәп" },
  { no: 2, slug: "family", titleRu: "Семья и близкие", titleTt: "Гаилә һәм якыннар" },
  { no: 3, slug: "person", titleRu: "Человек: характер и чувства", titleTt: "Кеше: холык һәм хисләр" },
  { no: 4, slug: "home", titleRu: "Дом и быт", titleTt: "Йорт һәм көнкүреш" },
  { no: 5, slug: "time", titleRu: "Время и календарь", titleTt: "Вакыт һәм календарь" },
  { no: 6, slug: "numbers", titleRu: "Числа и количество", titleTt: "Саннар һәм микъдар" },
  { no: 7, slug: "nature", titleRu: "Природа и погода", titleTt: "Табигать һәм һава торышы" },
  { no: 8, slug: "food", titleRu: "Еда", titleTt: "Ризык" },
  { no: 9, slug: "shop", titleRu: "Покупки и одежда", titleTt: "Сәүдә һәм кием" },
  { no: 10, slug: "city", titleRu: "Город и транспорт", titleTt: "Шәһәр һәм транспорт" },
  { no: 11, slug: "study", titleRu: "Учёба и наука", titleTt: "Уку һәм фән" },
  { no: 12, slug: "work", titleRu: "Работа и профессии", titleTt: "Эш һәм һөнәрләр" },
  { no: 13, slug: "leisure", titleRu: "Досуг и увлечения", titleTt: "Ял һәм мавыгулар" },
  { no: 14, slug: "health", titleRu: "Здоровье и спорт", titleTt: "Сәламәтлек һәм спорт" },
  { no: 15, slug: "travel", titleRu: "Путешествия", titleTt: "Сәяхәт" },
  { no: 16, slug: "culture", titleRu: "Культура и искусство", titleTt: "Мәдәният һәм сәнгать" },
  { no: 17, slug: "tatar", titleRu: "Татарстан и традиции", titleTt: "Татарстан һәм гореф-гадәтләр" },
  { no: 18, slug: "society", titleRu: "Общество и история", titleTt: "Җәмгыять һәм тарих" },
  { no: 19, slug: "language", titleRu: "Язык и общение", titleTt: "Тел һәм аралашу" },
  { no: 20, slug: "media", titleRu: "Медиа и технологии", titleTt: "Медиа һәм технологияләр" },
];

/** Fills `topics` with the 21 topics of the catalog; the helpers that write catalog notes leave that table empty. */
export async function seedTopics(db: D1Database): Promise<void> {
  await db.prepare("INSERT INTO topics (no, slug, title_ru, title_tt) SELECT j.value ->> 'no', j.value ->> 'slug', j.value ->> 'titleRu', j.value ->> 'titleTt' FROM json_each(?) j")
    .bind(JSON.stringify(TOPICS)).run();
}

/**
 * Sets the user's counters of started words (`user_progress`) to what the catalog seed counts for that user: a
 * note with a card outside state 'new', and a catalog note whose word the user owns a note of, each note once, by
 * level and topic; own words are the pair (0, 0). For fixtures that write cards straight into the table; a grade
 * and an added own word keep the counters themselves.
 */
export async function recountProgress(db: D1Database, userId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM user_progress WHERE user_id = ?").bind(userId),
    db.prepare(
      `INSERT INTO user_progress (user_id, level, topic_no, started)
       SELECT ?1, s.level, s.topic_no, COUNT(*) FROM (
         SELECT COALESCE(n.level, 0) AS level, COALESCE(n.topic_no, 0) AS topic_no, n.id FROM cards c JOIN notes n ON n.id = c.note_id
         WHERE c.user_id = ?1 AND c.state <> 'new'
         UNION
         SELECT n.level, COALESCE(n.topic_no, 0), n.id FROM decks d JOIN notes o ON o.deck_id = d.id JOIN notes n ON n.word_key = o.word_key AND n.level IS NOT NULL
         WHERE d.owner_id = ?1) s
       GROUP BY s.level, s.topic_no`,
    ).bind(userId),
  ]);
}
