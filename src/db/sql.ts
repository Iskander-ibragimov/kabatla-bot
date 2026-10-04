/**
 * What the repo (db/repo.ts) and the session queue (db/queue.ts) share: the shapes of a note and of a card as they are
 * read, the pieces of SQL both build their statements from, and the mapping of a row to those shapes.
 */
import type { CardState, Mem } from "../srs/fsrs";

export type Direction = "tt_ru" | "ru_tt";
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
export interface CardRow extends NoteFields { id: number; noteId: number; direction: Direction; mem: Mem; buriedDay: string | null }
export interface NewNote extends NoteFields { noteId: number; direction: Direction }

/**
 * The columns of a note `n` as `viewer` may read them. `viewer` is an SQL expression for the id of the user the row is read for
 * (a bind marker or a column), or null when the row is read for nobody in particular.
 * The link of a note is read only when the note's deck is owned by the viewer: a link belongs to the learner who typed it,
 * and whatever stands in `source_url` of a level note, which every learner sees, is read as NULL.
 */
export const noteCols = (viewer: string | null, owner = "(SELECT owner_id FROM decks WHERE id = n.deck_id)") =>
  "n.word, n.transcription, n.pos, n.translation, n.example_tt, n.example_ru, n.example_src, n.audio_file_id, " +
  (viewer === null ? "NULL" : `CASE WHEN ${owner} = ${viewer} THEN n.source_url END`) + " AS source_url";
/** True when the user owns a note with the word_key of `note`, in «Мои слова» or an AI deck. */
export const ownsWord = (user: string, note = "n") =>
  `EXISTS (SELECT 1 FROM notes o JOIN decks od ON od.id = o.deck_id WHERE od.owner_id = ${user} AND o.word_key = ${note}.word_key)`;
/** True for a word of a level (`note` in the catalog deck `deck`) when the user owns a note with the same word_key: such a level word counts as shown. */
export const ownedCopy = (user: string, deck = "dk", note = "n") => `(${deck}.kind = 'catalog' AND ${ownsWord(user, note)})`;
/**
 * The directions a user asks for, as SQL: `tt` and `ru` are expressions that give 1 when the user learns tt_ru and
 * ru_tt cards, else 0; `today` is the user's local day, the day a buried card stays hidden.
 */
export interface Asked { today: string; tt: string; ru: string }
/** True for a card `f` of a direction the user asks for. */
export const askedDirection = (f: string, a: Asked) => `((${f}.direction = 'tt_ru' AND ${a.tt}) OR (${f}.direction = 'ru_tt' AND ${a.ru}))`;
/** The cards of a user that were never graded, read through the partial index of migration 0007 (alias `f`). */
export const NEW_CARDS = "cards f INDEXED BY idx_cards_user_new";
/** True when the note has a card of this direction that was never graded (state 'new'). */
export const hasNewRow = (user: string, noteId: string, direction: Direction) =>
  `EXISTS (SELECT 1 FROM ${NEW_CARDS} WHERE f.user_id = ${user} AND f.note_id = ${noteId} AND f.direction = '${direction}' AND f.state = 'new')`;
/** True when the note has a card of this direction, in any state. Answered by the index of UNIQUE (user_id, note_id, direction) alone. */
export const hasRow = (user: string, noteId: string, direction: Direction) =>
  `EXISTS (SELECT 1 FROM cards r WHERE r.user_id = ${user} AND r.note_id = ${noteId} AND r.direction = '${direction}')`;
/** True unless a card of the note was hidden for today: the grade of one card of a word buries the word until tomorrow. */
export const wordNotBuried = (user: string, noteId: string, a: Asked) =>
  `NOT EXISTS (SELECT 1 FROM cards b WHERE b.user_id = ${user} AND b.note_id = ${noteId} AND b.buried_day IS ${a.today})`;
/** A card `c` with its note `n`; the viewer of the note is the user the card belongs to. */
export const CARD_COLS = `c.id, c.note_id, c.direction, c.state, c.step, c.stability, c.difficulty, c.due, c.last_review, c.scheduled_days, c.reps, c.lapses, c.buried_day, ${noteCols("c.user_id")}`;

export function noteFields(r: Record<string, unknown>): NoteFields {
  return {
    word: r.word as string, transcription: (r.transcription as string) ?? null, pos: (r.pos as string) ?? "", translation: r.translation as string,
    exampleTt: (r.example_tt as string) ?? "", exampleRu: (r.example_ru as string) ?? "", exampleSrc: (r.example_src as string) ?? "",
    audioFileId: (r.audio_file_id as string) ?? null, sourceUrl: (r.source_url as string) ?? null,
  };
}
export function rowToCard(r: Record<string, unknown>): CardRow {
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
