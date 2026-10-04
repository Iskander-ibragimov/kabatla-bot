import { STREAM_LIMIT, type Spans } from "../levels/order";
import { type NewMode, tseqOf } from "../levels/scale";
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
  Partial<Pick<NoteFields, "exampleSrc" | "audioFileId" | "sourceUrl">> & {
    /** Catalog position: only catalog notes have it; own and AI notes leave all three out. */
    level?: number; topicNo?: number; seq?: number;
  };
export interface NoteRow extends NoteFields { id: number; deckId: number }
/** A note of a deck the user is subscribed to, with the titles of that deck; `owned`: the deck is the user's own, not a level. */
export interface UserNote extends NoteRow { deckTitleRu: string; deckTitleTt: string; owned: boolean }
export interface CardRow extends NoteFields { id: number; noteId: number; direction: Direction; mem: Mem; buriedDay: string | null }
export interface NewNote extends NoteFields { noteId: number; direction: Direction }
/** `newAvailable`: how many new cards the queue found, as many as `newNotes` holds: zero means the open decks have none for today. */
export interface QueueCounts { learning: number; review: number; newAvailable: number; newDoneToday: number; easyNewToday: number }
export interface Candidates { learning: CardRow[]; review: CardRow[]; newNotes: NewNote[]; counts: QueueCounts }
/**
 * Which catalog words may come as new ones: the checked levels, the card codes of the checked part-of-speech groups
 * (null: all), the order, the chosen topic, and the read positions per level (`Span`) with the catalog version they
 * were stored for; a position stored for another version is not used.
 */
export interface NewScope { levels: number[]; posCodes: string[] | null; mode: NewMode; topicNo: number | null; spans: Spans; spansVersion: number }
/** A new card of a catalog note that has no row yet, with the place of the note in its level. */
export interface CatalogNew extends NewNote { level: number; topicNo: number; seq: number }
/** What a stream of one level held: the order values of its first and last note (`tseq` by topic, `seq` in `freq`), and whether it is as long as a stream gets. */
export interface StreamSeen { first: number | null; last: number | null; full: boolean }
/** Everything the session queue needs; see `Repo.queue`. */
export interface Queue {
  learning: CardRow[]; review: CardRow[];
  ownNew: NewNote[]; newRows: NewNote[];
  streams: Partial<Record<number, CatalogNew[]>>;
  seen: Partial<Record<number, StreamSeen>>;
  counts: { learning: number; review: number; newDoneToday: number; easyNewToday: number };
  catalogVersion: number; hasCards: boolean;
}
/** One level of the catalog as a user sees it; `seen` counts the notes that were started or are skipped as copies of own words, in an open level; 0 for a closed one. */
export interface LevelRow { levelNo: number; total: number; coveragePct: number | null; open: boolean; seen: number }
export interface DayWindow { dayStartMs: number; dayEndMs: number; today: string; directions: Direction[]; limitEach?: number }
export interface Session { userId: number; chatId: number; messageId: number | null; cardId: number | null; lastVoiceMessageId: number | null }
export interface DeckRow {
  id: number; slug: string | null; ownerId: number | null; kind: "catalog" | "ai" | "custom";
  titleRu: string; titleTt: string; levelNo: number | null; coveragePct: number | null; total: number;
}
export interface ReviewLogRow {
  id: number; cardId: number; userId: number; rating: number; stateBefore: Mem; intervalBeforeDays: number; intervalAfterMs: number;
  reviewedAt: number; wasNew: boolean; learnedNow: boolean; streakBefore: number; lastStudyDayBefore: string | null; undone: boolean;
}

/** The catalog has levels 1…LAST_LEVEL; `users.level` one above it means every level is done. A deck with a higher number is not a level. */
export const LAST_LEVEL = 20;

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
/** True when the user owns a note with the word_key of `note`, in «Мои слова» or an AI deck. */
const ownsWord = (user: string, note = "n") =>
  `EXISTS (SELECT 1 FROM notes o JOIN decks od ON od.id = o.deck_id WHERE od.owner_id = ${user} AND o.word_key = ${note}.word_key)`;
/** True for a word of a level (`note` in the catalog deck `deck`) when the user owns a note with the same word_key: such a level word counts as shown. */
const ownedCopy = (user: string, deck = "dk", note = "n") => `(${deck}.kind = 'catalog' AND ${ownsWord(user, note)})`;
/** A card of the note was started: it is in any state but 'new'. */
const started = (user: string, noteId: string) => `EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ${user} AND c.note_id = ${noteId} AND c.state != 'new')`;
/** 1 when a card of this direction was started, over the cards `c` of one note. */
const startedIn = (direction: Direction) => `COALESCE(MAX(c.direction = '${direction}' AND c.state != 'new'), 0)`;
/**
 * The directions a user asks for, as SQL: `tt` and `ru` are expressions that give 1 when the user learns tt_ru and
 * ru_tt cards, else 0; `today` is the user's local day, the day a buried card stays hidden.
 */
export interface Asked { today: string; tt: string; ru: string }
/** True for a card `f` of a direction the user asks for. */
const askedDirection = (f: string, a: Asked) => `((${f}.direction = 'tt_ru' AND ${a.tt}) OR (${f}.direction = 'ru_tt' AND ${a.ru}))`;
/** The cards of a user that were never graded, read through the partial index of migration 0007 (alias `f`). */
const NEW_CARDS = "cards f INDEXED BY idx_cards_user_new";
/** True when the note has a card of this direction that was never graded (state 'new'). */
const hasNewRow = (user: string, noteId: string, direction: Direction) =>
  `EXISTS (SELECT 1 FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.note_id = ${noteId} AND f.direction = '${direction}' AND f.state = 'new')`;
