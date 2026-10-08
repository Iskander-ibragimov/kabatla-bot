import { type Direction, Repo } from "../../src/db/repo";
import { guidedTseq } from "../../src/levels/order";
import { LEVELS } from "../../src/levels/scale";
import type { Mem } from "../../src/srs/ladder";

/** A catalog note with its places: `seq` in the order of its level, `tseq` in the guided order of the level. */
export interface CatalogNote { id: number; level: number; topicNo: number; seq: number; tseq: number; pos: string; word: string }

/** The topics 0…20. */
export const TOPIC_COUNT = 21;
/** The eleven part-of-speech codes a card may carry. */
export const POS_CODES = ["n", "v", "adj", "adv", "pron", "num", "post", "part", "conj", "intj", "phr"];

/**
 * How many of the notes are numerals. `even`: one in 11, like every other code. `rare`: one in 55 (70 in the whole
 * catalog), a small part of speech. `sparse`: three a level, at a tenth, a half and nine tenths of it, far apart.
 */
export type Numerals = "even" | "rare" | "sparse";
/** The part of speech of every place of a level for a share of numerals; see `Numerals`. */
export const numeralsAt = (numerals: Numerals) => (i: number, size: number): string =>
  numerals === "even" ? POS_CODES[i % POS_CODES.length]!
    : (numerals === "rare" ? i % 55 === 5 : [0.1, 0.5, 0.9].some((part) => i === Math.floor(size * part))) ? "num" : POS_CODES[i % 5]!;

export interface BulkCatalog {
  /** Notes per level; the sizes of the scale (500 / 850 / 850 / 800 / 850) unless given. A level left out, or of size 0, gets no deck. */
  sizes?: Partial<Record<number, number>>;
  /** The part of speech of the note at place `i` (from 0) of a level of `size` notes; the eleven codes in turn unless given. */
  pos?: (i: number, size: number) => string;
  /** The topic of the note at place `i`; the topics 0…20 in turn unless given. */
  topic?: (i: number) => number;
}

/**
 * Catalog notes in bulk, one statement a level: the decks a1…c1, the words `сүз<level>х<place>` in the order of the
 * level, the guided order the catalog seed gives (`guidedTseq`: basic words among the themed ones), and
 * `catalog_groups` in step. Returns the notes by level and place.
 */
export async function bulkCatalog(db: D1Database, o: BulkCatalog = {}): Promise<CatalogNote[]> {
  const repo = new Repo(db);
  const topicAt = o.topic ?? ((i: number) => i % TOPIC_COUNT);
  const posAt = o.pos ?? ((i: number) => POS_CODES[i % POS_CODES.length]!);
  for (const lv of LEVELS) {
    const size = o.sizes ? (o.sizes[lv.no] ?? 0) : lv.size;
    if (!size) continue;
    const deckId = await repo.insertDeck({ slug: lv.slug, kind: "catalog", titleRu: lv.code, titleTt: lv.code, levelNo: lv.no, coveragePct: null, ownerId: null });
    const tseq = guidedTseq(Array.from({ length: size }, (_, i) => ({ topicNo: topicAt(i), seq: i + 1 })));
    const rows = Array.from({ length: size }, (_, i) => ({ w: `сүз${lv.no}х${i + 1}`, p: posAt(i, size), t: topicAt(i), s: i + 1, q: tseq[i]! }));
    await db.batch([
      db.prepare(
        `INSERT INTO notes (deck_id, word, word_key, pos, translation, example_tt, example_ru, example_src, level, topic_no, seq, tseq)
         SELECT ?1, j.value ->> 'w', j.value ->> 'w', j.value ->> 'p', (j.value ->> 'w') || '-ru', (j.value ->> 'w') || '.', (j.value ->> 'w') || '-ru.', 'own',
                ?2, j.value ->> 't', j.value ->> 's', j.value ->> 'q' FROM json_each(?3) j ORDER BY j.key`,
      ).bind(deckId, lv.no, JSON.stringify(rows)),
      db.prepare("UPDATE decks SET total = ?2 WHERE id = ?1").bind(deckId, size),
      db.prepare("INSERT INTO catalog_groups (level, topic_no, total) SELECT level, topic_no, COUNT(*) FROM notes WHERE level = ? GROUP BY level, topic_no").bind(lv.no),
    ]);
  }
  const { results } = await db.prepare("SELECT id, level, topic_no AS topicNo, seq, tseq, pos, word FROM notes WHERE level IS NOT NULL ORDER BY level, seq").all<CatalogNote>();
  return results;
}

/** A card to write: the note, the direction, the memory and the day it was hidden on (null: not hidden). */
export type CardSeed = [noteId: number, direction: Direction, mem: Mem, buriedDay: string | null];

/** Cards of a user written straight into the table, two thousand to a statement. */
export async function bulkCards(db: D1Database, userId: number, rows: CardSeed[]): Promise<void> {
  const json = rows.map(([n, d, m, b]) => ({ n, d, st: m.state, sp: m.step, sb: m.stability, df: m.difficulty, du: m.due, lr: m.lastReview, sd: m.scheduledDays, rp: m.reps, lp: m.lapses, b }));
  for (let i = 0; i < json.length; i += 2000) {
    await db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, step, stability, difficulty, due, last_review, scheduled_days, reps, lapses, buried_day)
       SELECT ?1, j.value ->> 'n', j.value ->> 'd', j.value ->> 'st', j.value ->> 'sp', j.value ->> 'sb', j.value ->> 'df', j.value ->> 'du', j.value ->> 'lr',
              j.value ->> 'sd', j.value ->> 'rp', j.value ->> 'lp', j.value ->> 'b' FROM json_each(?2) j`,
    ).bind(userId, JSON.stringify(json.slice(i, i + 2000))).run();
  }
}
