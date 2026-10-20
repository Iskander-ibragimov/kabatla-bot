import { ALL_LEVELS, ALL_POS, LEVELS, type NewMode, levelBit, tseqOf } from "../levels/scale";
import type { Mem } from "../srs/ladder";
import { type DayWindow, type NewScope, type Queue, ownedCopiesStmt, progressStmt, readQueue, unprogressStmt } from "./queue";
import { type Asked, CARD_COLS, type CardRow, type Direction, NEW_CARDS, type NoteFields, answersToday, askedDirection, noteCols, noteFields, rowToCard } from "./sql";

export type { CatalogNew, DayWindow, LearningRow, NewScope, Queue, RecentAnswer, StreamSeen } from "./queue";
export type { Asked, CardRow, Direction, NewNote, NoteFields } from "./sql";

export type Lang = "ru" | "tt";
export type DirectionSetting = Direction | "both";

export interface User {
  id: number;
  tgId: number;
  chatId: number;
  lang: Lang;
  tzOffsetMin: number;
  remindAt: string;
  newPerDay: number;
  /** The share of words the old scheduler aimed to keep. The column stays; nothing reads it since the ladder of intervals. */
  retention: number;
  direction: DirectionSetting;
  autoplay: boolean;
  streak: number;
  lastStudyDay: string | null;
  active: boolean;
  onboardingStep: string | null;
  onboardingData: string | null;
  gensDay: string | null;
  gensCount: number;
  /** Messages with words sent on the local day `addsDay`; see entitlements/service.ts. */
  addsDay: string | null;
  addsCount: number;
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
  /** Bit mask of the checked levels (bit 0 = A1 … bit 4 = C1). */
  levels: number;
  /** Bit mask of the checked part-of-speech groups. */
  posGroups: number;
  newMode: NewMode;
  topicNo: number | null;
  /** Bit mask of the hints the user has already seen. */
  hintsSeen: number;
  /** JSON of the read positions per level; see the design spec. */
  newCursors: string | null;
}

export type NoteInput = Pick<NoteFields, "word" | "transcription" | "pos" | "translation" | "exampleTt" | "exampleRu"> &
  Partial<Pick<NoteFields, "exampleSrc" | "audioFileId" | "sourceUrl">> & {
    /** Catalog position: only catalog notes have it; own and AI notes leave all three out. */
    level?: number; topicNo?: number; seq?: number;
  };
export interface NoteRow extends NoteFields { id: number; deckId: number }
/** A note the user already learns, with the titles of its deck; `owned`: the deck is the user's own, not a level of the catalog. */
export interface UserNote extends NoteRow { deckTitleRu: string; deckTitleTt: string; owned: boolean }
/** The words a user has started in one pair (level, topic); own words are the pair (0, 0). */
export interface PairStarted { level: number; topicNo: number; started: number }
/** The cards the catalog has in one pair (level, topic). */
export interface PairTotal { level: number; topicNo: number; total: number }
/** A level of the scale as the catalog has it: the cards in its deck and the share of ordinary text they cover, in percent. */
export interface LevelDeck { level: number; total: number; coveragePct: number | null }
export interface TopicRow { no: number; slug: string; titleRu: string; titleTt: string }
/**
 * The counters the screens of the levels are built from: the decks of the levels, the cards of the catalog and the
 * words the user has started by pair (level, topic), the topics, and the decks the user owns (when they were asked for).
 */
export interface LevelsData { decks: LevelDeck[]; totals: PairTotal[]; progress: PairStarted[]; topics: TopicRow[]; own: DeckRow[] }
export interface Session { userId: number; chatId: number; messageId: number | null; cardId: number | null; lastVoiceMessageId: number | null }
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
 * A scalar subquery: 1 when a direction the user asks for has no card at all for this note, in any state. Such a
 * note is not buried either: the grade that buries a word makes sure both of its cards exist. Index only.
 */
export const lacksCard = (user: string, noteId: string, a: Asked) =>
  `(SELECT COALESCE(MAX(r.direction = 'tt_ru'), 0) < ${a.tt} OR COALESCE(MAX(r.direction = 'ru_tt'), 0) < ${a.ru} FROM cards r WHERE r.user_id = ${user} AND r.note_id = ${noteId})`;