/** True when the note has a card of this direction, in any state. Answered by the index of UNIQUE (user_id, note_id, direction) alone. */
const hasRow = (user: string, noteId: string, direction: Direction) =>
  `EXISTS (SELECT 1 FROM cards r WHERE r.user_id = ${user} AND r.note_id = ${noteId} AND r.direction = '${direction}')`;
/** True unless a card of the note was hidden for today: the grade of one card of a word buries the word until tomorrow. */
const wordNotBuried = (user: string, noteId: string, a: Asked) =>
  `NOT EXISTS (SELECT 1 FROM cards b WHERE b.user_id = ${user} AND b.note_id = ${noteId} AND b.buried_day IS ${a.today})`;
/**
 * A scalar subquery: 1 when a direction the user asks for has no card at all for this note, in any state. Such a
 * note is not buried either: the grade that buries a word makes sure both of its cards exist. Index only.
 */
export const lacksCard = (user: string, noteId: string, a: Asked) =>
  `(SELECT COALESCE(MAX(r.direction = 'tt_ru'), 0) < ${a.tt} OR COALESCE(MAX(r.direction = 'ru_tt'), 0) < ${a.ru} FROM cards r WHERE r.user_id = ${user} AND r.note_id = ${noteId})`;
/** A one-row table `(id)`: the last (`DESC`) or the first (`ASC`) note of the deck that is not a level word the user owns a copy of; no row when there is none. */
const edgeNote = (user: string, deck: string, order: "ASC" | "DESC") =>
  `(SELECT x.id FROM notes x WHERE x.deck_id = ${deck}.id AND NOT ${ownedCopy(user, deck, "x")} ORDER BY x.id ${order} LIMIT 1)`;
/**
 * How the queue finds the new cards without reading every open deck. Two facts hold for every deck and each direction:
 *
 * 1. New cards are given in the order of the note ids, and a card is passed over only while its word is buried for
 *    the day. The grade that buries a word creates its other card (state 'new') when it does not exist. So a card
 *    that was passed over is always a row in state 'new': if a card of some direction is started, every card of
 *    that direction earlier in the deck is either started too or is such a row. (An undone grade leaves a row in
 *    state 'new' as well.) Cards are never deleted.
 * 2. Hence the cards of a direction that have no row at all lie behind the last started card of that direction.
 *
 * So a deck has two kinds of cards to give: rows in state 'new', found in the index idx_cards_user_new by the ids of
 * the deck's notes (`newRowIn`), and cards without a row, found by walking the deck from its end (`tailOpenIn`).
 * The walk needs one note for a deck that is finished or untouched, and never more than the notes graded today
 * plus the cards waiting in state 'new' at the end of the deck.
 *
 * `tailOpenIn`: 1 when the deck has a card of this direction that has no row yet. The walk goes from the last note
 * backwards, passes the notes whose card of this direction is a row in state 'new' and the level words the user owns
 * a copy of, and stops at the first other note: that note either has no card of this direction — then the deck has
 * such cards, and this one can be given today — or its card is started, and then by (1) every card of this direction
 * that is still to give in this deck is a row in state 'new'. Read through idx_notes_deck.
 */
const tailOpenIn = (user: string, deck: string, direction: Direction, a: Asked) =>
  `COALESCE((SELECT NOT ${hasRow(user, "x.id", direction)} FROM notes x WHERE x.deck_id = ${deck}.id
      AND CASE WHEN ${hasNewRow(user, "x.id", direction)} THEN 0 WHEN ${hasRow(user, "x.id", direction)} THEN 1
               ELSE NOT ${ownedCopy(user, deck, "x")} AND ${wordNotBuried(user, "x.id", a)} END
    ORDER BY x.id DESC LIMIT 1), 0)`;
/** 1 when the deck has a card without a row in a direction the user asks for (see `tailOpenIn`): the deck must be read note by note. */
const tailOpen = (user: string, deck: string, a: Asked) =>
  `CASE WHEN (CASE WHEN ${a.tt} THEN ${tailOpenIn(user, deck, "tt_ru", a)} ELSE 0 END) THEN 1 WHEN ${a.ru} THEN ${tailOpenIn(user, deck, "ru_tt", a)} ELSE 0 END`;
/** True for a card `f` of a note of this deck or of a note whose id lies between the ids of its notes: two rows of idx_notes_deck give the bounds. */
const inNoteRange = (f: string, deck: string) =>
  `${f}.note_id >= (SELECT MIN(x.id) FROM notes x WHERE x.deck_id = ${deck}.id) AND ${f}.note_id <= (SELECT MAX(x.id) FROM notes x WHERE x.deck_id = ${deck}.id)`;
/** True when the user has a card in state 'new' in a direction the user asks for, in whatever deck: without one no deck needs `newRowIn`. */
const anyNewRow = (user: string, a: Asked) =>
  `EXISTS (SELECT 1 FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.state = 'new' AND ${askedDirection("f", a)})`;
/**
 * A deck whose note ids are not one run — words typed over months, a level that got a word later — has the notes of
 * other decks between its first and its last note. Up to this many rows in state 'new' between them are read from the
 * index; when there are more (a learner who switched to both directions late has one for every word repeated since),
 * the deck is read note by note instead, so the cost is bounded by the deck and not by the cards of other decks.
 */
