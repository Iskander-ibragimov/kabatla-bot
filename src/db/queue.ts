/**
 * The session queue: what a learner repeats and which new cards come next, read in one D1 call (`readQueue`), and the
 * statements that keep the counters of started words in step with it: with the grades (`progressStmt`,
 * `unprogressStmt`) and with the words a learner adds (`ownedCopiesStmt`). `Repo` gives out `queue`, `progressStmt`
 * and `unprogressStmt` as its methods and runs `ownedCopiesStmt` in `insertNotes`.
 *
 * What the counters count (`user_progress`, by level and topic). A catalog word is started for a learner when one of
 * its cards has left state 'new', or when the learner owns a note with its word key («Мои слова», an AI deck): the
 * queue never gives such a word (`ownsWord`), so it is not a word left in its level. Each catalog word counts once.
 * An own note counts under the pair (0, 0), by its cards alone. The catalog seed counts the same (content/csv.ts).
 */
import { STREAM_LIMIT, type Spans } from "../levels/order";
import { type NewMode, tseqOf } from "../levels/scale";
import {
  type Asked, CARD_COLS, type CardRow, type Direction, NEW_CARDS, type NewNote, askedDirection, hasNewRow, hasRow, noteCols, noteFields, ownsWord, rowToCard,
  wordNotBuried,
} from "./sql";

export interface DayWindow { dayStartMs: number; dayEndMs: number; today: string; directions: Direction[]; limitEach?: number }
/**
 * Which catalog words may come as new ones: the checked levels, the card codes of the checked part-of-speech groups
 * (null: all), the order, the chosen topic, and the read positions per level (`Span`) with the catalog version they
 * were stored for; a position stored for another version is not used.
 */
export interface NewScope { levels: number[]; posCodes: string[] | null; mode: NewMode; topicNo: number | null; spans: Spans; spansVersion: number }
/** A new card of a catalog note that has no row yet, with the places of the note in its level: `seq` in the order of the level, `tseq` in its guided order. */
export interface CatalogNew extends NewNote { level: number; topicNo: number; seq: number; tseq: number }
/**
 * What a stream of one level held: the order values of its first and last note (`tseq` by topic, `seq` in `freq`), and
 * whether it is as long as a stream gets (STREAM_LIMIT notes): then more may lie beyond its last note.
 */
export interface StreamSeen { first: number | null; last: number | null; full: boolean }
/** Everything the session queue needs; see `readQueue`. */
export interface Queue {
  learning: CardRow[]; review: CardRow[];
  ownNew: NewNote[]; newRows: NewNote[];
  streams: Partial<Record<number, CatalogNew[]>>;
  seen: Partial<Record<number, StreamSeen>>;
  counts: { learning: number; review: number; newDoneToday: number; easyNewToday: number };
  catalogVersion: number; hasCards: boolean;
}

/** 1 when a card of this direction was started, over the cards `c` of one note. */
const startedIn = (direction: Direction) => `COALESCE(MAX(c.direction = '${direction}' AND c.state != 'new'), 0)`;
/**
 * How the queue finds the new cards of the decks a learner owns («Мои слова», the AI decks) without reading every such
 * deck whole. Two facts hold for every one of them and each direction:
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
 * backwards, passes the notes whose card of this direction is a row in state 'new', and stops at the first other
 * note: that note either has no card of this direction — then the deck has such cards, and this one can be given
 * today — or its card is started, and then by (1) every card of this direction that is still to give in this deck is
 * a row in state 'new'. Read through idx_notes_deck.
 */