/**
 * For the reminder, of a deck the user owns: true while the last note of the deck has no card in a direction the
 * user asks for — the words of such a deck are given in the order of their ids, so the deck has words that were
 * never shown that way. The cards that already exist in state 'new' are counted apart, by `newCardRows`.
 */
export const deckHasUnshown = (user: string, deck: string, a: Asked) =>
  `EXISTS (SELECT 1 FROM (SELECT x.id FROM notes x WHERE x.deck_id = ${deck}.id ORDER BY x.id DESC LIMIT 1) l WHERE ${lacksCard(user, "l.id", a)})`;
/**
 * How many of the last `limit` notes of the deck have no card in a direction the user asks for: the words of the deck
 * that were never shown that way, counted up to `limit`. An estimate for the reminder, of a deck that `deckHasUnshown`
 * says has at least one such word.
 */
export const unshownInTail = (user: string, deck: string, a: Asked, limit: number) =>
  `(SELECT COUNT(*) FROM (SELECT x.id FROM notes x WHERE x.deck_id = ${deck}.id ORDER BY x.id DESC LIMIT ${Math.trunc(limit)}) t WHERE ${lacksCard(user, "t.id", a)})`;
/**
 * How many cards of the user wait in state 'new' in a direction the user asks for, counted up to `limit`: the cards
 * that were hidden when the other card of their word was graded, and a card that was shown and not graded.
 * Counted in the index idx_cards_user_new alone.
 */
export const newCardRows = (user: string, a: Asked, limit: number) =>
  `(SELECT COUNT(*) FROM (SELECT 1 FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.state = 'new' AND ${askedDirection("f", a)} LIMIT ${Math.trunc(limit)}))`;

const pairsStarted = (rows: Record<string, unknown>[]): PairStarted[] =>
  rows.map((r) => ({ level: r.level as number, topicNo: r.topic_no as number, started: r.started as number }));
const pairTotals = (rows: Record<string, unknown>[]): PairTotal[] =>
  rows.map((r) => ({ level: r.level as number, topicNo: r.topic_no as number, total: r.total as number }));
const levelDecksOf = (rows: Record<string, unknown>[]): LevelDeck[] =>
  rows.map((r) => ({ level: r.level as number, total: r.total as number, coveragePct: (r.coverage_pct as number) ?? null }));
const topicRows = (rows: Record<string, unknown>[]): TopicRow[] =>
  rows.map((r) => ({ no: r.no as number, slug: r.slug as string, titleRu: r.title_ru as string, titleTt: r.title_tt as string }));
/** `mask` with the bits of `bits` flipped, as SQL: SQLite has no operator for it. */
const flipped = (mask: string, bits: string) => `((${mask} | ${bits}) - (${mask} & ${bits}))`;
/** As SQL: true when `level` is a level of the scale and the catalog has a card of it. */
const levelHasCards = (level: string) =>
  `EXISTS (SELECT 1 FROM decks d WHERE d.level_no = ${level} AND d.level_no BETWEEN 1 AND ${LEVELS.length} AND d.kind = 'catalog' AND d.total > 0)`;
const todayOf = (rows: Record<string, unknown>[]) => ({ reviewsToday: rows[0]!.reviews as number, learnedToday: rows[0]!.learned as number });
/**
 * Spaces, . , ! ? … : ; « » " ' ( ) - – — and the typographic quotes “ ” „ ‘ ’ at either end of a word or phrase.
 * migrations/0002_word_key_punctuation.sql and 0006_word_key_quotes.sql trim the same set in the stored keys.
 */
