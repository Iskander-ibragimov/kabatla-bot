import type { CardState, Mem } from "../srs/fsrs";

export type Lang = "ru" | "tt";
export type Direction = "tt_ru" | "ru_tt";
export type DirectionSetting = Direction | "both";

export interface User {
  id: number;
  tgId: number;
  chatId: number;
  lang: Lang;
  tzOffsetMin: number;
  remindAt: string;
  newPerDay: number;
  retention: number;
  direction: DirectionSetting;
  autoplay: boolean;
  /** Current level, 1…20; 21 means every level is done. */
  level: number;
  streak: number;
  lastStudyDay: string | null;
  active: boolean;
  onboardingStep: string | null;
  onboardingData: string | null;
  gensDay: string | null;
  gensCount: number;
  pendingUrl: string | null;
  pendingUrlAt: number | null;
  pendingEdit: string | null;
  lastDailyPushDay: string | null;
  lastEveningPushDay: string | null;
  lastStepPingAt: number | null;
  lastReviewAt: number | null;
  mixCounter: number;
  createdAt: number;
  nextDailyAt: number | null;
  nextEveningAt: number | null;
}

export interface NoteFields {
  word: string;
  transcription: string | null;
  pos: string;
  translation: string;
  exampleTt: string;
  exampleRu: string;
  exampleSrc: string;
  audioFileId: string | null;
  sourceUrl: string | null;
}
export type NoteInput = Pick<NoteFields, "word" | "transcription" | "pos" | "translation" | "exampleTt" | "exampleRu"> &
  Partial<Pick<NoteFields, "exampleSrc" | "audioFileId" | "sourceUrl">>;
export interface NoteRow extends NoteFields { id: number; deckId: number }
/** A note of a deck the user is subscribed to, with the titles of that deck; `owned`: the deck is the user's own, not a level. */
export interface UserNote extends NoteRow { deckTitleRu: string; deckTitleTt: string; owned: boolean }
export interface CardRow extends NoteFields { id: number; noteId: number; direction: Direction; mem: Mem; buriedDay: string | null }
export interface NewNote extends NoteFields { noteId: number; direction: Direction }
/** `newAvailable`: how many new cards the queue found, as many as `newNotes` holds: zero means the open decks have none for today. */
export interface QueueCounts { learning: number; review: number; newAvailable: number; newDoneToday: number; easyNewToday: number }
export interface Candidates { learning: CardRow[]; review: CardRow[]; newNotes: NewNote[]; counts: QueueCounts }
/** One level of the catalog as a user sees it; `seen` counts the notes that were started or are skipped as copies of own words, in an open level; 0 for a closed one. */
export interface LevelRow { levelNo: number; total: number; coveragePct: number | null; open: boolean; seen: number }
export interface DayWindow { dayStartMs: number; dayEndMs: number; today: string; directions: Direction[]; limitEach?: number }
export interface Session { userId: number; chatId: number; messageId: number | null; cardId: number | null; stale: boolean; lastVoiceMessageId: number | null }
export interface DeckRow {
  id: number; slug: string | null; ownerId: number | null; kind: "catalog" | "ai" | "custom";
  titleRu: string; titleTt: string; levelNo: number | null; coveragePct: number | null; total: number;
}
export interface ReviewLogRow {
  id: number; cardId: number; userId: number; rating: number; stateBefore: Mem; intervalBeforeDays: number; intervalAfterMs: number;
  reviewedAt: number; wasNew: boolean; learnedNow: boolean; streakBefore: number; lastStudyDayBefore: string | null; undone: boolean;
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const BOOL_USER = new Set(["autoplay", "active"]);

function rowToUser(r: Record<string, unknown>): User {
  const u: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) u[camel(k)] = BOOL_USER.has(camel(k)) ? v === 1 : v;
  return u as unknown as User;
}

/**
 * The columns of a note `n` as `viewer` may read them. `viewer` is an SQL expression for the id of the user the row is read for
 * (a bind marker or a column), or null when the row is read for nobody in particular.
 * The link of a note is read only when the note's deck is owned by the viewer: a link belongs to the learner who typed it,
 * and whatever stands in `source_url` of a level note, which every learner sees, is read as NULL.
 */
const noteCols = (viewer: string | null, owner = "(SELECT owner_id FROM decks WHERE id = n.deck_id)") =>
  "n.word, n.transcription, n.pos, n.translation, n.example_tt, n.example_ru, n.example_src, n.audio_file_id, " +
  (viewer === null ? "NULL" : `CASE WHEN ${owner} = ${viewer} THEN n.source_url END`) + " AS source_url";
/** True for a word of a level (`note` in the catalog deck `deck`) when the user owns a note with the same word_key: such a level word counts as shown. */
const ownedCopy = (user: string, deck = "dk", note = "n") =>
  `(${deck}.kind = 'catalog' AND EXISTS (SELECT 1 FROM notes o JOIN decks od ON od.id = o.deck_id WHERE od.owner_id = ${user} AND o.word_key = ${note}.word_key))`;
/** A card of the note was started: it is in any state but 'new'. */
const started = (user: string, noteId: string) => `EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ${user} AND c.note_id = ${noteId} AND c.state != 'new')`;
/** 1 when a card of this direction was started, over the cards `c` of one note. */
const startedIn = (direction: Direction) => `COALESCE(MAX(c.direction = '${direction}' AND c.state != 'new'), 0)`;
/**
 * The directions a user asks for, as SQL: `tt` and `ru` are expressions that give 1 when the user learns tt_ru and
 * ru_tt cards, else 0; `today` is the user's local day, the day a buried card stays hidden.
 */
export interface Asked { today: string; tt: string; ru: string }
/**
 * A scalar subquery: 1 when the note has a new card for the user today — none of its cards is buried today, and a
 * direction the user asks for has no started card.
 */
