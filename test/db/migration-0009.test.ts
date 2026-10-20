import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { catalogToSql } from "../../src/content/csv";
import { Repo } from "../../src/db/repo";
import { harness } from "../helpers/botHarness";
import { applySeed } from "../helpers/seedSql";

/** 06:00 UTC: 09:00 in Moscow. */
const T = Date.UTC(2026, 9, 5, 6);
const DAY = 86_400_000;

const migration = () => env.TEST_MIGRATIONS.find((m) => m.name === "0009_cefr_data.sql")!;
/** The statements of the file, in file order, the way `wrangler d1 migrations apply` runs them. */
const run = () => env.DB.batch(migration().queries.map((q) => env.DB.prepare(q)));

const all = async <T = Record<string, unknown>>(sql: string) => (await env.DB.prepare(sql).all<T>()).results;
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const inserted = async (sql: string, ...values: unknown[]) => (await env.DB.prepare(`${sql} RETURNING id`).bind(...values).first<{ id: number }>())!.id;

/** What belongs to learners: after the migration every one of these tables is empty. */
const LEARNER_TABLES = ["users", "cards", "review_log", "user_decks", "user_progress", "sessions", "previews", "jobs", "reports"];
/** Every table of the schema, for a picture of the whole database. */
const TABLES = [...LEARNER_TABLES, "decks", "notes", "catalog_groups", "topics", "usage_daily", "meta"];
const database = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await all(`SELECT * FROM ${t}`)).map((row) => JSON.stringify(row)).sort()] as const)));

/** A catalog note as the migration must leave it: everything a learner sees and hears, and the voice with its tries. */
const CARD = "id, word, word_key, transcription, pos, translation, example_tt, example_ru, example_src, audio_file_id, audio_tries, source_url";
const catalogCards = () => all(`SELECT ${CARD} FROM notes WHERE deck_id IN (SELECT id FROM decks WHERE kind = 'catalog') ORDER BY id`);

/** The words of the four old levels, three a level; the first two of each level have a voice. */
const LEVEL_WORDS: Record<number, [string, string][]> = {
  1: [["китап", "книга"], ["вакыт", "время"], ["авыл", "деревня"]],
  2: [["су", "вода"], ["юл", "дорога"], ["көн", "день"]],
  3: [["өй", "дом"], ["эш", "работа"], ["кеше", "человек"]],
  4: [["сүз", "слово"], ["яңа", "новый"], ["зур", "большой"]],
};
const COVERAGE: Record<number, number> = { 1: 27, 2: 36, 3: 42, 4: 45 };

/**
 * The live database as it is before the migration, written by hand: the catalog decks l01…l04 (level_no 1–4) with
 * three notes each and no level on a note; two learners, each subscribed to a level and to a deck of their own, with
 * cards, grades, counters, a report, a session, a preview and a job. The notes are written out of the order of the
 * levels and between the learners' own notes, so the id of a note says nothing of its level.
 */
