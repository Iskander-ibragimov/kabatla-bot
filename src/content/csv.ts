import { wordKey } from "../db/repo";

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

/** The catalog deck of a level, as the seed writes it. */
export interface SeedDeck { slug: string; titleRu: string; titleTt: string; levelNo: number; coveragePct: number | null }

/** SQL string literal on one line: quotes are doubled, line breaks become char() so that a statement never spans lines. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`.replace(/\r/g, "'||char(13)||'").replace(/\n/g, "'||char(10)||'");
}
const sqlTextOrNull = (value: string): string => (value === "" ? "NULL" : sqlText(value));

const DECK_COLUMNS = ["title_ru", "title_tt", "level_no", "coverage_pct"] as const;
const NOTE_COLUMNS = ["word", "transcription", "pos", "translation", "example_tt", "example_ru", "example_src"] as const;
const same = (table: string, columns: readonly string[]): string => columns.map((c) => `${table}.${c} IS v.${c}`).join(" AND ");
const assign = (columns: readonly string[]): string => columns.map((c) => `${c} = excluded.${c}`).join(", ");

/**
 * SQL that loads one level of the catalog, one statement per line: the deck (matched by `slug`), every row as a note
 * (matched by deck and word key), then the deck's `total`. Safe to run on a live database on every deploy:
 *  - a row that is already in the database with the same fields is not written at all, so loading an unchanged
 *    catalog costs no row writes. The check stands in the SELECT that feeds the INSERT, not in the upsert's own
 *    WHERE: `decks` and `notes` are AUTOINCREMENT tables, and an INSERT that gets as far as the conflict has
 *    already bumped `sqlite_sequence` — one billed row write, even when the upsert then changes nothing;
 *  - a changed row gets its fields updated in place: the note keeps its id, and with it the users' cards;
 *  - an empty `audio_file_id` never erases the audio already attached to the note;
 *  - nothing is deleted, and a word that already stands in another level stays there and is not copied.
 * Throws on a row that lacks a column, a word or a translation.
 */
export function csvToSql(deck: SeedDeck, rows: Record<string, string>[]): string {
  const slug = sqlText(deck.slug);
  const coverage = deck.coveragePct === null ? "NULL" : String(Math.trunc(deck.coveragePct));
  const lines = [
    `WITH v (slug, ${DECK_COLUMNS.join(", ")}) AS (VALUES (${slug}, ${sqlText(deck.titleRu)}, ${sqlText(deck.titleTt)}, ${Math.trunc(deck.levelNo)}, ${coverage})) ` +
      `INSERT INTO decks (slug, kind, ${DECK_COLUMNS.join(", ")}) SELECT v.slug, 'catalog', ${DECK_COLUMNS.map((c) => `v.${c}`).join(", ")} FROM v ` +
      `WHERE NOT EXISTS (SELECT 1 FROM decks d WHERE d.slug = v.slug AND ${same("d", DECK_COLUMNS)}) ` +
      `ON CONFLICT (slug) DO UPDATE SET ${assign(DECK_COLUMNS)};`,
  ];
  rows.forEach((row, i) => {
    // The line of the level file: the header is line 1. A file with a wrong header or an empty cell must stop the
    // load here, before an UPDATE blanks the field of a card that people are learning.
    const at = `${deck.slug} line ${i + 2}`;
    for (const c of [...NOTE_COLUMNS, "audio_file_id"]) if (row[c] === undefined) throw new Error(`${at}: no column ${c}`);
    const word = row.word!.trim();
    for (const c of ["word", "translation"] as const) if (row[c]!.trim() === "") throw new Error(`${at}: empty ${c}`);
    const values = [
      sqlText(word), sqlText(wordKey(word)), sqlTextOrNull(row.transcription!.trim()),
      ...NOTE_COLUMNS.slice(2).map((c) => sqlText(row[c]!)), sqlTextOrNull(row.audio_file_id!.trim()),
    ];
    const columns = ["word", "word_key", ...NOTE_COLUMNS.slice(1), "audio_file_id"];
    lines.push(
      `WITH v (${columns.join(", ")}) AS (VALUES (${values.join(", ")})) ` +
        `INSERT INTO notes (deck_id, ${columns.join(", ")}) SELECT d.id, ${columns.map((c) => `v.${c}`).join(", ")} FROM decks d, v ` +
        `WHERE d.slug = ${slug} AND NOT EXISTS (SELECT 1 FROM notes n JOIN decks nd ON nd.id = n.deck_id WHERE n.word_key = v.word_key AND nd.kind = 'catalog' ` +
        `AND (nd.id <> d.id OR (${same("n", NOTE_COLUMNS)} AND (v.audio_file_id IS NULL OR n.audio_file_id IS v.audio_file_id)))) ` +
        `ON CONFLICT (deck_id, word_key) DO UPDATE SET ${assign(NOTE_COLUMNS)}, audio_file_id = COALESCE(NULLIF(excluded.audio_file_id, ''), notes.audio_file_id);`,
    );
  });
  lines.push(`UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = decks.id) WHERE slug = ${slug} AND total IS NOT (SELECT COUNT(*) FROM notes WHERE deck_id = decks.id);`);
  return lines.join("\n") + "\n";
}