const hasNewCard = (user: string, noteId: string, a: Asked) =>
  `(SELECT COALESCE(MAX(c.buried_day IS ${a.today}), 0) = 0 AND (${startedIn("tt_ru")} < ${a.tt} OR ${startedIn("ru_tt")} < ${a.ru})
    FROM cards c WHERE c.user_id = ${user} AND c.note_id = ${noteId})`;
/** A one-row table `(id)`: the last (`DESC`) or the first (`ASC`) note of the deck that is not a level word the user owns a copy of; no row when there is none. */
const edgeNote = (user: string, deck: string, order: "ASC" | "DESC") =>
  `(SELECT x.id FROM notes x WHERE x.deck_id = ${deck}.id AND NOT ${ownedCopy(user, deck, "x")} ORDER BY x.id ${order} LIMIT 1)`;
/**
 * True while the deck has a new card for the user today, learnt from one note instead of the whole deck.
 * New words are given in the order of their ids, deck by deck (see `Repo.candidateCards`), so the notes a user has
 * started are the beginning of each deck: a deck whose last note has nothing new has nothing new at all.
 * Read through the index idx_notes_deck.
 */
export const deckHasNew = (user: string, deck: string, a: Asked) =>
  `EXISTS (SELECT 1 FROM ${edgeNote(user, deck, "DESC")} l WHERE ${hasNewCard(user, "l.id", a)})`;
/**
 * How many of the last `limit` notes of the deck have a new card for the user today. For a deck whose started notes
 * are its beginning this is the number of its new words, counted up to `limit`. An estimate for the reminder: a level
 * word the user owns a copy of is counted too, while `deckHasNew` makes sure the deck has at least one new word.
 */
export const newInTail = (user: string, deck: string, a: Asked, limit: number) =>
  `(SELECT COUNT(*) FROM (SELECT x.id FROM notes x WHERE x.deck_id = ${deck}.id ORDER BY x.id DESC LIMIT ${Math.trunc(limit)}) t WHERE ${hasNewCard(user, "t.id", a)})`;
/** Subscribes user ?1 to the deck of the level the user is on now, at time ?2; nothing when the catalog has no such deck. */
const OPEN_CURRENT_LEVEL =
  "INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at) SELECT u.id, d.id, ?2 FROM users u JOIN decks d ON d.level_no = u.level WHERE u.id = ?1";
/** A card `c` with its note `n`; the viewer of the note is the user the card belongs to. */
const CARD_COLS = `c.id, c.note_id, c.direction, c.state, c.step, c.stability, c.difficulty, c.due, c.last_review, c.scheduled_days, c.reps, c.lapses, c.buried_day, ${noteCols("c.user_id")}`;

