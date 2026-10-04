import { wordKey } from "../db/repo";
import { guidedTseq } from "../levels/order";

/** RFC 4180 CSV parser (quotes, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export function toCsv(header: string[], rows: Record<string, string | null | undefined>[]): string {
  const cell = (v: string | null | undefined) => {
    const s = v ?? "";
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
}

/** One level file of the catalog, as the seed loads it: the deck of the level and its rows in learning order. */
export interface SeedLevel { level: number; slug: string; titleRu: string; titleTt: string; coveragePct: number | null; rows: Record<string, string>[] }

/** A topic of data/topics.csv. */
export interface SeedTopic { no: number; slug: string; titleRu: string; titleTt: string }

/** A headword that was corrected: the catalog note stored under `oldWord` becomes `newWord` (data/renames.csv). */
export interface Rename { oldWord: string; newWord: string }

/** SQL string literal on one line: quotes are doubled, line breaks become char() so that a statement never spans lines. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`.replace(/\r/g, "'||char(13)||'").replace(/\n/g, "'||char(10)||'");
}
const sqlTextOrNull = (value: string): string => (value === "" ? "NULL" : sqlText(value));

const TOPIC_COLUMNS = ["slug", "title_ru", "title_tt"] as const;
const DECK_COLUMNS = ["title_ru", "title_tt", "level_no", "coverage_pct"] as const;
/** The columns of a level file that are stored in the note as they are; `topic` becomes `topic_no`, `audio_file_id` has its own rule. */
const NOTE_COLUMNS = ["word", "transcription", "pos", "translation", "example_tt", "example_ru", "example_src"] as const;
const same = (table: string, columns: readonly string[]): string => columns.map((c) => `${table}.${c} IS v.${c}`).join(" AND ");
const assign = (columns: readonly string[]): string => columns.map((c) => `${c} = excluded.${c}`).join(", ");

/** The pair a note is counted under: a catalog note under its level and topic, a learner's own note under (0, 0). */
const PAIR = "COALESCE(n.level, 0), COALESCE(n.topic_no, 0)";
/** Every (learner, pair) with the number of words started there: a word is started when one of its cards has left the state `new`. */
const STARTED =
  `SELECT c.user_id AS user_id, COALESCE(n.level, 0) AS level, COALESCE(n.topic_no, 0) AS topic_no, COUNT(DISTINCT c.note_id) AS started ` +
  `FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.state <> 'new' GROUP BY c.user_id, ${PAIR}`;

/**
 * SQL that loads the catalog — every level file, the topics, the renames — one statement per line, in this order:
 * the topics; the deck of each level (matched by `slug`); the renames; two lines per row, an UPDATE of the catalog
 * note with the row's word key and an INSERT when the catalog has no such note; the decks' `total`; the recount of
 * `catalog_groups` and of `user_progress`; the catalog version. This file is the only writer of catalog notes, and
 * it is run on the live database on every deploy:
 *  - a row that is already in the database as the file has it is not written at all, so loading an unchanged catalog
 *    costs no row writes. Each check stands in the statement's WHERE (for an upsert: in the SELECT that feeds it),
 *    never in the upsert's own WHERE: `decks` and `notes` are AUTOINCREMENT tables, and an INSERT that gets as far
 *    as the conflict has already bumped `sqlite_sequence` — one billed row write, even when nothing changes;
 *  - a note is found by its word key in the whole catalog (`level IS NOT NULL`), whatever level it stands in. A row
 *    that moved to another level file or topic moves its note — deck, `level`, `topic_no`, `seq`, `tseq` — and the
 *    note keeps its id, and with it the learners' cards and their schedule;
 *  - `seq` is the place of the row in its level file; `tseq` is its place in the guided order of the level, where
 *    themed and basic words alternate (`guidedTseq`). A row added to or moved in a file shifts the places after it,
 *    and each note whose `seq` or `tseq` changed is rewritten — one row write each, and none when nothing moved;
 *  - nothing is deleted: a note that left the files stays where it was. Cards, the review log, users and the learners'
 *    own notes (`level IS NULL`) are never written;
 *  - `audio_file_id` of a row only fills an empty one: a row never erases or replaces the voice a note already has,
 *    and `audio_tries` is left alone.
 * A corrected spelling changes the word key, which is what a row is matched by: without a rename the corrected row
 * would be a second note and the misspelled one would stay in the learners' queues. A rename moves the catalog note
 * from the old key to the new one before the rows are loaded: the id, the cards and the reports stay, and the voice is
 * dropped (`audio_file_id`, `audio_tries`) so that the voicing job says the new word. It does nothing when the catalog
 * already has a note under the new key or has none under the old one, so it is applied once.
 * The recounts bring `catalog_groups` (cards per level and topic) and `user_progress` (words a learner started per
 * level and topic) in line with the notes after a move; a counter that is already right is not written, one with
 * nothing behind it is deleted.
 * `hash` identifies the content of the catalog files (the caller computes it). The catalog version goes up by one
 * when the stored hash differs — a read position of a learner that was stored under another version counts as reset
 * (spec §10) — and then the hash is stored.
 * Throws on a row that lacks a column, a word, a translation or a known topic, on a word that stands in the files
 * twice (its note would change places on every load), on a topic without a whole number, and on a rename without
 * one of its words.
 */