const EDGE_CHARS = " .,!?\u2026:;\u00AB\u00BB\"'()\\-\u2013\u2014\u201C\u201D\u201E\u2018\u2019";
const KEY_EDGES = new RegExp(`^[${EDGE_CHARS}]+|[${EDGE_CHARS}]+$`, "g");
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
   * Clears the chosen topic `topicNo`, whose words have all been given, and the read positions, which were stored for
   * the order with that topic. A statement for the batch of a queue read (`queue`, `pre`). Nothing is written when the
   * user has chosen another topic meanwhile.
   */
  clearTopicStmt(userId: number, topicNo: number): D1PreparedStatement {
    return this.db.prepare("UPDATE users SET topic_no = NULL, new_cursors = NULL WHERE id = ?1 AND topic_no = ?2").bind(userId, topicNo);
  }
  /**
   * Checks or unchecks level `no` of the scale for the user, in one UPDATE that looks at the stored set and changes
   * it: of taps that arrive together each changes the set the other left, and the set is never left empty. Nothing
   * is written when the catalog has no card of the level (`hasCards` is false then; so it is for a number off the
   * scale) or when the level is the only one checked. A chosen topic that has no card in the new set of levels is cleared by the same statement. The
   * second statement of the batch reads, for the answer alone, whether the level has cards. One D1 call.
   */
  async toggleLevel(userId: number, no: number): Promise<{ changed: boolean; hasCards: boolean }> {
    const levels = flipped("users.levels", "?2");
    const [write, read] = await this.db.batch<{ has_cards: number }>([
      this.db.prepare(
        `UPDATE users SET levels = ${levels},
           topic_no = CASE WHEN EXISTS (SELECT 1 FROM catalog_groups g WHERE g.topic_no = users.topic_no AND g.total > 0 AND (${levels} >> (g.level - 1)) & 1) THEN topic_no END
         WHERE id = ?1 AND (${levels} & ${ALL_LEVELS}) != 0 AND ${levelHasCards("?3")}`,
      ).bind(userId, levelBit(no), no),
      this.db.prepare(`SELECT ${levelHasCards("?1")} AS has_cards`).bind(no),
    ]);
    return { changed: (write!.meta.changes ?? 0) > 0, hasCards: read!.results[0]!.has_cards === 1 };
  }
  /**
   * Checks level `no` for the user and never unchecks it: one UPDATE that adds the level to the stored set, so a
   * second tap on a button that adds a level, or two taps that arrive together, leave it checked. Nothing is written
   * when the catalog has no card of the level. Returns the set of levels stored after the statement. One D1 call.
   */
  async checkLevel(userId: number, no: number): Promise<number> {
    const [, read] = await this.db.batch<{ levels: number }>([
      this.db.prepare(`UPDATE users SET levels = levels | ?2 WHERE id = ?1 AND ${levelHasCards("?3")}`).bind(userId, levelBit(no), no),
      this.db.prepare("SELECT levels FROM users WHERE id = ?").bind(userId),
    ]);
    return read!.results[0]!.levels;
  }
  /**
   * Checks or unchecks the part-of-speech group at bit index `bit`, in one UPDATE that looks at the stored set and
   * changes it (see `toggleLevel`). False, and nothing written, when the group is the only one checked.
   */
  async togglePosGroup(userId: number, bit: number): Promise<boolean> {
    const groups = flipped("pos_groups", "?2");
    const r = await this.db.prepare(`UPDATE users SET pos_groups = ${groups} WHERE id = ?1 AND (${groups} & ${ALL_POS}) != 0`).bind(userId, 1 << bit).run();
    return (r.meta.changes ?? 0) > 0;
  }
  /**
   * Chooses the topic of the new words, or none (null), in one UPDATE: a topic is taken only when the catalog has a
   * card of it in a level the user has checked — by the stored set of levels. False, and nothing written, when it has none.
   */
  async chooseTopic(userId: number, topicNo: number | null): Promise<boolean> {
    const r = await this.db.prepare(
      `UPDATE users SET topic_no = ?2 WHERE id = ?1
         AND (?2 IS NULL OR EXISTS (SELECT 1 FROM catalog_groups g WHERE g.topic_no = ?2 AND g.total > 0 AND (users.levels >> (g.level - 1)) & 1))`,
    ).bind(userId, topicNo).run();
    return (r.meta.changes ?? 0) > 0;
  }
  /**
   * A write of a step of the introduction that moves the learner on (or ends it): the patch is applied only while the
   * user still stands on `step`. Of answers that arrive together, or after the learner has gone on or studied, only
   * the first changes the row; returns whether this one did.
   */
  async updateOnStep(userId: number, step: string, patch: Partial<Omit<User, "id">>): Promise<boolean> {
    const keys = Object.keys(patch);
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null); });
    const r = await this.db.prepare(`UPDATE users SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE id = ? AND onboarding_step = ?`).bind(...vals, userId, step).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /**
   * Takes one unit of a daily allowance kept in two columns of the user's row (the day and the count of that day),
   * unless `limit` units are already taken on `today`. One statement, so concurrent calls never take more than the limit.
   * `also` is written in the same UPDATE when the unit is taken; when it is not, nothing is written. Returns whether it was taken.
   */
  async takeDailyUnit(userId: number, columns: { day: string; count: string }, today: string, limit: number, also: Partial<Omit<User, "id">> = {}): Promise<boolean> {
    const keys = Object.keys(also);
    const vals = keys.map((k) => { const v = (also as Record<string, unknown>)[k]; return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null); });
    const r = await this.db.prepare(
      `UPDATE users SET ${columns.count} = CASE WHEN ${columns.day} IS ?1 THEN ${columns.count} + 1 ELSE 1 END, ${columns.day} = ?1${keys.map((k, i) => `, ${snake(k)} = ?${i + 4}`).join("")}
       WHERE id = ?2 AND (${columns.day} IS NOT ?1 OR ${columns.count} < ?3)`,
    ).bind(today, userId, limit, ...vals).run();
    return (r.meta.changes ?? 0) > 0;
  }
  /** Gives back one unit taken on `today` (see `takeDailyUnit`). */
  async returnDailyUnit(userId: number, columns: { day: string; count: string }, today: string): Promise<void> {
    await this.db.prepare(`UPDATE users SET ${columns.count} = MAX(0, ${columns.count} - 1) WHERE id = ? AND ${columns.day} = ?`).bind(userId, today).run();
  }
  /**
   * Housekeeping for a batch that runs anyway: previews created before `previewsBefore` (they can no longer be
   * confirmed) and finished jobs done before `jobsBefore` are deleted. Each statement goes by an index
   * (idx_previews_created, idx_jobs_pending) and reads only the rows it deletes.
   */
  purgeStmts(previewsBefore: number, jobsBefore: number): D1PreparedStatement[] {
    return [
      this.db.prepare("DELETE FROM previews WHERE created_at < ?").bind(previewsBefore),
      this.db.prepare("DELETE FROM jobs WHERE done_at < ?").bind(jobsBefore),
    ];
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
  private ownDecksStmt(userId: number): D1PreparedStatement {
    return this.db.prepare("SELECT * FROM decks WHERE owner_id = ? ORDER BY id").bind(userId);
  }
  /** The decks a user owns: «Мои слова» and the AI decks. */
  async ownDecks(userId: number): Promise<DeckRow[]> {
    return (await this.ownDecksStmt(userId).all<Record<string, unknown>>()).results.map((r) => this.rowToDeck(r));
  }
  /** Read through idx_decks_level: the decks of the catalog alone, not those of the learners. */
  private levelDecksStmt(): D1PreparedStatement {
    return this.db.prepare(`SELECT level_no AS level, total, coverage_pct FROM decks WHERE level_no BETWEEN 1 AND ${LEVELS.length} AND kind = 'catalog' ORDER BY level_no`);
  }
  private topicsStmt(): D1PreparedStatement {
    return this.db.prepare("SELECT no, slug, title_ru, title_tt FROM topics ORDER BY no");
  }
  /**
   * What the screens of the levels are built from, in one D1 call: the levels of the scale the catalog has a deck of,
   * by number, with the cards in each and its coverage; what `catalogTotals` and `progress` give; the topics of the
   * catalog, by number; and, with `own`, the decks the user owns (`ownDecks`); without it that list is empty and
   * is not read. Counters only: no note and no card is read, whatever the size of the catalog.
   */
  async levelsData(userId: number, own: boolean): Promise<LevelsData> {
    const [decks, totals, progress, topics, owned] = await this.db.batch<Record<string, unknown>>(
      [this.levelDecksStmt(), this.catalogTotalsStmt(), this.progressRowsStmt(userId), this.topicsStmt(), ...(own ? [this.ownDecksStmt(userId)] : [])],
    );
    return {
      decks: levelDecksOf(decks!.results), totals: pairTotals(totals!.results), progress: pairsStarted(progress!.results), topics: topicRows(topics!.results),
      own: (owned?.results ?? []).map((r) => this.rowToDeck(r)),
    };
  }
  private rowToDeck(r: Record<string, unknown>): DeckRow {
    return { id: r.id as number, slug: (r.slug as string) ?? null, ownerId: (r.owner_id as number) ?? null, kind: r.kind as DeckRow["kind"],
      titleRu: r.title_ru as string, titleTt: r.title_tt as string, levelNo: (r.level_no as number) ?? null,
      coveragePct: (r.coverage_pct as number) ?? null, total: r.total as number };
  }
  /**
   * Adds notes to a deck (a note with the same word key in the deck keeps its id and takes the new spelling) and
   * returns their ids in the order given. A note with `level`, `topicNo` and `seq` is stored as a catalog note with
   * the simple `tseq = topic × TSEQ_BASE + seq`. The real guided order of a level, where basic and themed words
   * alternate, is defined by the catalog seed (content/csv.ts `catalogToSql`, levels/order.ts `guidedTseq`), not by
   * this method: it writes the learners' own words and the fixtures of tests.
   * In the same D1 call, before the notes are written, a catalog word that becomes a copy in a learner's own deck is
   * counted as started for that learner (`ownedCopiesStmt` in db/queue.ts).
   */
  async insertNotes(deckId: number, rows: NoteInput[]): Promise<number[]> {
    if (!rows.length) return [];
    const notes = rows.map((n) =>
      this.db.prepare(
        `INSERT INTO notes (deck_id, word, word_key, transcription, pos, translation, example_tt, example_ru, example_src, audio_file_id, source_url,
                            level, topic_no, seq, tseq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (deck_id, word_key) DO UPDATE SET word = excluded.word RETURNING id`,
      ).bind(deckId, n.word.trim(), wordKey(n.word), n.transcription ?? null, n.pos, n.translation, n.exampleTt, n.exampleRu,
        n.exampleSrc ?? "", n.audioFileId ?? null, n.sourceUrl ?? null,
        n.level ?? null, n.topicNo ?? null, n.seq ?? null,
        n.level != null && n.topicNo != null && n.seq != null ? tseqOf(n.topicNo, n.seq) : null),
    );
    const res = await this.db.batch<{ id: number }>([
      ownedCopiesStmt(this.db, deckId, rows.map((n) => wordKey(n.word))),
      ...notes,
      this.db.prepare("UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = ?1) WHERE id = ?1").bind(deckId),
    ]);
    return res.slice(1, rows.length + 1).map((r) => r.results[0]!.id);
  }
  /** Puts a deck of the user's own among the decks the user learns («Мои слова», an AI deck): the session gives the words of those. */
  async subscribe(userId: number, deckId: number, now: number): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at) VALUES (?, ?, ?)").bind(userId, deckId, now).run();
  }
  /**
   * The notes with these words that the user already learns: one D1 call for many words, keyed by wordKey. A note of a
   * deck of the user's own («Мои слова», an AI deck) is one; a catalog note is one when the user has a card for it —
   * the word was shown. A catalog word that was not shown yet is not: it can be copied (`findCatalogNotes`).
   * When a word is both, the own note wins: the queue shows that one and skips the catalog's.
   * `owned` is true for a note in a deck of the user's own; a catalog note is shared by every learner.
   * Read by the decks of the user and by the word key in the catalog, never by the same word in other learners' decks.
   */
  async findNotesForUser(userId: number, words: string[]): Promise<Map<string, UserNote>> {
    const keys = [...new Set(words.map(wordKey))];
    const out = new Map<string, UserNote>();
    if (!keys.length) return out;
    const cols = `n.id AS id, n.deck_id, n.word_key, ${noteCols("?1", "d.owner_id")}, d.title_ru, d.title_tt`;
    const { results } = await this.db.prepare(
      `SELECT ${cols}, 1 AS owned
       FROM user_decks ud CROSS JOIN decks d ON d.id = ud.deck_id CROSS JOIN json_each(?2) k CROSS JOIN notes n ON n.deck_id = d.id AND n.word_key = k.value
       WHERE ud.user_id = ?1 AND d.owner_id = ?1
       UNION ALL
       SELECT ${cols}, 0
       FROM json_each(?2) k CROSS JOIN notes n INDEXED BY idx_notes_catalog_key ON n.word_key = k.value JOIN decks d ON d.id = n.deck_id
       WHERE n.level IS NOT NULL AND EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ?1 AND c.note_id = n.id)
       ORDER BY owned DESC, id`,
    ).bind(userId, JSON.stringify(keys)).all<Record<string, unknown>>();
    for (const r of results) {
      const k = r.word_key as string;
      if (!out.has(k)) {
        out.set(k, { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, deckTitleRu: r.title_ru as string, deckTitleTt: r.title_tt as string, owned: r.owned === 1 });
      }
    }
    return out;
  }
  /**
   * The reviewed cards of the catalog for these words, of any level, checked or not, each with its level: one D1 call,
   * keyed by wordKey. A word key is one note of the catalog. A catalog note has no link to give.
   */
  async findCatalogNotes(words: string[]): Promise<Map<string, NoteRow & { level: number }>> {
    const keys = [...new Set(words.map(wordKey))];
    const out = new Map<string, NoteRow & { level: number }>();
    if (!keys.length) return out;
    const { results } = await this.db.prepare(
      `SELECT n.id, n.deck_id, n.word_key, ${noteCols(null)}, n.level
       FROM json_each(?) k CROSS JOIN notes n INDEXED BY idx_notes_catalog_key ON n.word_key = k.value WHERE n.level IS NOT NULL`,
    ).bind(JSON.stringify(keys)).all<Record<string, unknown>>();
    for (const r of results) out.set(r.word_key as string, { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, level: r.level as number });
    return out;
  }
  /**
   * The note when the user can see it: it is in a deck of the user's own, or the user has a card for it. A catalog note
   * is the user's to see once it was shown; another learner's own word is not.
   */
  async visibleNote(userId: number, noteId: number): Promise<NoteRow | null> {
    const r = await this.db.prepare(
      `SELECT n.id, n.deck_id, ${noteCols("?2")} FROM notes n WHERE n.id = ?1
       AND (EXISTS (SELECT 1 FROM user_decks ud JOIN decks d ON d.id = ud.deck_id WHERE ud.user_id = ?2 AND ud.deck_id = n.deck_id AND d.owner_id = ?2)
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
  /**
   * The user's cards of one direction by stage: «учу» — in the learning steps or repeated at less than a week,
   * «знаю» — at one to three weeks, «выучено» — at three weeks and more. Over the cards of the user alone; a card
   * that was never graded is in no stage.
   */
  async stageCounts(userId: number, direction: Direction): Promise<{ learned: number; known: number; learning: number }> {
    const r = await this.db.prepare(
      `SELECT COALESCE(SUM(state = 'review' AND scheduled_days >= 21), 0) AS learned,
              COALESCE(SUM(state = 'review' AND scheduled_days BETWEEN 7 AND 20), 0) AS known,
              COALESCE(SUM(state IN ('learning','relearning') OR (state = 'review' AND scheduled_days < 7)), 0) AS learning
       FROM cards WHERE user_id = ? AND direction = ?`,
    ).bind(userId, direction).first<{ learned: number; known: number; learning: number }>();
    return { learned: r!.learned, known: r!.known, learning: r!.learning };
  }
  async getCard(userId: number, cardId: number): Promise<CardRow | null> {
    const r = await this.db.prepare(`SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ? AND c.user_id = ?`)
      .bind(cardId, userId).first<Record<string, unknown>>();
    return r ? rowToCard(r) : null;
  }
  /**
   * A card of the user for the screen of an undo, with its answers since the learner's day began (`dayStartMs`) that were
   * not undone (spec A3), in one query; null when the card is not the user's.
   */
  async cardForGrade(userId: number, cardId: number, dayStartMs: number): Promise<(CardRow & { answersToday: number }) | null> {
    const r = await this.db.prepare(
      `SELECT ${CARD_COLS}, ${answersToday("c", "?3")} AS answers_today FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?1 AND c.user_id = ?2`,
    ).bind(cardId, userId, dayStartMs).first<Record<string, unknown>>();
    return r ? { ...rowToCard(r), answersToday: r.answers_today as number } : null;
  }
  async getCardByNote(userId: number, noteId: number, direction: Direction): Promise<CardRow | null> {
    const r = await this.db.prepare(`SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ? AND c.note_id = ? AND c.direction = ?`)
      .bind(userId, noteId, direction).first<Record<string, unknown>>();
    return r ? rowToCard(r) : null;
  }

  /** Everything the session queue needs, in one D1 call (one batch), after the statements of `pre` in the same batch; see `readQueue` in db/queue.ts. */
  queue(userId: number, w: DayWindow, s: NewScope, pre: D1PreparedStatement[] = []): Promise<Queue> { return readQueue(this.db, userId, w, s, pre); }

  /* progress counters */
  /** The counter of started words, a statement for the batch of a grade; see `progressStmt` in db/queue.ts. */
  progressStmt(userId: number, noteId: number, cardId: number, wasNew: boolean): D1PreparedStatement { return progressStmt(this.db, userId, noteId, cardId, wasNew); }
  /** Takes a started word back, a statement for the batch of an undo; see `unprogressStmt` in db/queue.ts. */
  unprogressStmt(userId: number, cardId: number): D1PreparedStatement { return unprogressStmt(this.db, userId, cardId); }
  private progressRowsStmt(userId: number): D1PreparedStatement {
    return this.db.prepare("SELECT level, topic_no, started FROM user_progress WHERE user_id = ? ORDER BY level, topic_no").bind(userId);
  }
  private catalogTotalsStmt(): D1PreparedStatement {
    return this.db.prepare("SELECT level, topic_no, total FROM catalog_groups ORDER BY level, topic_no");
  }
  private todayLogStmt(userId: number, dayStartMs: number): D1PreparedStatement {
    return this.db.prepare(
      "SELECT COUNT(*) AS reviews, COALESCE(SUM(learned_now), 0) AS learned FROM review_log WHERE user_id = ? AND undone = 0 AND reviewed_at >= ?",
    ).bind(userId, dayStartMs);
  }
  /** How many words the user has started in every pair (level, topic); own words are the pair (0, 0). Pairs with nothing started may be absent. */
  async progress(userId: number): Promise<PairStarted[]> {
    return pairsStarted((await this.progressRowsStmt(userId).all<Record<string, unknown>>()).results);
  }
  /** How many cards the catalog has in every pair (level, topic), as counted when the catalog was loaded. */
  async catalogTotals(): Promise<PairTotal[]> {
    return pairTotals((await this.catalogTotalsStmt().all<Record<string, unknown>>()).results);
  }
  /**
   * What the screen that ends a session reads, in one D1 call: today's grades that were not undone and the words
   * learned today (through idx_log_user_time: only the rows of today), the words that «Снова» or «Трудно» sent to
   * tomorrow today (spec A3: a card on a learning step answered today and due a day or more after that answer; both
   * cards of a word count once) and, with `counters`, what `progress` and `catalogTotals` give — the facts for the
   * reason there are no new words. Without `counters` both lists are empty and are not read.
   */
  async dayEnd(userId: number, dayStartMs: number, counters: boolean): Promise<{ reviewsToday: number; learnedToday: number; postponedToday: number; progress: PairStarted[]; totals: PairTotal[] }> {
    const [log, postponed, started, totals] = await this.db.batch<Record<string, unknown>>([
      this.todayLogStmt(userId, dayStartMs),
      this.db.prepare(
        // Without the hint the planner counts the distinct notes along the unique index of (user_id, note_id,
        // direction), which reads every card of the user; this one reads the cards on a learning step alone.
        `SELECT COUNT(DISTINCT note_id) AS n FROM cards INDEXED BY idx_cards_user_state_due
         WHERE user_id = ? AND state IN ('learning','relearning') AND last_review >= ? AND due - last_review >= 86400000`,
      ).bind(userId, dayStartMs),
      ...(counters ? [this.progressRowsStmt(userId), this.catalogTotalsStmt()] : []),
    ]);
    return {
      ...todayOf(log!.results), postponedToday: postponed!.results[0]!.n as number,
      progress: pairsStarted(started?.results ?? []), totals: pairTotals(totals?.results ?? []),
    };
  }

  /**
   * Cumulative numbers for /stats in one D1 call: the memory held by the cards of one direction — the days of every word on a
   * day rung, as `memoryDays` (srs/ladder.ts) counts them; a word on a minute rung holds none —, the grades in all and in the
   * last 30 days, and the cards due on each of the next 7 days.
   */
  async statsExtra(userId: number, now: number, dayStartMs: number, direction: Direction): Promise<{ memory: number; total: number; r30: number; rev30: number; ok30: number; forecast: { d: number; n: number }[] }> {
    const since = now - 30 * 86_400_000;
    const [a, f] = await this.db.batch<Record<string, number | null>>([
      this.db.prepare(`SELECT
          (SELECT COALESCE(SUM(CASE WHEN state = 'review' THEN scheduled_days ELSE 0 END), 0)
             FROM cards WHERE user_id = ?1 AND direction = ?2) AS memory,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0) AS total,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3) AS r30,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3 AND json_extract(state_before, '$.state') = 'review') AS rev30,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3 AND json_extract(state_before, '$.state') = 'review' AND rating > 1) AS ok30`)
        .bind(userId, direction, since),
      this.db.prepare(`SELECT MAX(0, CAST((due - ?2) / 86400000 AS INTEGER)) AS d, COUNT(*) AS n FROM cards
          WHERE user_id = ?1 AND state != 'new' AND due < ?2 + 7 * 86400000 GROUP BY d`).bind(userId, dayStartMs),
    ]);
    const r = a!.results[0]!;
    return { memory: r.memory!, total: r.total!, r30: r.r30!, rev30: r.rev30!, ok30: r.ok30!, forecast: f!.results.map((x) => ({ d: x.d!, n: x.n! })) };
  }

  /* review log */
  /** The last grade of the user that was not undone. Read backwards through idx_log_user_time, so it stops at the first such row instead of reading the history. */
  async lastReviewLog(userId: number): Promise<ReviewLogRow | null> {
    const r = await this.db.prepare("SELECT * FROM review_log WHERE user_id = ? AND undone = 0 ORDER BY reviewed_at DESC, id DESC LIMIT 1").bind(userId).first<Record<string, unknown>>();
    if (!r) return null;
    return {
      id: r.id as number, cardId: r.card_id as number, userId: r.user_id as number, rating: r.rating as number,
      stateBefore: JSON.parse(r.state_before as string) as Mem, intervalBeforeDays: r.interval_before_days as number,
      intervalAfterMs: r.interval_after_ms as number, reviewedAt: r.reviewed_at as number, wasNew: r.was_new === 1,
      learnedNow: r.learned_now === 1, streakBefore: r.streak_before as number, lastStudyDayBefore: (r.last_study_day_before as string) ?? null, undone: false,
    };
  }
  /**
   * Marks a grade as undone, once: a row is changed only while the grade is not undone yet. Of two undo writes for
   * the same grade the second changes nothing here, and the statement guarded by this one (`unprogressStmt`) does not run.
   */
  markUndoneStmt(logId: number): D1PreparedStatement { return this.db.prepare("UPDATE review_log SET undone = 1 WHERE id = ? AND undone = 0").bind(logId); }

  /* sessions; the column sessions.stale of the first schema is no longer read or written */
  async getSession(userId: number): Promise<Session | null> {
    const r = await this.db.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(userId).first<Record<string, unknown>>();
    return r ? { userId, chatId: r.chat_id as number, messageId: (r.message_id as number) ?? null, cardId: (r.card_id as number) ?? null,
      lastVoiceMessageId: (r.last_voice_message_id as number) ?? null } : null;
  }
  saveSessionStmt(s: Session): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, message_id, card_id, last_voice_message_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id,
       last_voice_message_id = excluded.last_voice_message_id`,
    ).bind(s.userId, s.chatId, s.messageId, s.cardId, s.lastVoiceMessageId);
  }
  async saveSession(s: Session): Promise<void> { await this.saveSessionStmt(s).run(); }
  /** Points the session at a message/card without touching the voice message id. */
  async setSessionMessage(userId: number, chatId: number, messageId: number, cardId: number | null): Promise<void> {
    await this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id`,
    ).bind(userId, chatId, messageId, cardId).run();
  }
  /** Moves the session to a freshly sent message and forgets the old voice message; returns that voice id so it can be deleted. One D1 call. */
  async replaceSessionMessage(userId: number, chatId: number, messageId: number, cardId: number | null): Promise<number | null> {
    const [prev] = await this.db.batch<{ last_voice_message_id: number | null }>([
      this.db.prepare("SELECT last_voice_message_id FROM sessions WHERE user_id = ?").bind(userId),
      this.db.prepare(
        `INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id, last_voice_message_id = NULL`,
      ).bind(userId, chatId, messageId, cardId),
    ]);
    return prev?.results[0]?.last_voice_message_id ?? null;
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
}