const MANY_NEW_ROWS = 50;
/** True when the user has more than MANY_NEW_ROWS cards in state 'new' between the first and the last note of the deck. Index only. */
const manyNewRowsIn = (user: string, deck: string) =>
  `(SELECT COUNT(*) FROM (SELECT 1 FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.state = 'new' AND ${inNoteRange("f", deck)} LIMIT ${MANY_NEW_ROWS + 1})) > ${MANY_NEW_ROWS}`;
/**
 * True when the deck has a row in state 'new' that can be given today: a card of a direction the user asks for whose
 * word is not buried today and is not a level word the user owns a copy of. The index is read between the smallest
 * and the largest id of the deck's notes, and a card of another deck whose note id falls in between is recognised by
 * its note and passed. The first MANY_NEW_ROWS + 1 rows are tried; when none of them will do and there are more
 * (`manyNewRowsIn`), the notes of the deck are asked one by one instead.
 */
const newRowIn = (user: string, deck: string, a: Asked) => {
  const ok = `${askedDirection("f", a)} AND ${wordNotBuried(user, "fn.id", a)} AND NOT ${ownedCopy(user, deck, "fn")}`;
  const first = `(SELECT f.note_id, f.direction FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.state = 'new' AND ${inNoteRange("f", deck)} ORDER BY f.note_id, f.direction LIMIT ${MANY_NEW_ROWS + 1})`;
  return `CASE WHEN EXISTS (SELECT 1 FROM ${first} f CROSS JOIN notes fn ON fn.id = f.note_id WHERE fn.deck_id = ${deck}.id AND ${ok}) THEN 1
    WHEN ${manyNewRowsIn(user, deck)}
    THEN EXISTS (SELECT 1 FROM notes fn CROSS JOIN ${NEW_CARDS} ON f.user_id = ${user} AND f.note_id = fn.id AND f.state = 'new' WHERE fn.deck_id = ${deck}.id AND ${ok})
    ELSE 0 END`;
};
/** True while the deck has a new card the user can be given today; see `tailOpenIn` for why these two questions are enough. */
const hasNewToday = (user: string, deck: string, a: Asked) =>
  `CASE WHEN (CASE WHEN ${anyNewRow(user, a)} THEN ${newRowIn(user, deck, a)} ELSE 0 END) THEN 1 ELSE ${tailOpen(user, deck, a)} END`;
/**
 * 1 when the new cards of the deck are found by reading it note by note: it has cards without a row (`tailOpen`), or
 * so many rows in state 'new' lie between its notes that reading them is no cheaper. 0: its new cards are all rows in
 * state 'new', few enough to be read from the index.
 */
const readWhole = (user: string, deck: string, a: Asked) => `CASE WHEN ${manyNewRowsIn(user, deck)} THEN 1 ELSE ${tailOpen(user, deck, a)} END`;
/**
 * For the reminder: true while the last note of the deck (level words the user owns a copy of aside) has no card in a
 * direction the user asks for — the deck has words that were never shown that way. The cards that already exist in
 * state 'new' are counted apart, by `newCardRows`.
 */
export const deckHasUnshown = (user: string, deck: string, a: Asked) =>
  `EXISTS (SELECT 1 FROM ${edgeNote(user, deck, "DESC")} l WHERE ${lacksCard(user, "l.id", a)})`;
/**
 * How many of the last `limit` notes of the deck have no card in a direction the user asks for: the words of the deck
 * that were never shown that way, counted up to `limit`. An estimate for the reminder: a level word the user owns a
 * copy of is counted too, while `deckHasUnshown` makes sure the deck has at least one such word.
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
/** Subscribes user ?1 to the deck of the level the user is on now, at time ?2; nothing when the catalog has no such deck or the user is past the last level. */
const OPEN_CURRENT_LEVEL =
  `INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at) SELECT u.id, d.id, ?2 FROM users u JOIN decks d ON d.level_no = u.level AND d.level_no <= ${LAST_LEVEL} WHERE u.id = ?1`;
/** A card `c` with its note `n`; the viewer of the note is the user the card belongs to. */
const CARD_COLS = `c.id, c.note_id, c.direction, c.state, c.step, c.stability, c.difficulty, c.due, c.last_review, c.scheduled_days, c.reps, c.lapses, c.buried_day, ${noteCols("c.user_id")}`;

/**
 * The new cards of the user's decks for today, a statement of its own: one row per note, with `seen_tt` and `seen_ru`
 * telling which of its directions are started. `ownOnly`: only the decks that have an owner («Мои слова» and the AI
 * decks); otherwise every deck the user is subscribed to, the own ones first and then the levels by number.
 * `user`, `a` and `limit` are bind markers (or literals): the user, the asked directions with the user's day, and
 * the most notes to give.
 *
 * `todo`: the decks that have a new card for today. `work`: the own decks among them and the lowest such level;
 * `whole`: the deck is read note by note (the first half of `fresh`), otherwise its new cards are all rows in state
 * 'new' and only their notes are read (the second half); see `readWhole`. A level word the user already owns (same
 * word_key in a deck with owner_id = user) counts as shown and is skipped.
 */