async function oldShape() {
  const deck: Record<number, number> = {};
  for (const no of [1, 2, 3, 4]) {
    deck[no] = await inserted(
      "INSERT INTO decks (slug, kind, title_ru, title_tt, level_no, coverage_pct, total) VALUES (?, 'catalog', ?, ?, ?, ?, 3)",
      `l0${no}`, `Уровень ${no}`, `${no} нче дәрәҗә`, no, COVERAGE[no],
    );
  }
  const [a, b] = [
    await inserted("INSERT INTO users (tg_id, chat_id, lang, created_at, level, onboarding_step, streak) VALUES (7, 7, 'ru', ?, 2, NULL, 3)", T - 9 * DAY),
    await inserted("INSERT INTO users (tg_id, chat_id, lang, created_at, level, onboarding_step) VALUES (8, 8, 'tt', ?, 1, 'goal')", T - DAY),
  ];
  const own = {
    a: await inserted("INSERT INTO decks (owner_id, kind, title_ru, title_tt, total) VALUES (?, 'custom', 'Мои слова', 'Минем сүзләр', 2)", a),
    b: await inserted("INSERT INTO decks (owner_id, kind, title_ru, title_tt, total) VALUES (?, 'ai', '🤖 юл', '🤖 юл', 2)", b),
  };
  const note = (deckId: number, word: string, translation: string, audio: string | null = null, tries = 0) => inserted(
    `INSERT INTO notes (deck_id, word, word_key, transcription, pos, translation, example_tt, example_ru, example_src, audio_file_id, audio_tries)
     VALUES (?1, ?2, ?2, ?2 || '́', 'n', ?3, ?2 || '.', ?3 || '.', 'own', ?4, ?5)`, deckId, word, translation, audio, tries);
  const level = async (no: number) => {
    const ids: number[] = [];
    // The third note of a level has no voice yet; the voicing has tried it twice.
    for (const [i, [word, translation]] of LEVEL_WORDS[no]!.entries()) ids.push(await note(deck[no]!, word, translation, i < 2 ? `voice-${word}` : null, i < 2 ? 0 : 2));
    return ids;
  };
  const l3 = await level(3);
  const ownA = [await note(own.a, "рәхмәт", "спасибо")];
  const l1 = await level(1);
  // A learner's own word that the catalog has too.
  ownA.push(await note(own.a, "китап", "моя книга"));
  const l4 = await level(4);
  const ownB = [await note(own.b, "сәлам", "привет"), await note(own.b, "дус", "друг")];
  const l2 = await level(2);

  const card = (userId: number, noteId: number, direction: string, state: string) =>
    inserted("INSERT INTO cards (user_id, note_id, direction, state, due, reps) VALUES (?, ?, ?, ?, ?, ?)", userId, noteId, direction, state, T + DAY, state === "new" ? 0 : 1);
  const cards = [
    await card(a, l1[0]!, "tt_ru", "review"), await card(a, l1[0]!, "ru_tt", "new"), await card(a, l2[0]!, "tt_ru", "learning"), await card(a, ownA[0]!, "tt_ru", "review"),
    await card(b, l1[0]!, "tt_ru", "review"), await card(b, ownB[0]!, "tt_ru", "new"),
  ];
  await env.DB.batch([
    ...[[cards[0], a], [cards[2], a], [cards[4], b]].map(([cardId, userId]) => env.DB.prepare(
      "INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new) VALUES (?, ?, 3, '{}', 0, 600000, ?, 1)",
    ).bind(cardId, userId, T - DAY)),
    ...[[a, deck[1]], [a, deck[2]], [a, own.a], [b, deck[1]], [b, own.b]].map(([userId, deckId]) =>
      env.DB.prepare("INSERT INTO user_decks (user_id, deck_id, added_at) VALUES (?, ?, ?)").bind(userId, deckId, T - DAY)),
    env.DB.prepare("INSERT INTO user_progress (user_id, level, topic_no, started) VALUES (?, 0, 0, 1)").bind(a),
    env.DB.prepare("INSERT INTO reports (user_id, note_id, created_at) VALUES (?, ?, ?)").bind(a, l1[1], T),
    env.DB.prepare("INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, 7, 100, ?)").bind(a, cards[0]),
    env.DB.prepare("INSERT INTO previews (user_id, kind, payload, created_at) VALUES (?, 'add', '[]', ?)").bind(b, T),
    env.DB.prepare("INSERT INTO jobs (kind, payload, run_at) VALUES ('push', '{\"chat_id\":7}', ?)").bind(T + 60_000),
    // What belongs to nobody stays.
    env.DB.prepare("INSERT INTO usage_daily (day, reviews, rows_written_est, requests) VALUES ('2026-10-04', 3, 12, 5)"),
    env.DB.prepare("INSERT INTO topics (no, slug, title_ru, title_tt) VALUES (0, 'core', 'Основа', 'Нигез сүзләр')"),
  ]);
  return { deck, levels: { 1: l1, 2: l2, 3: l3, 4: l4 } as Record<number, number[]> };
}