const tailOpenIn = (user: string, deck: string, direction: Direction, a: Asked) =>
  `COALESCE((SELECT NOT ${hasRow(user, "x.id", direction)} FROM notes x WHERE x.deck_id = ${deck}.id
      AND CASE WHEN ${hasNewRow(user, "x.id", direction)} THEN 0 WHEN ${hasRow(user, "x.id", direction)} THEN 1
               ELSE ${wordNotBuried(user, "x.id", a)} END
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
 * A deck whose note ids are not one run — words typed over months — has the notes of other decks between its first
 * and its last note. Up to this many rows in state 'new' between them are read from the index; when there are more
 * (a learner who switched to both directions late has one for every word repeated since), the deck is read note by
 * note instead, so the cost is bounded by the deck and not by the cards of other decks.
 */
const MANY_NEW_ROWS = 50;
/** True when the user has more than MANY_NEW_ROWS cards in state 'new' between the first and the last note of the deck. Index only. */
const manyNewRowsIn = (user: string, deck: string) =>
  `(SELECT COUNT(*) FROM (SELECT 1 FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.state = 'new' AND ${inNoteRange("f", deck)} LIMIT ${MANY_NEW_ROWS + 1})) > ${MANY_NEW_ROWS}`;
/**
 * True when the deck has a row in state 'new' that can be given today: a card of a direction the user asks for whose
 * word is not buried today. The index is read between the smallest and the largest id of the deck's notes, and a
 * card of another deck whose note id falls in between is recognised by its note and passed. The first
 * MANY_NEW_ROWS + 1 rows are tried; when none of them will do and there are more (`manyNewRowsIn`), the notes of the
 * deck are asked one by one instead.
 */
const newRowIn = (user: string, deck: string, a: Asked) => {
  const ok = `${askedDirection("f", a)} AND ${wordNotBuried(user, "fn.id", a)}`;
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
 * The new cards of the decks the user owns («Мои слова» and the AI decks) for today, a statement of its own: one row
 * per note, in the order of the note ids, with `seen_tt` and `seen_ru` telling which of its directions are started.
 * `user`, `a` and `limit` are bind markers (or literals): the user, the asked directions with the user's day, and
 * the most notes to give.
 *
 * `todo`: the own decks that have a new card for today. `work`: the same decks with `whole`: the deck is read note by
 * note (the first half of `fresh`), otherwise its new cards are all rows in state 'new' and only their notes are read
 * (the second half); see `readWhole`.
 */
const newInOwnDecks = (user: string, a: Asked, limit: string) => {
  const cols = `n.id AS note_id, ${noteCols(user, "dk.owner_id")}, ${startedIn("tt_ru")} AS seen_tt, ${startedIn("ru_tt")} AS seen_ru`;
  const open = `GROUP BY n.id HAVING COALESCE(MAX(c.buried_day IS ${a.today}), 0) = 0 AND (seen_tt < ${a.tt} OR seen_ru < ${a.ru})`;
  return `WITH todo AS MATERIALIZED (
          SELECT dk.id FROM user_decks ud JOIN decks dk ON dk.id = ud.deck_id
          WHERE ud.user_id = ${user} AND dk.owner_id IS NOT NULL AND ${hasNewToday(user, "dk", a)}),
        work AS MATERIALIZED (SELECT t.id, ${readWhole(user, "t", a)} AS whole FROM todo t),
        fresh AS (
          SELECT ${cols}
          FROM work w CROSS JOIN notes n ON n.deck_id = w.id JOIN decks dk ON dk.id = n.deck_id LEFT JOIN cards c ON c.user_id = ${user} AND c.note_id = n.id
          WHERE w.whole
          ${open}
          UNION ALL
          SELECT ${cols}
          FROM work w CROSS JOIN ${NEW_CARDS} ON f.user_id = ${user} AND f.state = 'new' AND ${inNoteRange("f", "w")}
            CROSS JOIN notes n ON n.id = f.note_id JOIN decks dk ON dk.id = n.deck_id LEFT JOIN cards c ON c.user_id = ${user} AND c.note_id = n.id
          WHERE NOT w.whole AND n.deck_id = w.id
          ${open})
        SELECT * FROM fresh ORDER BY note_id LIMIT ${limit}`;
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
/** One new card for every direction of `directions`, in that order, whose flag column (`tt`, `ru`: 1 when the note needs no card of that direction) is 0. */
function newCardsOf(rows: Record<string, unknown>[], directions: Direction[], tt: string, ru: string): NewNote[] {
  return rows.flatMap((r) => directions
    .filter((d) => r[d === "tt_ru" ? tt : ru] === 0)
    .map((direction): NewNote => ({ ...noteFields(r), noteId: r.note_id as number, direction })));
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
 * - `streams[level]`: for every level of the scope, the first STREAM_LIMIT notes (one: the head of the level) that
 *   lack a card row in an asked direction, in the order of the mode — `seq`, the order of the level, in `freq`;
 *   `tseq`, the guided order of the level (levels/order.ts `guidedTseq`), otherwise — with one card for every such
 *   direction in the order of `w.directions`. `seen[level]` tells where that stream began and ended, for the read
 *   position of the level (`nextSpans`).
 *
 * A stream is read from the index of its order, from the read position of the level on, and stops at its last
 * note; see `streamStmt`. With a topic chosen (`topic`, or `guided` with a topic) only the words of that topic are
 * given, in the guided order; the basic words that stand in the run of a themed topic are not words of it. In
 * `topic` with no topic chosen there are no new catalog words: no stream is read, and `streams` and `seen` are
 * empty. `freq` takes no notice of a topic.
 *
 * A stream holds no filter on words hidden for today, and must not get one. A word is hidden by the grade of one of
 * its cards, and that grade creates the other card; so a hidden word has both its cards, is in no stream, and comes
 * back through `newRows` on a later day — a note that lacks a card is never hidden. A filter here could only
 * shorten a stream by words that are hidden for a day, and a stream shorter than STREAM_LIMIT says that nothing
 * lies beyond it: the level would look finished, and its read position would say so until the scope changes.
 *
 * `counts`: how many cards there are to repeat (the lists are cut at `w.limitEach`, the counts are not) and how many
 * new cards were graded today, those graded «Легко» counted apart. `hasCards`: the user has a card at all.
 *
 * `pre`: statements that run first in the same batch — a write the read is to see, at no D1 call of its own.
 */
export async function readQueue(db: D1Database, userId: number, w: DayWindow, s: NewScope, pre: D1PreparedStatement[] = []): Promise<Queue> {
  const lim = w.limitEach ?? 50;
  const stmt = (sql: (p: (v: unknown) => string) => string) => {
    const b = binder();
    return db.prepare(sql(b.p)).bind(...b.values);
  };
  /** The asked directions as SQL: literals, so a statement binds only what it reads. */
  const asked = (today: string): Asked => ({ today, tt: w.directions.includes("tt_ru") ? "1" : "0", ru: w.directions.includes("ru_tt") ? "1" : "0" });
  const inAsked = askedDirection("c", asked("NULL"));
  const levels = s.mode === "topic" && s.topicNo == null ? [] : s.levels;
  const all = await db.batch<Record<string, unknown>>([
    ...pre,
    stmt((p) => `SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id
      WHERE c.user_id = ${p(userId)} AND c.state IN ('learning','relearning') AND ${inAsked} ORDER BY c.due LIMIT ${p(lim)}`),
    stmt((p) => `SELECT ${CARD_COLS} FROM cards c JOIN notes n ON n.id = c.note_id
      WHERE c.user_id = ${p(userId)} AND c.state = 'review' AND c.due < ${p(w.dayEndMs)} AND ${inAsked} AND c.buried_day IS NOT ${p(w.today)} ORDER BY c.due LIMIT ${p(lim)}`),
    stmt((p) => newInOwnDecks(p(userId), asked(p(w.today)), p(lim))),
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
    ...levels.map((level) => streamStmt(db, userId, w.directions, s, level)),
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
  const res = all.slice(pre.length);
  const [learning, review, own, rows] = res;
  const c = res[res.length - 1]!.results[0]!;
  const place = (d: Direction) => w.directions.indexOf(d);
  const streams: Queue["streams"] = {};
  const seen: Queue["seen"] = {};
  levels.forEach((level, i) => {
    const notes = res[4 + i]!.results;
    streams[level] = notes.flatMap((r) => newCardsOf([r], w.directions, "has_tt", "has_ru")
      .map((n): CatalogNew => ({ ...n, level: r.level as number, topicNo: r.topic_no as number, seq: r.seq as number, tseq: r.tseq as number })));
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
 * when it is known, up to `to`; for a themed topic (1–20), the range of order values of that topic's run, in
 * which all its words stand. Both bounds are one expression each, so the index is entered at the nearer one and
 * nothing before it is read. A read position counts only while the catalog is the one it was stored for;
 * otherwise the whole level (or run) is walked. The basic words (topic 0) have no range of their own: they are
 * spread over the runs of the themed topics, and the level is walked for them.
 *
 * The conditions are asked in the order of what they read, as D1 counts rows. The topic and the part of speech
 * come first: the row of a note counts as one with its index row. Then whether a card is lacking: one exact look into the index of
 * the cards for every asked direction, which reads a row only when that card exists. Whether the user owns the
 * word is asked last, of the few notes that are left. So a note that is passed costs one row, and one more for
 * each card it has when it is of the asked topic and part of speech.
 *
 * What a read costs is therefore the notes between the read position and the note the stream gives. While the
 * head of the level stays, that is the head alone. When the head was started, the next read walks on to the next
 * note of the scope — far, when the words of the scope are few in the level, and to the end of the level when
 * there is none left; but never further, and only once: the caller stores the position that read finds.
 */
function streamStmt(db: D1Database, userId: number, directions: Direction[], s: NewScope, level: number): D1PreparedStatement {
  const b = binder();
  const user = b.p(userId);
  const freq = s.mode === "freq";
  const ord = freq ? "n.seq" : "n.tseq";
  const span = s.spans[level];
  const topic = freq ? null : s.topicNo;
  const lo: string[] = [];
  const hi: string[] = [];
  if (topic != null && topic >= 1) { lo.push(b.p(tseqOf(topic, 0))); hi.push(b.p(tseqOf(topic + 1, 0) - 1)); }
  if (span) {
    const current = `(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'catalog_version') = ${b.p(s.spansVersion)}`;
    lo.push(`CASE WHEN ${current} THEN ${b.p(span.from)} ELSE 0 END`);
    if (span.to != null) hi.push(`CASE WHEN ${current} THEN ${b.p(span.to)} ELSE ${NO_END} END`);
  }
  const one = (parts: string[], pick: "MAX" | "MIN") => (parts.length > 1 ? `${pick}(${parts.join(", ")})` : parts[0]);
  const otherTopic = topic != null ? `WHEN n.topic_no IS NOT ${b.p(topic)} THEN 0` : "";
  const otherPos = s.posCodes ? `WHEN n.pos NOT IN (${s.posCodes.map((code) => b.p(code)).join(", ")}) THEN 0` : "";
  const hasAllCards = directions.map((d) => hasRow(user, "n.id", d)).join(" AND ") || "1";
  return db.prepare(
    `SELECT n.id AS note_id, n.level, n.topic_no, n.seq, n.tseq, ${ord} AS ord, ${noteCols(null)},
       ${hasRow(user, "n.id", "tt_ru")} AS has_tt, ${hasRow(user, "n.id", "ru_tt")} AS has_ru
     FROM notes n INDEXED BY ${freq ? "idx_notes_level_seq" : "idx_notes_level_tseq"}
     WHERE n.level = ${b.p(level)} AND ${ord} > ${one(lo, "MAX") ?? "0"}${hi.length ? ` AND ${ord} <= ${one(hi, "MIN")}` : ""}
       AND CASE ${otherTopic} ${otherPos} WHEN ${hasAllCards} THEN 0 ELSE NOT ${ownsWord(user)} END
     ORDER BY ${ord} LIMIT ${STREAM_LIMIT}`,
  ).bind(...b.values);
}

/**
 * The counter of started words, a statement for the batch of a grade, placed after a guarded statement: it runs only
 * when that one changed a row (SQLite changes()). It adds 1 to the user's counter of the pair (level, topic) of the
 * note — (0, 0) for an own word — when this grade starts the word: the card was new (`wasNew`), the note has no
 * other card outside state 'new', and it is not a catalog word the user owns a copy of — that one is counted since
 * the copy was made (`ownedCopiesStmt`). Otherwise it adds 0, and still writes: whenever the guard passes it
 * changes exactly one row, so the guarded statement that follows it runs as well.
 */
export function progressStmt(db: D1Database, userId: number, noteId: number, cardId: number, wasNew: boolean): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO user_progress (user_id, level, topic_no, started)
     SELECT ?1, COALESCE(n.level, 0), COALESCE(n.topic_no, 0),
            ?4 AND NOT EXISTS (SELECT 1 FROM cards o WHERE o.user_id = ?1 AND o.note_id = n.id AND o.id != ?3 AND o.state != 'new')
               AND NOT (n.level IS NOT NULL AND ${ownsWord("?1")})
     FROM notes n WHERE n.id = ?2 AND changes() = 1
     ON CONFLICT (user_id, level, topic_no) DO UPDATE SET started = started + excluded.started`,
  ).bind(userId, noteId, cardId, wasNew ? 1 : 0);
}
/**
 * Takes a started word back, for the batch of an undo. It runs directly after `markUndoneStmt` and only when that
 * one changed a row (SQLite changes()), so one grade is taken back once however many undo writes arrive for it; the
 * statement that restores the card stands before both: `[updateCardStmt, markUndoneStmt, unprogressStmt, …]`.
 * 1 is taken from the counter of the pair of the card's note, never below 0, when no card of the note is outside
 * state 'new' any more — the undone grade was the first of the word. Nothing changes when the word is still started:
 * by another card, or, a catalog word, by a copy the user owns.
 */