const newInDecks = (user: string, a: Asked, limit: string, ownOnly: boolean) => {
  const cols = `n.id AS note_id, ${noteCols(user, "dk.owner_id")}, ${startedIn("tt_ru")} AS seen_tt, ${startedIn("ru_tt")} AS seen_ru,
            (dk.kind = 'catalog') AS level_deck, COALESCE(dk.level_no, 0) AS level_no`;
  const open = `GROUP BY n.id HAVING COALESCE(MAX(c.buried_day IS ${a.today}), 0) = 0 AND (seen_tt < ${a.tt} OR seen_ru < ${a.ru})`;
  return `WITH todo AS MATERIALIZED (
          SELECT dk.id, dk.kind, dk.level_no FROM user_decks ud JOIN decks dk ON dk.id = ud.deck_id
          WHERE ud.user_id = ${user}${ownOnly ? " AND dk.owner_id IS NOT NULL" : ""} AND ${hasNewToday(user, "dk", a)}),
        work AS MATERIALIZED (
          SELECT t.id, ${readWhole(user, "t", a)} AS whole FROM todo t
          WHERE t.level_no IS NULL OR t.level_no = (SELECT MIN(level_no) FROM todo)),
        fresh AS (
          SELECT ${cols}
          FROM work w CROSS JOIN notes n ON n.deck_id = w.id JOIN decks dk ON dk.id = n.deck_id LEFT JOIN cards c ON c.user_id = ${user} AND c.note_id = n.id
          WHERE w.whole AND NOT ${ownedCopy(user)}
          ${open}
          UNION ALL
          SELECT ${cols}
          FROM work w CROSS JOIN ${NEW_CARDS} ON f.user_id = ${user} AND f.state = 'new' AND ${inNoteRange("f", "w")}
            CROSS JOIN notes n ON n.id = f.note_id JOIN decks dk ON dk.id = n.deck_id LEFT JOIN cards c ON c.user_id = ${user} AND c.note_id = n.id
          WHERE NOT w.whole AND n.deck_id = w.id AND NOT ${ownedCopy(user)}
          ${open})
        SELECT * FROM fresh ORDER BY level_deck, level_no, note_id LIMIT ${limit}`;
};