describe("migration 0009: the live catalog becomes A1, the learners start again", () => {
  it("deletes every learner whole: no user, card, grade, subscription, counter, session, preview, job or report, no own deck and no own note", async () => {
    await oldShape();
    for (const t of LEARNER_TABLES) expect(await count(t), t).toBeGreaterThan(0);
    await run();
    for (const t of LEARNER_TABLES) expect(await count(t), t).toBe(0);
    expect(await all("SELECT id FROM decks WHERE owner_id IS NOT NULL")).toEqual([]);
    expect(await all("SELECT n.id FROM notes n LEFT JOIN decks d ON d.id = n.deck_id WHERE d.kind IS NOT 'catalog'")).toEqual([]);
    // What is no learner's stays as it was.
    expect(await all("SELECT * FROM usage_daily")).toEqual([{ day: "2026-10-04", reviews: 3, rows_written_est: 12, requests: 5, warned: 0 }]);
    expect(await all("SELECT * FROM topics")).toEqual([{ no: 0, slug: "core", title_ru: "Основа", title_tt: "Нигез сүзләр" }]);
    expect(await all("SELECT * FROM meta ORDER BY key")).toEqual([{ key: "catalog_hash", value: "" }, { key: "catalog_version", value: "0" }]);
  });

  it("keeps every catalog card with its id and its voice, in one deck a1", async () => {
    const { deck, levels } = await oldShape();
    const before = await catalogCards();
    expect(before).toHaveLength(12);
    expect(before.filter((n) => n.audio_file_id !== null)).toHaveLength(8);
    await run();
    // The card itself — word, key, transcription, translation, examples, the voice and its tries — is untouched.
    expect(await catalogCards()).toEqual(before);
    expect(await count("notes")).toBe(12);
    // The deck of the old level 1 is the deck of A1: the coverage is that of the old level 4, the highest of the four.
    expect(await all("SELECT * FROM decks")).toEqual([
      { id: deck[1], slug: "a1", owner_id: null, kind: "catalog", title_ru: "A1", title_tt: "A1", level_no: 1, coverage_pct: 45, total: 12 },
    ]);
    const notes = await all<{ id: number; word: string; deck_id: number; level: number; topic_no: number; seq: number; tseq: number }>(
      "SELECT id, word, deck_id, level, topic_no, seq, tseq FROM notes ORDER BY seq");
    expect(notes.every((n) => n.deck_id === deck[1] && n.level === 1 && n.topic_no === 0)).toBe(true);
    // The guided order is the same order, and stands behind the runs of the topics 1–20, which the catalog load fills.
    expect(notes.map((n) => n.tseq)).toEqual(notes.map((n) => 21_000_000 + n.seq));
    // The order of A1 until the catalog is loaded: the old levels in turn, each in the order of its notes.
    const oldOrder = [1, 2, 3, 4].flatMap((no) => levels[no]!.map((id) => ({ id, seq: no * 100_000 + id })));
    expect(notes.map((n) => ({ id: n.id, seq: n.seq }))).toEqual(oldOrder);
    expect(notes.map((n) => n.word)).toEqual([1, 2, 3, 4].flatMap((no) => LEVEL_WORDS[no]!.map(([word]) => word)));
    // The ids alone would give another order: the notes of level 3 were written first.
    expect(notes.map((n) => n.id)).not.toEqual([...notes.map((n) => n.id)].sort((x, y) => x - y));
    expect(await all("SELECT * FROM catalog_groups")).toEqual([{ level: 1, topic_no: 0, total: 12 }]);
  });

  it("run a second time it changes nothing", async () => {
    await oldShape();
    await run();
    const once = await database();
    const again = await run();
    expect(again.map((r) => r.meta.changes)).toEqual(again.map(() => 0));
    expect(await database()).toEqual(once);
  });

  it("on an empty database it changes nothing", async () => {
    const before = await database();
    const res = await run();
    expect(res.map((r) => r.meta.changes)).toEqual(res.map(() => 0));
    expect(await database()).toEqual(before);
    expect(await count("decks")).toBe(0);
  });

  it("the catalog load that the deploy runs next finds every card: the ids and the voices stay, the topics and the places are those of the file", async () => {
    const { deck } = await oldShape();
    // A word that left the level files after it was loaded: the old load deleted nothing, so its note is still there.
    const stale = await inserted("INSERT INTO notes (deck_id, word, word_key, translation, audio_file_id) VALUES (?, 'ара', 'ара', 'между', 'voice-ара')", deck[2]);
    await run();
    const before = await all<{ id: number; word: string; audio_file_id: string | null; audio_tries: number }>("SELECT id, word, audio_file_id, audio_tries FROM notes ORDER BY id");
    // The file of A1: the twelve words in an order of its own, every third one a word of «Еда»; it names no voice.
    const words = [4, 1, 3, 2].flatMap((no) => LEVEL_WORDS[no]!);
    const rows = words.map(([word, translation], i) => ({
      word, transcription: `${word}́`, pos: "n", translation, example_tt: `${word}.`, example_ru: `${translation}.`, example_src: "own", topic: i % 3 === 0 ? "food" : "core", audio_file_id: "",
    }));
    const topics = [{ no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" }, { no: 8, slug: "food", titleRu: "Еда", titleTt: "Ризык" }];
    await applySeed(env.DB, catalogToSql([{ level: 1, slug: "a1", titleRu: "A1", titleTt: "A1", coveragePct: 45, rows }], topics, [], "hash-1"));
    expect(await all("SELECT id, word, audio_file_id, audio_tries FROM notes ORDER BY id")).toEqual(before);
    // The words of the file in the order of the file, and behind them the note the file does not have — in the order
    // of the level and in the guided order alike: it is nobody's first word.
    const inFile = words.map(([word]) => word);
    const bySeq = await all<{ id: number; word: string; seq: number }>("SELECT id, word, seq FROM notes WHERE level = 1 ORDER BY seq");
    expect(bySeq.map((n) => n.word)).toEqual([...inFile, "ара"]);
    expect(bySeq.slice(0, 12).map((n) => n.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const byTseq = await all<{ id: number; word: string }>("SELECT id, word FROM notes WHERE level = 1 ORDER BY tseq");
    expect(byTseq.map((n) => n.word).slice(0, 2)).toEqual([inFile[0], inFile[1]]);
    expect(byTseq.at(-1)).toEqual({ id: stale, word: "ара" });
    expect(await all("SELECT slug, level_no, coverage_pct, total FROM decks")).toEqual([{ slug: "a1", level_no: 1, coverage_pct: 45, total: 13 }]);
    expect(await all("SELECT * FROM catalog_groups ORDER BY topic_no")).toEqual([{ level: 1, topic_no: 0, total: 9 }, { level: 1, topic_no: 8, total: 4 }]);
  });

  it("after it /start leads through the new introduction to the first card of A1, and that learner is not touched by another run", async () => {
    await oldShape();
    await run();
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    for (const answer of ["ob:ru", "ob:n1", "ob:n2"]) await h.press(answer);
    // The step «Уровни»: A1 with the twelve cards and the coverage it took over; the other levels have no card yet.
    expect((h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.text)).toEqual(
      ["☑ A1 · 12 слов · ≈45 % текста", "☐ A2 · скоро", "☐ B1 · скоро", "☐ B2 · скоро", "☐ C1 · скоро", "Начать"]);
    for (const answer of ["ob:go", "ob:09:00", "ob:tz:180"]) await h.press(answer);
    // The first word of the old level 1, with the voice it had.
    expect(h.lastText()).toContain("\n<b>китап</b>\n");
    const learner = (await new Repo(env.DB).getUserByTg(42))!;
    expect(learner).toMatchObject({ onboardingStep: null, levels: 1, newMode: "guided", posGroups: 255, topicNo: null });
    const shown = await all("SELECT c.user_id, n.word, n.audio_file_id FROM cards c JOIN notes n ON n.id = c.note_id");
    expect(shown).toEqual([{ user_id: learner.id, word: "китап", audio_file_id: "voice-китап" }]);
    // The database is in the new shape now: the file finds no deck l01 and leaves the new learner alone.
    const before = await database();
    await run();
    expect(await database()).toEqual(before);
    expect(await count("users")).toBe(1);
  });
});