export function catalogToSql(levels: SeedLevel[], topics: SeedTopic[], renames: Rename[], hash: string): string {
  const lines: string[] = [];
  for (const t of topics) {
    if (!Number.isInteger(t.no)) throw new Error(`topic «${t.slug}»: no number`);
    lines.push(
      `WITH v (no, ${TOPIC_COLUMNS.join(", ")}) AS (VALUES (${t.no}, ${sqlText(t.slug)}, ${sqlText(t.titleRu)}, ${sqlText(t.titleTt)})) ` +
        `INSERT INTO topics (no, ${TOPIC_COLUMNS.join(", ")}) SELECT v.no, ${TOPIC_COLUMNS.map((c) => `v.${c}`).join(", ")} FROM v ` +
        `WHERE NOT EXISTS (SELECT 1 FROM topics t WHERE t.no = v.no AND ${same("t", TOPIC_COLUMNS)}) ` +
        `ON CONFLICT (no) DO UPDATE SET ${assign(TOPIC_COLUMNS)};`,
    );
  }
  for (const l of levels) {
    const coverage = l.coveragePct === null ? "NULL" : String(Math.trunc(l.coveragePct));
    lines.push(
      `WITH v (slug, ${DECK_COLUMNS.join(", ")}) AS (VALUES (${sqlText(l.slug)}, ${sqlText(l.titleRu)}, ${sqlText(l.titleTt)}, ${Math.trunc(l.level)}, ${coverage})) ` +
        `INSERT INTO decks (slug, kind, ${DECK_COLUMNS.join(", ")}) SELECT v.slug, 'catalog', ${DECK_COLUMNS.map((c) => `v.${c}`).join(", ")} FROM v ` +
        `WHERE NOT EXISTS (SELECT 1 FROM decks d WHERE d.slug = v.slug AND ${same("d", DECK_COLUMNS)}) ` +
        `ON CONFLICT (slug) DO UPDATE SET ${assign(DECK_COLUMNS)};`,
    );
  }
  for (const r of renames) {
    const [oldKey, newKey] = [wordKey(r.oldWord), wordKey(r.newWord)];
    if (oldKey === "") throw new Error("rename: empty old word");
    if (newKey === "") throw new Error(`rename of «${r.oldWord}»: empty new word`);
    lines.push(
      `UPDATE notes SET word = ${sqlText(r.newWord.trim())}, word_key = ${sqlText(newKey)}, audio_file_id = NULL, audio_tries = 0 ` +
        `WHERE level IS NOT NULL AND word_key = ${sqlText(oldKey)} ` +
        `AND NOT EXISTS (SELECT 1 FROM notes x WHERE x.level IS NOT NULL AND x.word_key = ${sqlText(newKey)});`,
    );
  }

  const topicNo = new Map(topics.map((t) => [t.slug, t.no]));
  /** Word key → where the word stands in the files. */
  const seen = new Map<string, string>();
  for (const l of levels) {
    const deck = `(SELECT id FROM decks WHERE slug = ${sqlText(l.slug)})`;
    // The place of every row in the guided order of its level (levels/order.ts `guidedTseq`). A row with an unknown
    // topic is counted as a basic word here and stops the load below.
    const tseq = guidedTseq(l.rows.map((row, i) => ({ topicNo: topicNo.get(row.topic ?? "") ?? 0, seq: i + 1 })));
    l.rows.forEach((row, i) => {
      // The line of the level file: the header is line 1. A file with a wrong header or an empty cell must stop the
      // load here, before an UPDATE blanks the field of a card that people are learning.
      const at = `${l.slug} line ${i + 2}`;
      for (const c of [...NOTE_COLUMNS, "topic", "audio_file_id"]) if (row[c] === undefined) throw new Error(`${at}: no column ${c}`);
      const word = row.word!.trim();
      const key = wordKey(word);
      if (key === "") throw new Error(`${at}: empty word`);
      if (row.translation!.trim() === "") throw new Error(`${at}: empty translation`);
      const first = seen.get(key);
      if (first !== undefined) throw new Error(`${at}: word «${word}» already stands in ${first}`);
      seen.set(key, at);
      const topic = topicNo.get(row.topic!);
      if (topic === undefined) throw new Error(`${at}: unknown topic «${row.topic}»`);

      const seq = i + 1;
      /** Column → the value the file gives it. */
      const values: [string, string][] = [
        ["deck_id", deck], ["word", sqlText(word)], ["transcription", sqlTextOrNull(row.transcription!.trim())],
        ...NOTE_COLUMNS.slice(2).map((c): [string, string] => [c, sqlText(row[c]!)]),
        ["level", String(Math.trunc(l.level))], ["topic_no", String(topic)], ["seq", String(seq)], ["tseq", String(tseq[i]!)],
      ];
      const audio = sqlTextOrNull(row.audio_file_id!.trim());
      // An audio id of the file is taken only by a note that has no voice yet.
      const set = [...values.map(([c, v]) => `${c} = ${v}`), ...(audio === "NULL" ? [] : [`audio_file_id = COALESCE(NULLIF(audio_file_id, ''), ${audio})`])];
      const differs = [...values.map(([c, v]) => `${c} IS NOT ${v}`), ...(audio === "NULL" ? [] : [`COALESCE(audio_file_id, '') = ''`])];
      const inCatalog = `level IS NOT NULL AND word_key = ${sqlText(key)}`;
      lines.push(
        `UPDATE notes SET ${set.join(", ")} WHERE ${inCatalog} AND (${differs.join(" OR ")});`,
        `INSERT INTO notes (${values.map(([c]) => c).join(", ")}, word_key, audio_file_id) ` +
          `SELECT ${values.map(([, v]) => v).join(", ")}, ${sqlText(key)}, ${audio} WHERE NOT EXISTS (SELECT 1 FROM notes WHERE ${inCatalog});`,
      );
    });
  }

  lines.push(
    `UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = decks.id) WHERE kind = 'catalog' AND total IS NOT (SELECT COUNT(*) FROM notes WHERE deck_id = decks.id);`,
    `INSERT INTO catalog_groups (level, topic_no, total) SELECT g.level, g.topic_no, g.total ` +
      `FROM (SELECT n.level AS level, COALESCE(n.topic_no, 0) AS topic_no, COUNT(*) AS total FROM notes n WHERE n.level IS NOT NULL GROUP BY n.level, COALESCE(n.topic_no, 0)) g ` +
      `WHERE NOT EXISTS (SELECT 1 FROM catalog_groups c WHERE c.level = g.level AND c.topic_no = g.topic_no AND c.total = g.total) ` +
      `ON CONFLICT (level, topic_no) DO UPDATE SET total = excluded.total;`,
    `DELETE FROM catalog_groups WHERE (level, topic_no) NOT IN (SELECT n.level, COALESCE(n.topic_no, 0) FROM notes n WHERE n.level IS NOT NULL);`,
    `INSERT INTO user_progress (user_id, level, topic_no, started) SELECT g.user_id, g.level, g.topic_no, g.started FROM (${STARTED}) g ` +
      `WHERE NOT EXISTS (SELECT 1 FROM user_progress p WHERE p.user_id = g.user_id AND p.level = g.level AND p.topic_no = g.topic_no AND p.started = g.started) ` +
      `ON CONFLICT (user_id, level, topic_no) DO UPDATE SET started = excluded.started;`,
    `DELETE FROM user_progress WHERE (user_id, level, topic_no) NOT IN (SELECT c.user_id, ${PAIR} FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.state <> 'new');`,
    `UPDATE meta SET value = value + 1 WHERE key = 'catalog_version' AND (SELECT value FROM meta WHERE key = 'catalog_hash') IS NOT ${sqlText(hash)};`,
    `UPDATE meta SET value = ${sqlText(hash)} WHERE key = 'catalog_hash' AND value IS NOT ${sqlText(hash)};`,
  );
  return lines.join("\n") + "\n";
}