/** An upper bound of an order value that bounds nothing: the largest integer SQLite holds. */
const NO_END = "9223372036854775807";
/** How many cards in state 'new' one read of the queue takes from the index: more than a learner is given before the next read. */
const NEW_ROWS_LIMIT = 20;
/** The bound values of one statement, in order: `p(v)` binds `v` and gives its marker `?N`, which may be used many times. */
function binder() {
  const values: unknown[] = [];
  return { values, p: (v: unknown) => { values.push(v); return `?${values.length}`; } };
}

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
/** One new card for every direction of `directions`, in that order, whose flag column (`tt`, `ru`: 1 when the note needs no card of that direction) is 0. */
function newCardsOf(rows: Record<string, unknown>[], directions: Direction[], tt: string, ru: string): NewNote[] {
  return rows.flatMap((r) => directions
    .filter((d) => r[d === "tt_ru" ? tt : ru] === 0)
    .map((direction): NewNote => ({ ...noteFields(r), noteId: r.note_id as number, direction })));
}
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
  /** The decks a user owns: «Мои слова» and the AI decks. */
  async ownDecks(userId: number): Promise<DeckRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM decks WHERE owner_id = ? ORDER BY id").bind(userId).all<Record<string, unknown>>();
    return results.map((r) => this.rowToDeck(r));
  }
  /**
   * Every level of the catalog with the user's progress in it, in one D1 call.
   * `seen` is counted note by note only for an open level the user is in the middle of. A word is seen once one of
   * its cards is started, in either direction, and words are given in the order of their ids — a word is passed over
   * only on the day it was graded, when it is seen already. So the seen words of a level are its beginning: a level
   * whose last note is started is seen whole, and one whose first note is not started has nothing seen but the words
   * the user owns a copy of; those are counted for all levels at once, from the user's own notes. A closed level is
   * not looked into. (One case is off by a word for a day: a first grade that was taken back and not given again
   * leaves the word hidden until tomorrow, when the session gives it first.) This is about words; the cards of the
   * second direction, which do get started out of order, are the business of `candidateCards`.
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
         WHERE dk.level_no <= ${LAST_LEVEL} ORDER BY dk.level_no`,
      ).bind(userId),
      this.db.prepare(
        `SELECT n.deck_id, COUNT(DISTINCT n.id) AS owned FROM decks od JOIN notes o ON o.deck_id = od.id
           JOIN notes n ON n.word_key = o.word_key JOIN decks dk ON dk.id = n.deck_id
         WHERE od.owner_id = ?1 AND dk.kind = 'catalog' AND dk.level_no <= ${LAST_LEVEL} GROUP BY n.deck_id`,
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
      `SELECT id, level_no FROM decks WHERE level_no <= ${LAST_LEVEL}
       ORDER BY (level_no <= ?1) DESC, CASE WHEN level_no <= ?1 THEN -level_no ELSE level_no END LIMIT 1`,
    ).bind(placed).first<{ id: number; level_no: number }>();
    return r ? { deckId: r.id, levelNo: r.level_no } : null;
  }
  /** Opens every level below the user's current one; returns how many were opened. */
  async openSkippedLevels(userId: number, now: number): Promise<number> {
    const r = await this.db.prepare(
      `INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at)
       SELECT u.id, d.id, ?2 FROM users u JOIN decks d ON d.level_no < u.level AND d.level_no <= ${LAST_LEVEL} WHERE u.id = ?1`,
    ).bind(userId, now).run();
    return r.meta.changes ?? 0;
  }
  /**
   * Opens the level that follows `from`: the next level the catalog has (the smallest `level_no` above `from`, up to
   * `last`), so a gap in the catalog is stepped over. Three statements for one batch: the level change, which returns
   * the new level; the subscription to the deck of that level, made only when the level changed; and the coverage and
   * the number of words of `from` for the announcement.
   * The level change touches a row only if the user is still on `from`, so only one of several concurrent calls gets
   * the new level back; and only if the deck of `from` is open for the user or does not exist — a current level that
   * was never opened is opened first, see `openCurrentLevelStmt`. While no higher level exists nothing changes, except
   * on the last level: from there the user moves to `last + 1`, which means every level is done.
   */
  openLevelStmts(userId: number, from: number, last: number, now: number): D1PreparedStatement[] {
    const next = "(SELECT MIN(level_no) FROM decks WHERE level_no > ?1 AND level_no <= ?2)";
    const currentClosed = "EXISTS (SELECT 1 FROM decks d WHERE d.level_no = ?1 AND d.level_no <= ?2 AND NOT EXISTS (SELECT 1 FROM user_decks ud WHERE ud.user_id = ?3 AND ud.deck_id = d.id))";
    return [
      this.db.prepare(`UPDATE users SET level = COALESCE(${next}, ?2 + 1) WHERE id = ?3 AND level = ?1 AND (?1 = ?2 OR ${next} IS NOT NULL) AND NOT ${currentClosed} RETURNING level`).bind(from, last, userId),
      this.db.prepare(`${OPEN_CURRENT_LEVEL} AND changes() = 1`).bind(userId, now),
      this.db.prepare("SELECT coverage_pct, total FROM decks WHERE level_no = ?").bind(from),
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
        `INSERT INTO notes (deck_id, word, word_key, transcription, pos, translation, example_tt, example_ru, example_src, audio_file_id, source_url,
                            level, topic_no, seq, tseq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (deck_id, word_key) DO UPDATE SET word = excluded.word RETURNING id`,
      ).bind(deckId, n.word.trim(), wordKey(n.word), n.transcription ?? null, n.pos, n.translation, n.exampleTt, n.exampleRu,
        n.exampleSrc ?? "", n.audioFileId ?? null, n.sourceUrl ?? null,
        n.level ?? null, n.topicNo ?? null, n.seq ?? null,
        n.level != null && n.topicNo != null && n.seq != null ? tseqOf(n.topicNo, n.seq) : null),
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
  /**
   * The notes with these words in the decks the user is subscribed to: one D1 call for many words, keyed by wordKey.
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
       WHERE d.kind = 'catalog' AND d.level_no <= ${LAST_LEVEL} AND n.word_key IN (SELECT value FROM json_each(?)) ORDER BY d.level_no, n.id`,
    ).bind(JSON.stringify(keys)).all<Record<string, unknown>>();
    for (const r of results) {
      const k = r.word_key as string;
      if (!out.has(k)) out.set(k, { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, levelNo: r.level_no as number });
    }
    return out;
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
   * current one is the last (LAST_LEVEL), after which the user is done with the levels.
   *
   * New cards come in this order: own and AI decks first, then the levels by number; inside a deck by note id, and the
   * directions of a note in the order of `w.directions`. A card is new while it was never graded, whatever was started
   * around it: with both directions the card of a word that was buried for a day is given on a later day.
   * Only the decks that can hold the next new cards are read: the own decks that have a new card for today and the
   * lowest such open level; the levels below it have none today and the levels above it wait for their turn. So
   * `newNotes` are the next new cards, but not all of them when the level in work is near its end and another open
   * level follows. A deck has a new card for today when it has a card without a row (`tailOpen`) or a row in state
   * 'new' whose word is not buried today (`newRowIn`); a card that is only buried for today is not given today and
   * does not count: when the open decks have nothing else, `newAvailable` is 0 and the next level may open.
   */
  async candidateCards(userId: number, w: DayWindow, pre: D1PreparedStatement[] = []): Promise<Candidates & { pre: D1Result<Record<string, unknown>>[]; currentLevelClosed: boolean; nextLevelExists: boolean }> {
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
      this.db.prepare(newInDecks("?1", asked, "?5", false))
        .bind(userId, w.today, w.directions.includes("tt_ru") ? 1 : 0, w.directions.includes("ru_tt") ? 1 : 0, lim),
      this.db.prepare(`SELECT
          (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND c.state IN ('learning','relearning') AND c.direction IN (SELECT value FROM json_each(?2)) AND n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)) AS learning,
          (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND c.state = 'review' AND c.due < ?3 AND c.direction IN (SELECT value FROM json_each(?2)) AND (c.buried_day IS NULL OR c.buried_day != ?4) AND n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)) AS review,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND was_new = 1 AND rating < 4 AND undone = 0 AND reviewed_at >= ?5) AS new_done_today,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND was_new = 1 AND rating = 4 AND undone = 0 AND reviewed_at >= ?5) AS easy_new_today,
          EXISTS (SELECT 1 FROM users u JOIN decks dk ON dk.level_no = u.level AND dk.level_no <= ${LAST_LEVEL} WHERE u.id = ?1 AND NOT EXISTS (SELECT 1 FROM user_decks ud WHERE ud.user_id = ?1 AND ud.deck_id = dk.id)) AS level_closed,
          EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND (u.level = ${LAST_LEVEL} OR EXISTS (SELECT 1 FROM decks d WHERE d.level_no > u.level AND d.level_no <= ${LAST_LEVEL}))) AS next_level`)
        .bind(userId, dirs, w.dayEndMs, w.today, w.dayStartMs),
    ]);
    const [learning, review, fresh, counts] = res.slice(pre.length);
    const c = counts!.results[0]!;
    const newNotes = newCardsOf(fresh!.results, w.directions, "seen_tt", "seen_ru").slice(0, lim);
    return {
      pre: res.slice(0, pre.length),
      currentLevelClosed: c.level_closed === 1,
      nextLevelExists: c.next_level === 1,
      learning: learning!.results.map(rowToCard),
      review: review!.results.map(rowToCard),
      newNotes,
      counts: { learning: c.learning as number, review: c.review as number, newAvailable: newNotes.length, newDoneToday: c.new_done_today as number, easyNewToday: c.easy_new_today as number },
    };
  }

  /**
   * Everything the session queue needs, in one D1 call (one batch).
   *
   * `learning`, `review`: the cards to repeat — every card of the user in the asked directions, whatever deck or level
   * its note is in: a started word is repeated whatever is checked.
   *
   * New cards come from three places; the caller gives them in this order:
   * - `ownNew`: the words of the decks the user owns («Мои слова», AI decks), in the order of the note ids. No setting of
   *   the scope applies to them.
   * - `newRows`: the cards of catalog notes that exist in state 'new' — the reverse card of a word (it was created when
   *   the other card was graded) and a card that was shown and not graded. They belong to words the learner has met,
   *   so they are given whatever the scope is; up to NEW_ROWS_LIMIT, in the order of the note ids.
   * - `streams[level]`: for every level of the scope, the first STREAM_LIMIT notes that lack a card row in an asked
   *   direction, in the order of the mode (`seq` in `freq`, `tseq` otherwise), with one card for every such
   *   direction in the order of `w.directions`. `seen[level]` tells where that stream began and ended, for the read
   *   position of the level (levels/order.ts `nextSpans`).
   *
   * A stream is read from the index of its order, from the read position of the level on, and stops at its last
   * note; see `streamStmt`. In `topic` with no topic chosen there are no new catalog words: no stream is read, and
   * `streams` and `seen` are empty. `freq` takes no notice of a topic.
   *
   * A stream holds no filter on words hidden for today, and must not get one. A word is hidden by the grade of one of
   * its cards, and that grade creates the other card; so a hidden word has both its cards, is in no stream, and comes
   * back through `newRows` on a later day — a note that lacks a card is never hidden. A filter here could only
   * shorten a stream by words that are hidden for a day, and a stream shorter than STREAM_LIMIT says that nothing
   * lies beyond its last note: the level would look finished from there on.
   *
   * `counts`: how many cards there are to repeat (the lists are cut at `w.limitEach`, the counts are not) and how many
   * new cards were graded today, those graded «Легко» counted apart. `hasCards`: the user has a card at all.
   */
  async queue(userId: number, w: DayWindow, s: NewScope): Promise<Queue> {
    const lim = w.limitEach ?? 50;
    const stmt = (sql: (p: (v: unknown) => string) => string) => {
      const b = binder();
      return this.db.prepare(sql(b.p)).bind(...b.values);
    };
    /** The asked directions as SQL: literals, so a statement binds only what it reads. */
    const asked = (today: string): Asked => ({ today, tt: w.directions.includes("tt_ru") ? "1" : "0", ru: w.directions.includes("ru_tt") ? "1" : "0" });
    const inAsked = askedDirection("c", asked("NULL"));
    const levels = s.mode === "topic" && s.topicNo == null ? [] : s.levels;
    const res = await this.db.batch<Record<string, unknown>>([
      stmt((p) => `SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id
        WHERE c.user_id = ${p(userId)} AND c.state IN ('learning','relearning') AND ${inAsked} ORDER BY c.due LIMIT ${p(lim)}`),
      stmt((p) => `SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id
        WHERE c.user_id = ${p(userId)} AND c.state = 'review' AND c.due < ${p(w.dayEndMs)} AND ${inAsked} AND c.buried_day IS NOT ${p(w.today)} ORDER BY c.due LIMIT ${p(lim)}`),
      stmt((p) => newInDecks(p(userId), asked(p(w.today)), p(lim), true)),
      // A card hidden today is passed on its own row. Whether the word is hidden (its other card may be the hidden
      // one, after a grade was taken back) and whether the user owns a copy of it are asked after the note is known
      // to be a catalog note: a card of an own word, which is given by `ownNew`, costs its row and its note here.
      stmt((p) => {
        const user = p(userId);
        const a = asked(p(w.today));
        return `SELECT f.note_id, f.direction, ${noteCols(null)} FROM ${NEW_CARDS} CROSS JOIN notes n ON n.id = f.note_id
          WHERE f.user_id = ${user} AND f.state = 'new' AND ${askedDirection("f", a)} AND f.buried_day IS NOT ${a.today} AND n.level IS NOT NULL
            AND ${wordNotBuried(user, "n.id", a)} AND NOT ${ownsWord(user)}
          ORDER BY f.note_id, f.direction LIMIT ${NEW_ROWS_LIMIT}`;
      }),
      ...levels.map((level) => this.streamStmt(userId, w.directions, s, level)),
      stmt((p) => {
        const user = p(userId);
        const due = `c.user_id = ${user} AND c.state = 'review' AND c.due < ${p(w.dayEndMs)} AND ${inAsked} AND c.buried_day IS NOT ${p(w.today)}`;
        return `SELECT
          (SELECT COUNT(*) FROM cards c WHERE c.user_id = ${user} AND c.state IN ('learning','relearning') AND ${inAsked}) AS learning,
          (SELECT COUNT(*) FROM cards c WHERE ${due}) AS review,
          l.new_done, l.easy_new,
          (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_version') AS catalog_version,
          EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ${user}) AS has_cards
        FROM (SELECT COALESCE(SUM(rating < 4), 0) AS new_done, COALESCE(SUM(rating = 4), 0) AS easy_new FROM review_log
              WHERE user_id = ${user} AND was_new = 1 AND undone = 0 AND reviewed_at >= ${p(w.dayStartMs)}) l`;
      }),
    ]);
    const [learning, review, own, rows] = res;
    const c = res[res.length - 1]!.results[0]!;
    const place = (d: Direction) => w.directions.indexOf(d);
    const streams: Queue["streams"] = {};
    const seen: Queue["seen"] = {};
    levels.forEach((level, i) => {
      const notes = res[4 + i]!.results;
      streams[level] = notes.flatMap((r) => newCardsOf([r], w.directions, "has_tt", "has_ru")
        .map((n): CatalogNew => ({ ...n, level: r.level as number, topicNo: r.topic_no as number, seq: r.seq as number })));
      seen[level] = { first: (notes[0]?.ord as number) ?? null, last: (notes[notes.length - 1]?.ord as number) ?? null, full: notes.length === STREAM_LIMIT };
    });
    return {
      learning: learning!.results.map(rowToCard),
      review: review!.results.map(rowToCard),
      ownNew: newCardsOf(own!.results, w.directions, "seen_tt", "seen_ru").slice(0, lim),
      // The index gives the directions of a note in the order of their names; the caller asked for an order of its own.
      newRows: rows!.results.map((r): NewNote => ({ ...noteFields(r), noteId: r.note_id as number, direction: r.direction as Direction }))
        .sort((x, y) => x.noteId - y.noteId || place(x.direction) - place(y.direction)),
      streams, seen,
      counts: { learning: c.learning as number, review: c.review as number, newDoneToday: c.new_done as number, easyNewToday: c.easy_new as number },
      catalogVersion: (c.catalog_version as number) ?? 0,
      hasCards: c.has_cards === 1,
    };
  }

  /**
   * The stream of one level: its first STREAM_LIMIT notes, in the order of the mode, that lack a card row in an asked
   * direction, are of the asked parts of speech and are not words the user owns a copy of. One row per note; `ord` is
   * its order value, `has_tt` and `has_ru` tell which of its cards exist.
   *
   * The notes are walked in the index of the order — idx_notes_level_seq in `freq`, idx_notes_level_tseq otherwise —
   * between the bounds that the read position of the level and the chosen topic give: order values above `from` and,
   * when it is known, up to `to`; in a topic, the order values of that topic. Both bounds are one expression each, so
   * the index is entered at the nearer one and nothing before it is read. A read position counts only while the
   * catalog is the one it was stored for; otherwise the whole level (or topic) is walked.
   *
   * The conditions are asked in the order of what they read, as D1 counts rows. The part of speech comes first: the
   * row of a note counts as one with its index row. Then whether a card is lacking: one exact look into the index of
   * the cards for every asked direction, which reads a row only when that card exists. Whether the user owns the
   * word is asked last, of the few notes that are left. So a note that is passed costs one row, and one more for
   * each card it has when it is of an asked part of speech.
   *
   * What a read costs is therefore the notes between the read position and the last note of the stream. That is a
   * handful when the scope is dense. It grows when the asked parts of speech are few in a level and far apart, up
   * to the whole level when the stream ends at its far end: only an index that holds the part of speech would
   * bound that.
   */
  private streamStmt(userId: number, directions: Direction[], s: NewScope, level: number): D1PreparedStatement {
    const b = binder();
    const user = b.p(userId);
    const freq = s.mode === "freq";
    const ord = freq ? "n.seq" : "n.tseq";
    const span = s.spans[level];
    const topic = freq ? null : s.topicNo;
    const lo: string[] = [];
    const hi: string[] = [];
    if (topic != null) { lo.push(b.p(tseqOf(topic, 0))); hi.push(b.p(tseqOf(topic + 1, 0) - 1)); }
    if (span) {
      const current = `(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_version') = ${b.p(s.spansVersion)}`;
      lo.push(`CASE WHEN ${current} THEN ${b.p(span.from)} ELSE 0 END`);
      if (span.to != null) hi.push(`CASE WHEN ${current} THEN ${b.p(span.to)} ELSE ${NO_END} END`);
    }
    const one = (parts: string[], pick: "MAX" | "MIN") => (parts.length > 1 ? `${pick}(${parts.join(", ")})` : parts[0]);
    const otherPos = s.posCodes ? `WHEN n.pos NOT IN (${s.posCodes.map((code) => b.p(code)).join(", ")}) THEN 0` : "";
    const hasAllCards = directions.map((d) => hasRow(user, "n.id", d)).join(" AND ") || "1";
    return this.db.prepare(
      `SELECT n.id AS note_id, n.level, n.topic_no, n.seq, ${ord} AS ord, ${noteCols(null)},
         ${hasRow(user, "n.id", "tt_ru")} AS has_tt, ${hasRow(user, "n.id", "ru_tt")} AS has_ru
       FROM notes n INDEXED BY ${freq ? "idx_notes_level_seq" : "idx_notes_level_tseq"}
       WHERE n.level = ${b.p(level)} AND ${ord} > ${one(lo, "MAX") ?? "0"}${hi.length ? ` AND ${ord} <= ${one(hi, "MIN")}` : ""}
         AND CASE ${otherPos} WHEN ${hasAllCards} THEN 0 ELSE NOT ${ownsWord(user)} END
       ORDER BY ${ord} LIMIT ${STREAM_LIMIT}`,
    ).bind(...b.values);
  }

  /* progress counters */
  /**
   * The counter of started words, a statement for the batch of a grade, placed after a guarded statement: it runs only
   * when that one changed a row (SQLite changes()). It adds 1 to the user's counter of the pair (level, topic) of the
   * note — (0, 0) for an own word — when this grade is the first of the word: the card was new (`wasNew`) and the
   * note has no other card outside state 'new'. Otherwise it adds 0, and still writes: whenever the guard passes it
   * changes exactly one row, so the guarded statement that follows it runs as well.
   */
  progressStmt(userId: number, noteId: number, cardId: number, wasNew: boolean): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO user_progress (user_id, level, topic_no, started)
       SELECT ?1, COALESCE(n.level, 0), COALESCE(n.topic_no, 0),
              ?4 AND NOT EXISTS (SELECT 1 FROM cards o WHERE o.user_id = ?1 AND o.note_id = n.id AND o.id != ?3 AND o.state != 'new')
       FROM notes n WHERE n.id = ?2 AND changes() = 1
       ON CONFLICT (user_id, level, topic_no) DO UPDATE SET started = started + excluded.started`,
    ).bind(userId, noteId, cardId, wasNew ? 1 : 0);
  }
  /**
   * Takes a started word back, for the batch of an undo, after the statement that restores the card: 1 is taken from
   * the counter of the pair of the card's note, never below 0, when no card of the note is outside state 'new' any
   * more — the undone grade was the first of the word. Nothing changes when the word is still started.
   */
  unprogressStmt(userId: number, cardId: number): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE user_progress SET started = MAX(0, started - 1)
       WHERE user_id = ?1
         AND (level, topic_no) = (SELECT COALESCE(n.level, 0), COALESCE(n.topic_no, 0) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?2 AND c.user_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM cards c JOIN cards o ON o.user_id = c.user_id AND o.note_id = c.note_id WHERE c.id = ?2 AND o.state != 'new')`,
    ).bind(userId, cardId);
  }
  /** How many words the user has started in every pair (level, topic); own words are the pair (0, 0). Pairs with nothing started may be absent. */
  async progress(userId: number): Promise<{ level: number; topicNo: number; started: number }[]> {
    const { results } = await this.db.prepare("SELECT level, topic_no, started FROM user_progress WHERE user_id = ? ORDER BY level, topic_no")
      .bind(userId).all<{ level: number; topic_no: number; started: number }>();
    return results.map((r) => ({ level: r.level, topicNo: r.topic_no, started: r.started }));
  }
  /** How many cards the catalog has in every pair (level, topic), as counted when the catalog was loaded. */
  async catalogTotals(): Promise<{ level: number; topicNo: number; total: number }[]> {
    const { results } = await this.db.prepare("SELECT level, topic_no, total FROM catalog_groups ORDER BY level, topic_no")
      .all<{ level: number; topic_no: number; total: number }>();
    return results.map((r) => ({ level: r.level, topicNo: r.topic_no, total: r.total }));
  }
  /** Today's grades that were not undone and the words learned today. Read through idx_log_user_time: only the rows of today. */
  async todayLog(userId: number, dayStartMs: number): Promise<{ reviewsToday: number; learnedToday: number }> {
    const r = await this.db.prepare(
      "SELECT COUNT(*) AS reviews, COALESCE(SUM(learned_now), 0) AS learned FROM review_log WHERE user_id = ? AND undone = 0 AND reviewed_at >= ?",
    ).bind(userId, dayStartMs).first<{ reviews: number; learned: number }>();
    return { reviewsToday: r!.reviews, learnedToday: r!.learned };
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
          (SELECT d.coverage_pct FROM decks d JOIN users u ON u.id = ?1 WHERE d.level_no < u.level AND d.level_no <= ${LAST_LEVEL} ORDER BY d.level_no DESC LIMIT 1) AS coverage`)
        .bind(userId, direction, since),
      this.db.prepare(`SELECT MAX(0, CAST((due - ?2) / 86400000 AS INTEGER)) AS d, COUNT(*) AS n FROM cards
          WHERE user_id = ?1 AND state != 'new' AND due < ?2 + 7 * 86400000 GROUP BY d`).bind(userId, dayStartMs),
    ]);
    const r = a!.results[0]!;
    return { memory: r.memory!, total: r.total!, r30: r.r30!, rev30: r.rev30!, ok30: r.ok30!, coveragePct: r.coverage ?? null, forecast: f!.results.map((x) => ({ d: x.d!, n: x.n! })) };
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
  markUndoneStmt(logId: number): D1PreparedStatement { return this.db.prepare("UPDATE review_log SET undone = 1 WHERE id = ?").bind(logId); }

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