export function unprogressStmt(db: D1Database, userId: number, cardId: number): D1PreparedStatement {
  return db.prepare(
    `UPDATE user_progress SET started = MAX(0, started - 1)
     WHERE user_id = ?1
       AND (level, topic_no) = (SELECT COALESCE(n.level, 0), COALESCE(n.topic_no, 0) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?2 AND c.user_id = ?1)
       AND NOT EXISTS (SELECT 1 FROM cards c JOIN cards o ON o.user_id = c.user_id AND o.note_id = c.note_id WHERE c.id = ?2 AND o.state != 'new')
       AND NOT EXISTS (SELECT 1 FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.id = ?2 AND n.level IS NOT NULL AND ${ownsWord("?1")})
       AND changes() = 1`,
  ).bind(userId, cardId);
}
/**
 * For the batch that adds notes with the word keys `keys` to deck `deckId`, placed before their INSERTs. When the
 * deck is a learner's own, every catalog word among the keys that is not yet started for that learner — no card of
 * it outside state 'new', and no own note with its key before this batch — becomes started by the copy: 1 is added
 * to the learner's counter of its pair. Nothing is written for a deck of the catalog, for a word the catalog does
 * not have, or for a word that is counted already. The word key is unique in the catalog, so a key is one word.
 */
export function ownedCopiesStmt(db: D1Database, deckId: number, keys: string[]): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO user_progress (user_id, level, topic_no, started)
     SELECT dk.owner_id, n.level, COALESCE(n.topic_no, 0), COUNT(*)
     FROM decks dk CROSS JOIN json_each(?2) k CROSS JOIN notes n INDEXED BY idx_notes_catalog_key ON n.word_key = k.value
     WHERE dk.id = ?1 AND dk.owner_id IS NOT NULL AND n.level IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = dk.owner_id AND c.note_id = n.id AND c.state != 'new')
       AND NOT ${ownsWord("dk.owner_id")}
     GROUP BY n.level, COALESCE(n.topic_no, 0)
     ON CONFLICT (user_id, level, topic_no) DO UPDATE SET started = started + excluded.started`,
  ).bind(deckId, JSON.stringify([...new Set(keys)]));
}