function noteFields(r: Record<string, unknown>): NoteFields {
  return {
    word: r.word as string, transcription: (r.transcription as string) ?? null, pos: (r.pos as string) ?? "", translation: r.translation as string,
    exampleTt: (r.example_tt as string) ?? "", exampleRu: (r.example_ru as string) ?? "", exampleSrc: (r.example_src as string) ?? "",
    audioFileId: (r.audio_file_id as string) ?? null, sourceUrl: (r.source_url as string) ?? null,
  };
}
function rowToCard(r: Record<string, unknown>): CardRow {
  return {
    ...noteFields(r),
    id: r.id as number, noteId: r.note_id as number, direction: r.direction as Direction, buriedDay: (r.buried_day as string) ?? null,
    mem: {
      state: r.state as CardState, step: (r.step as number) ?? null, stability: (r.stability as number) ?? null,
      difficulty: (r.difficulty as number) ?? null, due: r.due as number, lastReview: (r.last_review as number) ?? null,
      scheduledDays: r.scheduled_days as number, reps: r.reps as number, lapses: r.lapses as number,
    },
  };
}
/** Spaces and . , ! ? … : ; « » " ' ( ) - – — at either end of a word or phrase. migrations/0002_word_key_punctuation.sql trims the same set. */
const KEY_EDGES = /^[ .,!?\u2026:;\u00AB\u00BB"'()\-\u2013\u2014]+|[ .,!?\u2026:;\u00AB\u00BB"'()\-\u2013\u2014]+$/g;
/**
 * The key a word is found by (`notes.word_key`): lower case, single spaces, no punctuation at the edges, so that a
 * typed «рәхмәт» finds the phrase stored as «Рәхмәт!». Punctuation inside stays («юк, рәхмәт»). The shown `word` is not changed.
 */
export const wordKey = (w: string) => w.trim().toLowerCase().replace(/\s+/g, " ").replace(KEY_EDGES, "");

export class Repo {
  constructor(readonly db: D1Database) {}

  batch(stmts: D1PreparedStatement[]) { return this.db.batch(stmts); }

  /* users */
  async insertUser(u: { tgId: number; chatId: number; lang: Lang; now: number }): Promise<number> {
    const r = await this.db.prepare("INSERT INTO users (tg_id, chat_id, lang, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(u.tgId, u.chatId, u.lang, u.now).first<{ id: number }>();
    return r!.id;
  }
  async getUserByTg(tgId: number): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE tg_id = ?").bind(tgId).first<Record<string, unknown>>();
    return r ? rowToUser(r) : null;
  }
  async getUser(id: number): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
    return r ? rowToUser(r) : null;
  }
  updateUserStmt(id: number, patch: Partial<Omit<User, "id">>): D1PreparedStatement {
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error("empty patch");
    const vals = keys.map((k) => {
      const v = (patch as Record<string, unknown>)[k];
      return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
    });
    return this.db.prepare(`UPDATE users SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE id = ?`).bind(...vals, id);
  }
  async updateUser(id: number, patch: Partial<Omit<User, "id">>): Promise<void> { await this.updateUserStmt(id, patch).run(); }
  /**
   * The write that ends onboarding, two statements for one batch: the user patch, applied only while the user is still on
   * the time-zone step, and the subscription to the start deck (if there is one), made only when the patch was applied.
   * Of two concurrent answers to that step one changes the row; `meta.changes` of the first statement tells which.
   */
  finishOnboardingStmts(userId: number, patch: Partial<Omit<User, "id">>, deckId: number | null, now: number): D1PreparedStatement[] {
    const keys = Object.keys(patch);
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null); });
    const stmts = [this.db.prepare(`UPDATE users SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE id = ? AND onboarding_step = 'tz'`).bind(...vals, userId)];
    if (deckId != null) {
      stmts.push(this.db.prepare("INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at) SELECT ?, ?, ? WHERE changes() = 1").bind(userId, deckId, now));
    }
    return stmts;
  }

  /* decks and notes */
  async insertDeck(d: { slug: string | null; kind: DeckRow["kind"]; titleRu: string; titleTt: string; levelNo: number | null; coveragePct: number | null; ownerId: number | null }): Promise<number> {
    const r = await this.db.prepare("INSERT INTO decks (slug, kind, title_ru, title_tt, level_no, coverage_pct, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(d.slug, d.kind, d.titleRu, d.titleTt, d.levelNo, d.coveragePct, d.ownerId).first<{ id: number }>();
    return r!.id;
  }
  async getDeckBySlug(slug: string): Promise<DeckRow | null> {
    const r = await this.db.prepare("SELECT * FROM decks WHERE slug = ?").bind(slug).first<Record<string, unknown>>();
    return r ? this.rowToDeck(r) : null;
  }
  async getDeck(id: number): Promise<DeckRow | null> {
    const r = await this.db.prepare("SELECT * FROM decks WHERE id = ?").bind(id).first<Record<string, unknown>>();
    return r ? this.rowToDeck(r) : null;
  }
  /** The decks a user owns: «Мои слова» and the AI decks. */
  async ownDecks(userId: number): Promise<DeckRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM decks WHERE owner_id = ? ORDER BY id").bind(userId).all<Record<string, unknown>>();
    return results.map((r) => this.rowToDeck(r));
  }
  /**
   * Every level of the catalog with the user's progress in it, in one D1 call.
   * `seen` is counted note by note only for an open level the user is in the middle of. The started notes of a level
   * are its beginning (see `deckHasNew`), so a level whose last note is started is seen whole, and one whose first note
   * is not started has nothing seen but the words the user owns a copy of; those are counted for all levels at once,
   * from the user's own notes. A closed level is not looked into.
   */
  async levelsOverview(userId: number): Promise<LevelRow[]> {
    const [levels, owned] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare(
        `SELECT dk.id, dk.level_no, dk.total, dk.coverage_pct, (ud.user_id IS NOT NULL) AS open,
           CASE WHEN ud.user_id IS NULL THEN 0
                WHEN NOT EXISTS (SELECT 1 FROM ${edgeNote("?1", "dk", "DESC")} l WHERE NOT ${started("?1", "l.id")}) THEN dk.total
                WHEN EXISTS (SELECT 1 FROM ${edgeNote("?1", "dk", "ASC")} f WHERE NOT ${started("?1", "f.id")}) THEN NULL
                ELSE (SELECT COUNT(*) FROM notes n WHERE n.deck_id = dk.id AND (${started("?1", "n.id")} OR ${ownedCopy("?1")})) END AS seen
         FROM decks dk LEFT JOIN user_decks ud ON ud.deck_id = dk.id AND ud.user_id = ?1
         WHERE dk.level_no IS NOT NULL ORDER BY dk.level_no`,
      ).bind(userId),
      this.db.prepare(
        `SELECT n.deck_id, COUNT(DISTINCT n.id) AS owned FROM decks od JOIN notes o ON o.deck_id = od.id
           JOIN notes n ON n.word_key = o.word_key JOIN decks dk ON dk.id = n.deck_id
         WHERE od.owner_id = ?1 AND dk.kind = 'catalog' AND dk.level_no IS NOT NULL GROUP BY n.deck_id`,
      ).bind(userId),
    ]);
    const ownedIn = new Map(owned!.results.map((r) => [r.deck_id as number, r.owned as number]));
    return levels!.results.map((r) => ({
      levelNo: r.level_no as number, total: r.total as number, coveragePct: (r.coverage_pct as number) ?? null, open: r.open === 1,
      seen: (r.seen as number | null) ?? ownedIn.get(r.id as number) ?? 0,
    }));
  }
  /**
   * The level a learner placed at `placed` starts from while the catalog is not complete: the highest existing level
   * not above `placed`, or the lowest existing one when there is none; null when the catalog has no levels at all.
   */
  async startLevel(placed: number): Promise<{ deckId: number; levelNo: number } | null> {
    const r = await this.db.prepare(
      `SELECT id, level_no FROM decks WHERE level_no IS NOT NULL
       ORDER BY (level_no <= ?1) DESC, CASE WHEN level_no <= ?1 THEN -level_no ELSE level_no END LIMIT 1`,
    ).bind(placed).first<{ id: number; level_no: number }>();
    return r ? { deckId: r.id, levelNo: r.level_no } : null;
  }
  /** Opens every level below the user's current one; returns how many were opened. */
  async openSkippedLevels(userId: number, now: number): Promise<number> {
    const r = await this.db.prepare(
      `INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at)
       SELECT u.id, d.id, ?2 FROM users u JOIN decks d ON d.level_no < u.level WHERE u.id = ?1`,
    ).bind(userId, now).run();
    return r.meta.changes ?? 0;
  }
  /**
   * Opens the level that follows `from`: the next level the catalog has (the smallest `level_no` above `from`, up to
   * `last`), so a gap in the catalog is stepped over. Three statements for one batch: the level change, which returns
   * the new level; the subscription to the deck of that level, made only when the level changed; and the coverage of
   * `from` for the announcement.
   * The level change touches a row only if the user is still on `from`, so only one of several concurrent calls gets
   * the new level back; and only if the deck of `from` is open for the user or does not exist — a current level that
   * was never opened is opened first, see `openCurrentLevelStmt`. While no higher level exists nothing changes, except
   * on the last level: from there the user moves to `last + 1`, which means every level is done.
   */
  openLevelStmts(userId: number, from: number, last: number, now: number): D1PreparedStatement[] {
    const next = "(SELECT MIN(level_no) FROM decks WHERE level_no > ?1 AND level_no <= ?2)";
    const currentClosed = "EXISTS (SELECT 1 FROM decks d WHERE d.level_no = ?1 AND NOT EXISTS (SELECT 1 FROM user_decks ud WHERE ud.user_id = ?3 AND ud.deck_id = d.id))";
    return [
      this.db.prepare(`UPDATE users SET level = COALESCE(${next}, ?2 + 1) WHERE id = ?3 AND level = ?1 AND (?1 = ?2 OR ${next} IS NOT NULL) AND NOT ${currentClosed} RETURNING level`).bind(from, last, userId),
      this.db.prepare(`${OPEN_CURRENT_LEVEL} AND changes() = 1`).bind(userId, now),
      this.db.prepare("SELECT coverage_pct FROM decks WHERE level_no = ?").bind(from),
    ];
  }
  /**
   * Opens the deck of the user's current level when the catalog has it and the user is not subscribed to it; `users.level`
   * stays. A user's level is meant to be open whenever its deck exists; this restores that for a learner who finished
   * onboarding before the level was published. Safe to run from several calls at once: the deck is opened once.
   */
  openCurrentLevelStmt(userId: number, now: number): D1PreparedStatement {
    return this.db.prepare(OPEN_CURRENT_LEVEL).bind(userId, now);
  }
  private rowToDeck(r: Record<string, unknown>): DeckRow {
    return { id: r.id as number, slug: (r.slug as string) ?? null, ownerId: (r.owner_id as number) ?? null, kind: r.kind as DeckRow["kind"],
      titleRu: r.title_ru as string, titleTt: r.title_tt as string, levelNo: (r.level_no as number) ?? null,
      coveragePct: (r.coverage_pct as number) ?? null, total: r.total as number };
  }
  async insertNotes(deckId: number, rows: NoteInput[]): Promise<number[]> {
    if (!rows.length) return [];
    const stmts = rows.map((n) =>
      this.db.prepare(
        `INSERT INTO notes (deck_id, word, word_key, transcription, pos, translation, example_tt, example_ru, example_src, audio_file_id, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (deck_id, word_key) DO UPDATE SET word = excluded.word RETURNING id`,
      ).bind(deckId, n.word.trim(), wordKey(n.word), n.transcription ?? null, n.pos, n.translation, n.exampleTt, n.exampleRu,
        n.exampleSrc ?? "", n.audioFileId ?? null, n.sourceUrl ?? null),
    );
    stmts.push(this.db.prepare("UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = ?1) WHERE id = ?1").bind(deckId));
    const res = await this.db.batch<{ id: number }>(stmts);
    return res.slice(0, rows.length).map((r) => r.results[0]!.id);
  }
  subscribeStmt(userId: number, deckId: number, now: number): D1PreparedStatement {
    return this.db.prepare("INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at) VALUES (?, ?, ?)").bind(userId, deckId, now);
  }
  async subscribe(userId: number, deckId: number, now: number): Promise<void> { await this.subscribeStmt(userId, deckId, now).run(); }
  async userDeckIds(userId: number): Promise<number[]> {
    const { results } = await this.db.prepare("SELECT deck_id FROM user_decks WHERE user_id = ? ORDER BY added_at, deck_id").bind(userId).all<{ deck_id: number }>();
    return results.map((r) => r.deck_id);
  }
  /** A note with this word in any deck the user is subscribed to. */
  async findNoteForUser(userId: number, word: string): Promise<(NoteRow & { deckTitleRu: string; deckTitleTt: string }) | null> {
    const r = await this.db.prepare(
      `SELECT n.id, n.deck_id, ${noteCols("?1")}, d.title_ru, d.title_tt FROM notes n
       JOIN user_decks ud ON ud.deck_id = n.deck_id AND ud.user_id = ?1 JOIN decks d ON d.id = n.deck_id
       WHERE n.word_key = ?2 LIMIT 1`,
    ).bind(userId, wordKey(word)).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, deckTitleRu: r.title_ru as string, deckTitleTt: r.title_tt as string } : null;
  }
  /**
   * Batch version of findNoteForUser: one D1 call for many words, keyed by wordKey.
   * When a word is both in a deck the user owns and in an open level, the own note wins: the queue shows that one and skips the level's.
   * `owned` is true for a note in a deck of the user's own; a level note is shared by every learner.
   */
  async findNotesForUser(userId: number, words: string[]): Promise<Map<string, UserNote>> {
    const keys = [...new Set(words.map(wordKey))];
    const out = new Map<string, UserNote>();
    if (!keys.length) return out;
    const { results } = await this.db.prepare(
      `SELECT n.id, n.deck_id, n.word_key, ${noteCols("?1")}, d.title_ru, d.title_tt, d.owner_id IS ?1 AS owned FROM notes n
       JOIN user_decks ud ON ud.deck_id = n.deck_id AND ud.user_id = ?1 JOIN decks d ON d.id = n.deck_id
       WHERE n.word_key IN (SELECT value FROM json_each(?2)) ORDER BY (d.owner_id IS NULL), n.id`,
    ).bind(userId, JSON.stringify(keys)).all<Record<string, unknown>>();
    for (const r of results) {
      const k = r.word_key as string;
      if (!out.has(k)) {
        out.set(k, { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, deckTitleRu: r.title_ru as string, deckTitleTt: r.title_tt as string, owned: r.owned === 1 });
      }
    }
    return out;
  }
  /** The reviewed cards of the catalog for these words, from any level, open or not: one D1 call, keyed by wordKey. A catalog note has no link to give. */
  async findCatalogNotes(words: string[]): Promise<Map<string, NoteRow & { levelNo: number }>> {
    const keys = [...new Set(words.map(wordKey))];
    const out = new Map<string, NoteRow & { levelNo: number }>();
    if (!keys.length) return out;
    const { results } = await this.db.prepare(
      `SELECT n.id, n.deck_id, n.word_key, ${noteCols(null)}, d.level_no FROM notes n JOIN decks d ON d.id = n.deck_id
       WHERE d.kind = 'catalog' AND d.level_no IS NOT NULL AND n.word_key IN (SELECT value FROM json_each(?)) ORDER BY d.level_no, n.id`,
    ).bind(JSON.stringify(keys)).all<Record<string, unknown>>();
    for (const r of results) {
      const k = r.word_key as string;
      if (!out.has(k)) out.set(k, { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, levelNo: r.level_no as number });
    }
    return out;
  }
  /** The note as nobody in particular reads it: for its voice. Its link is not given; `visibleNote` reads a note for a user. */
  async getNote(id: number): Promise<NoteRow | null> {
    const r = await this.db.prepare(`SELECT n.id, n.deck_id, ${noteCols(null)} FROM notes n WHERE n.id = ?`).bind(id).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number } : null;
  }
  /** The note when the user can see it: it is in one of their decks or they have a card for it. */
  async visibleNote(userId: number, noteId: number): Promise<NoteRow | null> {
    const r = await this.db.prepare(
      `SELECT n.id, n.deck_id, ${noteCols("?2")} FROM notes n WHERE n.id = ?1
       AND (n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?2)
            OR EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ?2 AND c.note_id = ?1))`,
    ).bind(noteId, userId).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number } : null;
  }
  /** Stores a mistake report; false when this user has already reported this note. */
  async insertReport(userId: number, noteId: number, now: number): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO reports (user_id, note_id, created_at) VALUES (?, ?, ?)").bind(userId, noteId, now).run();
    return r.meta.changes > 0;
  }
  /** The most recently reported words, one row per word with the number of reports. */
  async recentReports(limit: number): Promise<{ noteId: number; word: string; translation: string; count: number; lastAt: number }[]> {
    const { results } = await this.db.prepare(
      `SELECT n.id AS note_id, n.word, n.translation, COUNT(*) AS cnt, MAX(r.created_at) AS last_at
       FROM reports r JOIN notes n ON n.id = r.note_id GROUP BY n.id ORDER BY last_at DESC, n.id DESC LIMIT ?`,
    ).bind(limit).all<{ note_id: number; word: string; translation: string; cnt: number; last_at: number }>();
    return results.map((r) => ({ noteId: r.note_id, word: r.word, translation: r.translation, count: r.cnt, lastAt: r.last_at }));
  }
  /**
   * Attaches the user's link to a note that has none yet. Only a note in a deck this user owns is touched:
   * a level note is shown to every learner, so nobody's link may be written on it.
   */
  setNoteSourceUrlStmt(userId: number, noteId: number, url: string): D1PreparedStatement {
    return this.db.prepare(
      "UPDATE notes SET source_url = ?1 WHERE id = ?2 AND source_url IS NULL AND deck_id IN (SELECT id FROM decks WHERE owner_id = ?3)",
    ).bind(url, noteId, userId);
  }
  async setNoteAudio(noteId: number, fileId: string): Promise<void> {
    await this.db.prepare("UPDATE notes SET audio_file_id = ? WHERE id = ?").bind(fileId, noteId).run();
  }

  /* cards */
  async insertCard(userId: number, noteId: number, direction: Direction, m: Mem, buriedDay: string | null = null): Promise<number> {
    const r = await this.insertCardStmt(userId, noteId, direction, m, buriedDay).first<{ id: number }>();
    return r!.id;
  }
  insertCardStmt(userId: number, noteId: number, direction: Direction, m: Mem, buriedDay: string | null = null): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, step, stability, difficulty, due, last_review, scheduled_days, reps, lapses, buried_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(userId, noteId, direction, m.state, m.step, m.stability, m.difficulty, m.due, m.lastReview, m.scheduledDays, m.reps, m.lapses, buriedDay);
  }
  updateCardStmt(cardId: number, m: Mem): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE cards SET state = ?, step = ?, stability = ?, difficulty = ?, due = ?, last_review = ?, scheduled_days = ?, reps = ?, lapses = ? WHERE id = ?`,
    ).bind(m.state, m.step, m.stability, m.difficulty, m.due, m.lastReview, m.scheduledDays, m.reps, m.lapses, cardId);
  }
  /** Card update that only applies when reps still matches (first statement of a guarded grade batch). */
  gradeCardStmt(cardId: number, expectedReps: number, m: Mem): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE cards SET state = ?, step = ?, stability = ?, difficulty = ?, due = ?, last_review = ?, scheduled_days = ?, reps = ?, lapses = ? WHERE id = ? AND reps = ?`,
    ).bind(m.state, m.step, m.stability, m.difficulty, m.due, m.lastReview, m.scheduledDays, m.reps, m.lapses, cardId, expectedReps);
  }
  /** Following statements of a guarded batch run only if the previous one changed a row (SQLite changes()). */
  guardedLogStmt(l: Omit<ReviewLogRow, "id" | "undone">): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new, learned_now, streak_before, last_study_day_before)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(l.cardId, l.userId, l.rating, JSON.stringify(l.stateBefore), l.intervalBeforeDays, l.intervalAfterMs, l.reviewedAt,
      l.wasNew ? 1 : 0, l.learnedNow ? 1 : 0, l.streakBefore, l.lastStudyDayBefore);
  }
  guardedUserStmt(id: number, patch: Partial<Omit<User, "id">>): D1PreparedStatement {
    const keys = Object.keys(patch);
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null); });
    return this.db.prepare(`UPDATE users SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE id = ? AND changes() = 1`).bind(...vals, id);
  }
  guardedUsageStmt(day: string, reviews: number, rows: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO usage_daily (day, reviews, rows_written_est, requests) SELECT ?, ?, ?, 0 WHERE changes() = 1
       ON CONFLICT (day) DO UPDATE SET reviews = reviews + excluded.reviews, rows_written_est = rows_written_est + excluded.rows_written_est`,
    ).bind(day, reviews, rows);
  }
  guardedSiblingStmt(userId: number, noteId: number, siblingDir: Direction, day: string, now: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, due, scheduled_days, reps, lapses, buried_day) SELECT ?, ?, ?, 'new', ?, 0, 0, 0, ? WHERE changes() = 1
       ON CONFLICT (user_id, note_id, direction) DO UPDATE SET buried_day = excluded.buried_day WHERE cards.state NOT IN ('learning','relearning')`,
    ).bind(userId, noteId, siblingDir, now, day);
  }

  /** Returns the id of the (possibly pre-created) new card for this note and direction. */
  async ensureNewCard(userId: number, noteId: number, direction: Direction, m: Mem): Promise<number> {
    const r = await this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, due, scheduled_days, reps, lapses) VALUES (?, ?, ?, 'new', ?, 0, 0, 0)
       ON CONFLICT (user_id, note_id, direction) DO UPDATE SET due = cards.due RETURNING id`,
    ).bind(userId, noteId, direction, m.due).first<{ id: number }>();
    return r!.id;
  }
  /** Hide the other-direction card of a note until tomorrow, creating it as new if needed. */
  siblingBuryStmt(userId: number, noteId: number, siblingDir: Direction, day: string, now: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, due, scheduled_days, reps, lapses, buried_day) VALUES (?, ?, ?, 'new', ?, 0, 0, 0, ?)
       ON CONFLICT (user_id, note_id, direction) DO UPDATE SET buried_day = excluded.buried_day WHERE cards.state NOT IN ('learning','relearning')`,
    ).bind(userId, noteId, siblingDir, now, day);
  }
  /** Today's activity and cumulative totals by stage for one display direction. */
  async summary(userId: number, dayStartMs: number, direction: Direction): Promise<{ reviewsToday: number; learnedToday: number; learned: number; known: number; learning: number; new: number }> {
    const r = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?2) AS reviews_today,
         (SELECT COALESCE(SUM(learned_now), 0) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?2) AS learned_today,
         COALESCE(SUM(CASE WHEN c.id IS NULL OR c.state = 'new' THEN 1 ELSE 0 END), 0) AS new_n,
         COALESCE(SUM(CASE WHEN c.state IN ('learning','relearning') OR (c.state = 'review' AND c.scheduled_days < 7) THEN 1 ELSE 0 END), 0) AS learning_n,
         COALESCE(SUM(CASE WHEN c.state = 'review' AND c.scheduled_days BETWEEN 7 AND 20 THEN 1 ELSE 0 END), 0) AS known_n,
         COALESCE(SUM(CASE WHEN c.state = 'review' AND c.scheduled_days >= 21 THEN 1 ELSE 0 END), 0) AS learned_n
       FROM notes n LEFT JOIN cards c ON c.note_id = n.id AND c.user_id = ?1 AND c.direction = ?3
       WHERE n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)`,
    ).bind(userId, dayStartMs, direction).first<Record<string, number>>();
    return { reviewsToday: r!.reviews_today!, learnedToday: r!.learned_today!, learned: r!.learned_n!, known: r!.known_n!, learning: r!.learning_n!, new: r!.new_n! };
  }
  async getCard(userId: number, cardId: number): Promise<CardRow | null> {
    const r = await this.db.prepare(`SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ? AND c.user_id = ?`)
      .bind(cardId, userId).first<Record<string, unknown>>();
    return r ? rowToCard(r) : null;
  }
  async getCardByNote(userId: number, noteId: number, direction: Direction): Promise<CardRow | null> {
    const r = await this.db.prepare(`SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ? AND c.note_id = ? AND c.direction = ?`)
      .bind(userId, noteId, direction).first<Record<string, unknown>>();
    return r ? rowToCard(r) : null;
  }

  /**
   * Everything the session queue needs, in one D1 call. `pre` statements run first in the same batch; their results come back as `pre`.
   * `currentLevelClosed`: the catalog has the deck of the user's current level and the user is not subscribed to it.
   * `nextLevelExists`: a level change would move the user — the catalog has a level above the current one, or the
   * current one is the last (level `lastLevel`), after which the user is done with the levels.
   *
   * New words come in this order: own and AI decks first, then the levels by number; inside a deck by note id, and the
   * directions of a note in the order of `w.directions`. Only the decks that can hold the next new words are read:
   * the own decks that still have a new card today and the lowest such open level (`deckHasNew`); the levels below
   * it are finished and the levels above it wait for their turn. So `newNotes` are the next new cards, but not all
   * of them when the level in work is near its end and another open level follows.
   */
  async candidateCards(userId: number, now: number, w: DayWindow, pre: D1PreparedStatement[] = [], lastLevel = 20): Promise<Candidates & { pre: D1Result<Record<string, unknown>>[]; currentLevelClosed: boolean; nextLevelExists: boolean }> {
    const lim = w.limitEach ?? 50;
    const dirs = JSON.stringify(w.directions);
    const inDirs = "c.direction IN (SELECT value FROM json_each(?))";
    const notBuried = "(c.buried_day IS NULL OR c.buried_day != ?)";
    const inDecks = "n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?)";
    const asked: Asked = { today: "?2", tt: "?3", ru: "?4" };
    const res = await this.db.batch<Record<string, unknown>>([
      ...pre,
      this.db.prepare(`SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id
        WHERE c.user_id = ? AND c.state IN ('learning','relearning') AND ${inDirs} AND ${inDecks} ORDER BY c.due LIMIT ?`).bind(userId, dirs, userId, lim),
      this.db.prepare(`SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id
        WHERE c.user_id = ? AND c.state = 'review' AND c.due < ? AND ${inDirs} AND ${notBuried} AND ${inDecks} ORDER BY c.due LIMIT ?`)
        .bind(userId, w.dayEndMs, dirs, w.today, userId, lim),
      // `todo`: the decks of the user that still have a new card today. One row per note; `seen_tt`, `seen_ru` tell which of its directions are started.
      // A level word the user already owns (same word_key in a deck with owner_id = user) counts as shown and is skipped.
      this.db.prepare(`WITH todo AS MATERIALIZED (
          SELECT dk.id, dk.level_no FROM user_decks ud JOIN decks dk ON dk.id = ud.deck_id WHERE ud.user_id = ?1 AND ${deckHasNew("?1", "dk", asked)})
        SELECT n.id AS note_id, ${noteCols("?1", "dk.owner_id")}, ${startedIn("tt_ru")} AS seen_tt, ${startedIn("ru_tt")} AS seen_ru
        FROM notes n JOIN decks dk ON dk.id = n.deck_id LEFT JOIN cards c ON c.user_id = ?1 AND c.note_id = n.id
        WHERE n.deck_id IN (SELECT id FROM todo WHERE level_no IS NULL OR level_no = (SELECT MIN(level_no) FROM todo)) AND NOT ${ownedCopy("?1")}
        GROUP BY n.id HAVING COALESCE(MAX(c.buried_day IS ?2), 0) = 0 AND (seen_tt < ?3 OR seen_ru < ?4)
        ORDER BY (dk.kind = 'catalog'), COALESCE(dk.level_no, 0), n.id LIMIT ?5`)
        .bind(userId, w.today, w.directions.includes("tt_ru") ? 1 : 0, w.directions.includes("ru_tt") ? 1 : 0, lim),
      this.db.prepare(`SELECT
          (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND c.state IN ('learning','relearning') AND c.direction IN (SELECT value FROM json_each(?2)) AND n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)) AS learning,
          (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND c.state = 'review' AND c.due < ?3 AND c.direction IN (SELECT value FROM json_each(?2)) AND (c.buried_day IS NULL OR c.buried_day != ?4) AND n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)) AS review,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND was_new = 1 AND rating < 4 AND undone = 0 AND reviewed_at >= ?5) AS new_done_today,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND was_new = 1 AND rating = 4 AND undone = 0 AND reviewed_at >= ?5) AS easy_new_today,
          EXISTS (SELECT 1 FROM users u JOIN decks dk ON dk.level_no = u.level WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM user_decks ud WHERE ud.user_id = ?1 AND ud.deck_id = dk.id)) AS level_closed,
          EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND (u.level = ?6 OR EXISTS (SELECT 1 FROM decks d WHERE d.level_no > u.level AND d.level_no <= ?6))) AS next_level`)
        .bind(userId, dirs, w.dayEndMs, w.today, w.dayStartMs, lastLevel),
    ]);
    const [learning, review, fresh, counts] = res.slice(pre.length);
    const c = counts!.results[0]!;
    // The directions of a note in the order the caller asked for them.
    const newNotes = fresh!.results.flatMap((r) => w.directions
      .filter((d) => (d === "tt_ru" ? r.seen_tt : r.seen_ru) === 0)
      .map((direction): NewNote => ({ ...noteFields(r), noteId: r.note_id as number, direction }))).slice(0, lim);
    return {
      pre: res.slice(0, pre.length),
      currentLevelClosed: c.level_closed === 1,
      nextLevelExists: c.next_level === 1,
      learning: learning!.results.map(rowToCard),
      review: review!.results.map(rowToCard),
      newNotes,
      counts: { learning: c.learning as number, review: c.review as number, newAvailable: newNotes.length, newDoneToday: c.new_done_today as number, easyNewToday: c.easy_new_today as number },
    };
    void now;
  }

  /** Cumulative numbers for /stats in one D1 call; `coveragePct` is the coverage of the nearest level the catalog has below the user's current one. */
  async statsExtra(userId: number, now: number, dayStartMs: number, direction: Direction): Promise<{ memory: number; total: number; r30: number; rev30: number; ok30: number; coveragePct: number | null; forecast: { d: number; n: number }[] }> {
    const since = now - 30 * 86_400_000;
    const [a, f] = await this.db.batch<Record<string, number | null>>([
      this.db.prepare(`SELECT
          (SELECT COALESCE(SUM(CASE WHEN state = 'review' THEN scheduled_days WHEN state = 'relearning' THEN MAX(1, CAST(ROUND(stability) AS INTEGER)) ELSE 0 END), 0)
             FROM cards WHERE user_id = ?1 AND direction = ?2) AS memory,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0) AS total,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3) AS r30,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3 AND json_extract(state_before, '$.state') = 'review') AS rev30,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3 AND json_extract(state_before, '$.state') = 'review' AND rating > 1) AS ok30,
          (SELECT d.coverage_pct FROM decks d JOIN users u ON u.id = ?1 WHERE d.level_no < u.level ORDER BY d.level_no DESC LIMIT 1) AS coverage`)
        .bind(userId, direction, since),
      this.db.prepare(`SELECT MAX(0, CAST((due - ?2) / 86400000 AS INTEGER)) AS d, COUNT(*) AS n FROM cards
          WHERE user_id = ?1 AND state != 'new' AND due < ?2 + 7 * 86400000 GROUP BY d`).bind(userId, dayStartMs),
    ]);
    const r = a!.results[0]!;
    return { memory: r.memory!, total: r.total!, r30: r.r30!, rev30: r.rev30!, ok30: r.ok30!, coveragePct: r.coverage ?? null, forecast: f!.results.map((x) => ({ d: x.d!, n: x.n! })) };
  }

  /* review log */
  insertLogStmt(l: Omit<ReviewLogRow, "id" | "undone">): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new, learned_now, streak_before, last_study_day_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(l.cardId, l.userId, l.rating, JSON.stringify(l.stateBefore), l.intervalBeforeDays, l.intervalAfterMs, l.reviewedAt,
      l.wasNew ? 1 : 0, l.learnedNow ? 1 : 0, l.streakBefore, l.lastStudyDayBefore);
  }
  async lastReviewLog(userId: number): Promise<ReviewLogRow | null> {
    const r = await this.db.prepare("SELECT * FROM review_log WHERE user_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1").bind(userId).first<Record<string, unknown>>();
    if (!r) return null;
    return {
      id: r.id as number, cardId: r.card_id as number, userId: r.user_id as number, rating: r.rating as number,
      stateBefore: JSON.parse(r.state_before as string) as Mem, intervalBeforeDays: r.interval_before_days as number,
      intervalAfterMs: r.interval_after_ms as number, reviewedAt: r.reviewed_at as number, wasNew: r.was_new === 1,
      learnedNow: r.learned_now === 1, streakBefore: r.streak_before as number, lastStudyDayBefore: (r.last_study_day_before as string) ?? null, undone: false,
    };
  }
  markUndoneStmt(logId: number): D1PreparedStatement { return this.db.prepare("UPDATE review_log SET undone = 1 WHERE id = ?").bind(logId); }

  /* sessions */
  async getSession(userId: number): Promise<Session | null> {
    const r = await this.db.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(userId).first<Record<string, unknown>>();
    return r ? { userId, chatId: r.chat_id as number, messageId: (r.message_id as number) ?? null, cardId: (r.card_id as number) ?? null,
      stale: r.stale === 1, lastVoiceMessageId: (r.last_voice_message_id as number) ?? null } : null;
  }
  saveSessionStmt(s: Session): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, message_id, card_id, stale, last_voice_message_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id,
       stale = excluded.stale, last_voice_message_id = excluded.last_voice_message_id`,
    ).bind(s.userId, s.chatId, s.messageId, s.cardId, s.stale ? 1 : 0, s.lastVoiceMessageId);
  }
  async saveSession(s: Session): Promise<void> { await this.saveSessionStmt(s).run(); }
  /** Points the session at a message/card without touching the voice message id. */
  async setSessionMessage(userId: number, chatId: number, messageId: number, cardId: number | null): Promise<void> {
    await this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id, stale = 0`,
    ).bind(userId, chatId, messageId, cardId).run();
  }
  /** Moves the session to a freshly sent message and forgets the old voice message; returns that voice id so it can be deleted. One D1 call. */
  async replaceSessionMessage(userId: number, chatId: number, messageId: number, cardId: number | null): Promise<number | null> {
    const [prev] = await this.db.batch<{ last_voice_message_id: number | null }>([
      this.db.prepare("SELECT last_voice_message_id FROM sessions WHERE user_id = ?").bind(userId),
      this.db.prepare(
        `INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id, stale = 0, last_voice_message_id = NULL`,
      ).bind(userId, chatId, messageId, cardId),
    ]);
    return prev?.results[0]?.last_voice_message_id ?? null;
  }
  async markSessionStale(userId: number): Promise<void> {
    await this.db.prepare("UPDATE sessions SET stale = 1 WHERE user_id = ?").bind(userId).run();
  }

  /* previews */
  async insertPreview(userId: number, kind: "add" | "gen", payload: unknown, now: number): Promise<number> {
    const r = await this.db.prepare("INSERT INTO previews (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(userId, kind, JSON.stringify(payload), now).first<{ id: number }>();
    return r!.id;
  }
  async getPreview<T>(userId: number, id: number, kind: "add" | "gen", notBefore: number): Promise<T | null> {
    const r = await this.db.prepare("SELECT payload FROM previews WHERE id = ? AND user_id = ? AND kind = ? AND created_at >= ?")
      .bind(id, userId, kind, notBefore).first<{ payload: string }>();
    return r ? (JSON.parse(r.payload) as T) : null;
  }
  async updatePreview(id: number, payload: unknown): Promise<void> {
    await this.db.prepare("UPDATE previews SET payload = ? WHERE id = ?").bind(JSON.stringify(payload), id).run();
  }
  /**
   * Deletes a preview and, in the same D1 call, forgets that the user was editing it: a `pending_edit` that points to
   * a preview that is gone would take the user's next message for a translation of nothing.
   */
  async deletePreview(userId: number, id: number): Promise<boolean> {
    const [deleted] = await this.db.batch([
      this.db.prepare("DELETE FROM previews WHERE id = ? AND user_id = ?").bind(id, userId),
      this.db.prepare("UPDATE users SET pending_edit = NULL WHERE id = ?1 AND json_extract(pending_edit, '$.preview.previewId') = ?2").bind(userId, id),
    ]);
    return (deleted!.meta.changes ?? 0) > 0;
  }
  /** The user's own "My words" deck, created and subscribed on first use. */
  async customDeck(userId: number, now: number): Promise<number> {
    const r = await this.db.prepare("SELECT id FROM decks WHERE owner_id = ? AND kind = 'custom' LIMIT 1").bind(userId).first<{ id: number }>();
    if (r) return r.id;
    const id = await this.insertDeck({ slug: null, kind: "custom", titleRu: "Мои слова", titleTt: "Минем сүзләр", levelNo: null, coveragePct: null, ownerId: userId });
    await this.subscribe(userId, id, now);
    return id;
  }

  /* usage */
  bumpUsageStmt(day: string, reviews: number, rows: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO usage_daily (day, reviews, rows_written_est, requests) VALUES (?, ?, ?, 0)
       ON CONFLICT (day) DO UPDATE SET reviews = reviews + excluded.reviews, rows_written_est = rows_written_est + excluded.rows_written_est`,
    ).bind(day, reviews, rows);
  }
}
