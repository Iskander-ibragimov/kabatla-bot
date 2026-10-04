import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Rename, type SeedLevel, type SeedTopic, catalogToSql } from "../src/content/csv";
import { Repo } from "../src/db/repo";
import { LEVELS } from "../src/levels/scale";
import { newMem } from "../src/srs/fsrs";
import { gradedMem } from "./helpers/review";
import { applySeed } from "./helpers/seedSql";

const T = Date.UTC(2026, 9, 3, 6);

const TOPICS: SeedTopic[] = [
  { no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" },
  { no: 8, slug: "food", titleRu: "Еда", titleTt: "Ризык" },
  { no: 12, slug: "work", titleRu: "Работа и профессии", titleTt: "Эш һәм һөнәрләр" },
];

type Row = Record<string, string>;
/** A catalog row as the CSV holds it; topic `core` unless given. */
const row = (word: string, over: Row = {}): Row => ({
  word, transcription: word, pos: "n", translation: `${word}-ru`, example_tt: `Бу — ${word}.`, example_ru: "Это слово.", example_src: "own", topic: "core", audio_file_id: "", ...over,
});
const lvl = (level: number, rows: Row[], coveragePct: number | null = null): SeedLevel => {
  const { slug, code } = LEVELS[level - 1]!;
  return { level, slug, titleRu: code, titleTt: code, coveragePct, rows };
};
const A1 = () => lvl(1, [row("китап", { topic: "food" }), row("су"), row("юл", { topic: "food" })], 27);
const A2 = () => lvl(2, [row("авыл"), row("көн", { topic: "work" })], 36);

/** Stands in for the sha256 of the catalog files: any change of the rows or of the topics gives another string. */
const digest = (levels: SeedLevel[], topics: SeedTopic[]): string => {
  let h = 2166136261;
  for (const c of JSON.stringify([levels.map((l) => [l.slug, l.rows]), topics])) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return h.toString(16);
};
const seed = (levels: SeedLevel[], o: { topics?: SeedTopic[]; renames?: Rename[]; hash?: string } = {}): string =>
  catalogToSql(levels, o.topics ?? TOPICS, o.renames ?? [], o.hash ?? digest(levels, o.topics ?? TOPICS));
const load = (levels: SeedLevel[], o: Parameters<typeof seed>[1] = {}) => applySeed(env.DB, seed(levels, o));

const all = async <R = Record<string, unknown>>(sql: string) => (await env.DB.prepare(sql).all<R>()).results;
const countRows = async (table: string) => (await all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n;
const notes = () =>
  all("SELECT d.slug, n.id, n.word, n.word_key, n.transcription, n.pos, n.translation, n.example_tt, n.example_ru, n.example_src, n.audio_file_id, n.level, n.topic_no, n.seq, n.tseq FROM notes n LEFT JOIN decks d ON d.id = n.deck_id ORDER BY n.id");
const noteOf = async (word: string) => (await notes()).find((n) => n.word === word && n.level !== null)!;
const decks = () => all("SELECT slug, kind, owner_id, title_ru, title_tt, level_no, coverage_pct, total FROM decks WHERE kind = 'catalog' ORDER BY level_no");
const groups = async () => (await all<{ level: number; topic_no: number; total: number }>("SELECT * FROM catalog_groups ORDER BY level, topic_no")).map((g) => [g.level, g.topic_no, g.total]);
const progress = async () =>
  (await all<{ user_id: number; level: number; topic_no: number; started: number }>("SELECT * FROM user_progress ORDER BY user_id, level, topic_no")).map((p) => [p.user_id, p.level, p.topic_no, p.started]);
const version = async () => (await all<{ value: string }>("SELECT value FROM meta WHERE key = 'catalog_version'"))[0]!.value;
const cards = () => all("SELECT * FROM cards ORDER BY id");
const setAudio = (word: string, fileId: string, tries = 0) =>
  env.DB.prepare("UPDATE notes SET audio_file_id = ?, audio_tries = ? WHERE word = ?").bind(fileId, tries, word).run();
const audioOf = (word: string) => env.DB.prepare("SELECT audio_file_id, audio_tries FROM notes WHERE word = ? AND level IS NOT NULL").bind(word).first();

/** A learner with a started card (graded, due later) for each of the catalog words given. */
async function learner(words: string[], tgId = 1) {
  const repo = new Repo(env.DB);
  const userId = await repo.insertUser({ tgId, chatId: tgId, lang: "ru", now: T });
  for (const word of words) await repo.insertCard(userId, (await noteOf(word)).id as number, "tt_ru", gradedMem(T));
  return { repo, userId };
}

describe("catalog seed", () => {
  it("the first load creates the topics, a deck per level and the notes with level, topic and both orders", async () => {
    await load([A1(), A2()]);

    expect(await all("SELECT * FROM topics ORDER BY no")).toEqual([
      { no: 0, slug: "core", title_ru: "Основа", title_tt: "Нигез сүзләр" },
      { no: 8, slug: "food", title_ru: "Еда", title_tt: "Ризык" },
      { no: 12, slug: "work", title_ru: "Работа и профессии", title_tt: "Эш һәм һөнәрләр" },
    ]);
    expect(await decks()).toEqual([
      { slug: "a1", kind: "catalog", owner_id: null, title_ru: "A1", title_tt: "A1", level_no: 1, coverage_pct: 27, total: 3 },
      { slug: "a2", kind: "catalog", owner_id: null, title_ru: "A2", title_tt: "A2", level_no: 2, coverage_pct: 36, total: 2 },
    ]);
    expect((await notes()).map((n) => [n.slug, n.word, n.level, n.topic_no, n.seq, n.tseq])).toEqual([
      ["a1", "китап", 1, 8, 1, 8_000_001], ["a1", "су", 1, 0, 2, 2], ["a1", "юл", 1, 8, 3, 8_000_003],
      ["a2", "авыл", 2, 0, 1, 1], ["a2", "көн", 2, 12, 2, 12_000_002],
    ]);
    expect(await groups()).toEqual([[1, 0, 1], [1, 8, 2], [2, 0, 1], [2, 12, 1]]);
    expect(await version()).toBe("1");
    expect(await new Repo(env.DB).getDeckBySlug("a2")).toMatchObject({ kind: "catalog", levelNo: 2, coveragePct: 36, total: 2 });
  });

  it("stores every column of the row, the word key, and NULL for an empty transcription or audio", async () => {
    await load([lvl(1, [
      row(" Китап ", { transcription: "кита́п", pos: "n", translation: "книга", example_tt: "Бу — китап.", example_ru: "Это книга.", example_src: "tatoeba:123", topic: "food", audio_file_id: "AUD1" }),
      row("су", { transcription: "" }),
    ])]);
    expect(await notes()).toEqual([
      { slug: "a1", id: expect.any(Number), word: "Китап", word_key: "китап", transcription: "кита́п", pos: "n", translation: "книга", example_tt: "Бу — китап.", example_ru: "Это книга.", example_src: "tatoeba:123", audio_file_id: "AUD1", level: 1, topic_no: 8, seq: 1, tseq: 8_000_001 },
      { slug: "a1", id: expect.any(Number), word: "су", word_key: "су", transcription: null, pos: "n", translation: "су-ru", example_tt: "Бу — су.", example_ru: "Это слово.", example_src: "own", audio_file_id: null, level: 1, topic_no: 0, seq: 2, tseq: 2 },
    ]);
  });

  it("writes one statement per line: topics, decks, renames, two lines per row, the totals, the recounts, the version", () => {
    const lines = seed([A1(), A2()], { renames: [{ oldWord: "китаб", newWord: "китап" }], hash: "abc" }).split("\n");
    expect(lines.pop()).toBe("");
    for (const line of lines) expect(line).toMatch(/^[A-Z].*;$/);
    const kinds = lines.map((line) => /(INSERT INTO|UPDATE|DELETE FROM) (\w+)/.exec(line)!.slice(1).join(" "));
    expect(kinds).toEqual([
      ...Array(3).fill("INSERT INTO topics"),
      ...Array(2).fill("INSERT INTO decks"),
      "UPDATE notes",
      ...Array(5).fill(["UPDATE notes", "INSERT INTO notes"]).flat(),
      "UPDATE decks",
      "INSERT INTO catalog_groups", "DELETE FROM catalog_groups",
      "INSERT INTO user_progress", "DELETE FROM user_progress",
      "UPDATE meta", "UPDATE meta",
    ]);
    expect(lines.at(-2)).toBe("UPDATE meta SET value = value + 1 WHERE key = 'catalog_version' AND (SELECT value FROM meta WHERE key = 'catalog_hash') IS NOT 'abc';");
  });

  it("escapes apostrophes, commas, semicolons and line breaks", async () => {
    const tricky = row("кул'язма, кулъязма", {
      transcription: "къул'йазма́", translation: "рукопись; it's «a», b", example_tt: "Бу — 'кул'язма'; әйе.", example_ru: "Это\nрукопись\r\n'да'", example_src: "own",
    });
    const levels = [lvl(1, [tricky, row("су")])];
    const topics = [{ no: 0, slug: "core", titleRu: "Основа; it's", titleTt: "Нигез\nсүзләр" }];
    const sql = seed(levels, { topics, hash: "it's" });
    expect(sql.split("\n")).toHaveLength(1 + 1 + 4 + 1 + 2 + 2 + 2 + 1);
    await applySeed(env.DB, sql);
    expect(await notes()).toEqual([
      expect.objectContaining({ word: tricky.word, word_key: "кул'язма, кулъязма", transcription: tricky.transcription, translation: tricky.translation, example_tt: tricky.example_tt, example_ru: tricky.example_ru }),
      expect.objectContaining({ word: "су" }),
    ]);
    expect(await all("SELECT title_ru, title_tt FROM topics")).toEqual([{ title_ru: "Основа; it's", title_tt: "Нигез\nсүзләр" }]);
    expect(await all("SELECT value FROM meta WHERE key = 'catalog_hash'")).toEqual([{ value: "it's" }]);
    expect(await applySeed(env.DB, sql)).toMatchObject({ changes: 0, rowsWritten: 0 });
  });

  it("refuses a row without a word, a translation, one of the columns or a known topic, so that a broken file cannot blank a live card", () => {
    expect(() => seed([lvl(1, [row("китап"), row(" ")])])).toThrow(/a1 line 3.*word/);
    expect(() => seed([A1(), lvl(2, [row("авыл", { translation: " " })])])).toThrow(/a2 line 2.*translation/);
    const { example_ru: _, ...short } = row("китап");
    expect(() => seed([lvl(1, [short])])).toThrow(/a1 line 2.*example_ru/);
    const { audio_file_id: __, ...noAudio } = row("китап");
    expect(() => seed([lvl(1, [noAudio])])).toThrow(/a1 line 2.*audio_file_id/);
    const { topic: ___, ...noTopic } = row("китап");
    expect(() => seed([lvl(1, [noTopic])])).toThrow(/a1 line 2.*topic/);
    expect(() => seed([lvl(1, [row("китап", { topic: "sport" })])])).toThrow(/a1 line 2.*sport/);
    expect(() => seed([lvl(1, [row("?!")])])).toThrow(/a1 line 2.*word/);
  });

  it("refuses a topic without a whole number", () => {
    expect(() => seed([A1()], { topics: [...TOPICS, { no: NaN, slug: "shop", titleRu: "Покупки", titleTt: "Сәүдә" }] })).toThrow(/topic «shop»/);
  });

  it("refuses a word that stands in the files twice: it would change places on every load", () => {
    expect(() => seed([A1(), lvl(2, [row("авыл"), row("Су!")])])).toThrow(/a2 line 3.*«Су!».*a1 line 3/);
  });

  it("writes no rows when an unchanged catalog is loaded again, and leaves the version as it was", async () => {
    const sql = seed([A1(), A2()]);
    const first = await applySeed(env.DB, sql);
    expect(first.statements).toBe(3 + 2 + 10 + 1 + 2 + 2 + 2);
    // 3 topics, 2 decks, 5 notes, 2 deck totals, 4 groups, the version and the hash.
    expect(first.changes).toBe(18);

    // What happens between two deploys: the voicing job attaches a voice, people learn catalog words and their own.
    await setAudio("китап", "VOICE1");
    const { repo, userId } = await learner(["китап", "көн"]);
    const own = await repo.customDeck(userId, T);
    const [ownId] = await repo.insertNotes(own, [{ word: "юл", transcription: null, pos: "n", translation: "мой путь", exampleTt: "", exampleRu: "", exampleSrc: "" }]);
    await repo.insertCard(userId, ownId!, "tt_ru", gradedMem(T));
    // The first load after that brings the counters up: one row per pair of the learner.
    expect((await applySeed(env.DB, sql)).changes).toBe(3);
    expect(await progress()).toEqual([[userId, 0, 0, 1], [userId, 1, 8, 1], [userId, 2, 12, 1]]);
    const before = { notes: await notes(), cards: await cards() };

    for (let i = 0; i < 2; i++) expect(await applySeed(env.DB, sql)).toEqual({ statements: first.statements, changes: 0, rowsWritten: 0 });
    expect({ notes: await notes(), cards: await cards() }).toEqual(before);
    expect(await version()).toBe("1");
  });

  it("writes only the note whose translation changed, and bumps the version", async () => {
    await load([A1(), A2()]);
    const before = await notes();

    const changed = lvl(1, A1().rows.map((r) => (r.word === "су" ? { ...r, translation: "вода" } : r)), 27);
    // The note, the version, the hash.
    expect((await load([changed, A2()])).changes).toBe(3);
    expect(await notes()).toEqual(before.map((n) => (n.word === "су" ? { ...n, translation: "вода" } : n)));
    expect(await version()).toBe("2");

    expect(await load([changed, A2()])).toMatchObject({ changes: 0, rowsWritten: 0 });
    expect(await version()).toBe("2");
  });

  it("writes only the deck when its coverage changes or appears", async () => {
    await load([lvl(1, A1().rows, null)]);
    expect((await decks())[0]).toMatchObject({ coverage_pct: null });
    expect((await load([lvl(1, A1().rows, null)])).changes).toBe(0);
    expect((await load([lvl(1, A1().rows, 31)])).changes).toBe(1);
    expect((await decks())[0]).toMatchObject({ coverage_pct: 31, total: 3 });
    expect(await version()).toBe("1");
  });

  it("writes only the topic whose title changed", async () => {
    await load([A1()]);
    const renamed = TOPICS.map((t) => (t.slug === "food" ? { ...t, titleRu: "Еда и напитки" } : t));
    expect((await load([A1()], { topics: renamed, hash: digest([A1()], TOPICS) })).changes).toBe(1);
    expect(await all("SELECT no, title_ru, title_tt FROM topics WHERE slug = 'food'")).toEqual([{ no: 8, title_ru: "Еда и напитки", title_tt: "Ризык" }]);
    expect(await countRows("topics")).toBe(3);
  });

  it("moves a word to another level: the note keeps its id, the learner's card its schedule, and the progress counter follows", async () => {
    await load([A1(), A2()]);
    const before = await noteOf("китап");
    const { repo, userId } = await learner(["китап", "су"]);
    await repo.insertReport(userId, before.id as number, T);
    await load([A1(), A2()]);
    expect(await progress()).toEqual([[userId, 1, 0, 1], [userId, 1, 8, 1]]);
    const cardsBefore = await cards();

    // «китап» leaves A1 and stands last in A2, with its topic.
    await load([lvl(1, [row("су"), row("юл", { topic: "food" })], 27), lvl(2, [...A2().rows, row("китап", { topic: "food" })], 36)]);

    expect(await noteOf("китап")).toEqual({ ...before, slug: "a2", level: 2, topic_no: 8, seq: 3, tseq: 8_000_003 });
    expect(await countRows("notes")).toBe(5);
    expect(await cards()).toEqual(cardsBefore);
    expect(await repo.getCardByNote(userId, before.id as number, "tt_ru")).toMatchObject({ word: "китап", mem: expect.objectContaining({ state: "review", reps: 1, due: T + 5 * 86_400_000 }) });
    expect(await countRows("reports")).toBe(1);
    expect(await progress()).toEqual([[userId, 1, 0, 1], [userId, 2, 8, 1]]);
    expect((await decks()).map((d) => [d.slug, d.total])).toEqual([["a1", 2], ["a2", 3]]);
    expect(await groups()).toEqual([[1, 0, 1], [1, 8, 1], [2, 0, 1], [2, 8, 1], [2, 12, 1]]);
    // The words that stay in A1 moved up one place.
    expect((await notes()).filter((n) => n.level === 1).map((n) => [n.word, n.seq, n.tseq])).toEqual([["су", 1, 1], ["юл", 2, 8_000_002]]);
    expect(await version()).toBe("2");
  });

  it("moves the totals of the pairs when a word changes its topic, and drops a pair that has no words left", async () => {
    await load([A1(), A2()]);
    const before = await noteOf("көн");
    const { userId } = await learner(["көн"]);

    await load([A1(), lvl(2, [row("авыл"), row("көн")], 36)]);

    expect(await noteOf("көн")).toEqual({ ...before, topic_no: 0, tseq: 2 });
    expect(await groups()).toEqual([[1, 0, 1], [1, 8, 2], [2, 0, 2]]);
    expect(await progress()).toEqual([[userId, 2, 0, 1]]);
  });

  it("follows the order of the rows in the file", async () => {
    await load([A1()]);
    const ids = (await notes()).map((n) => n.id);
    const [kitap, su, yul] = A1().rows;
    await load([lvl(1, [yul!, kitap!, su!], 27)]);
    expect((await notes()).map((n) => [n.id, n.word, n.seq, n.tseq])).toEqual([[ids[0], "китап", 2, 8_000_002], [ids[1], "су", 3, 3], [ids[2], "юл", 1, 8_000_001]]);
  });

  it("never erases the audio a voicing job attached; an audio id of the file only fills an empty one", async () => {
    await load([A1()]);
    await setAudio("китап", "VOICE1", 1);

    expect(await load([A1()])).toMatchObject({ changes: 0, rowsWritten: 0 });
    const filled = lvl(1, A1().rows.map((r) => ({ ...r, audio_file_id: r.word === "китап" ? "FILE1" : r.word === "су" ? "FILE2" : "" })), 27);
    expect((await load([filled], { hash: digest([A1()], TOPICS) })).changes).toBe(1);
    expect((await notes()).map((n) => n.audio_file_id)).toEqual(["VOICE1", "FILE2", null]);
    expect(await audioOf("китап")).toEqual({ audio_file_id: "VOICE1", audio_tries: 1 });
    expect(await load([filled], { hash: digest([A1()], TOPICS) })).toMatchObject({ changes: 0, rowsWritten: 0 });

    // A changed row keeps the voice too.
    await load([lvl(1, A1().rows.map((r) => ({ ...r, translation: `${r.translation}!` })), 27)]);
    expect((await notes()).map((n) => [n.translation, n.audio_file_id])).toEqual([["китап-ru!", "VOICE1"], ["су-ru!", "FILE2"], ["юл-ru!", null]]);
  });

  it("never deletes a note that left the files, nor the cards for it", async () => {
    await load([A1(), A2()]);
    const { userId } = await learner(["су", "авыл"]);
    const before = await notes();

    // «су» leaves A1; the file of A2 is gone altogether.
    await load([lvl(1, A1().rows.filter((r) => r.word !== "су"), 27)]);

    expect((await notes()).map((n) => [n.id, n.word, n.level])).toEqual(before.map((n) => [n.id, n.word, n.level]));
    expect(await countRows("cards")).toBe(2);
    expect((await decks()).map((d) => [d.slug, d.total])).toEqual([["a1", 3], ["a2", 2]]);
    expect(await groups()).toEqual([[1, 0, 1], [1, 8, 2], [2, 0, 1], [2, 12, 1]]);
    expect(await progress()).toEqual([[userId, 1, 0, 1], [userId, 2, 0, 1]]);
  });

  it("leaves a learner's own copy of a catalog word alone, and counts own words under the pair (0, 0)", async () => {
    const repo = new Repo(env.DB);
    const userId = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now: T });
    const own = await repo.customDeck(userId, T);
    const ownIds = await repo.insertNotes(own, [
      { word: "юл", transcription: null, pos: "n", translation: "мой путь", exampleTt: "", exampleRu: "", exampleSrc: "" },
      { word: "бакча", transcription: null, pos: "n", translation: "сад", exampleTt: "", exampleRu: "", exampleSrc: "" },
    ]);
    for (const id of ownIds) await repo.insertCard(userId, id, "tt_ru", gradedMem(T));
    const ownBefore = await all("SELECT * FROM notes ORDER BY id");

    await load([A1()], { renames: [{ oldWord: "бакча", newWord: "бакчалар" }] });

    expect(await all(`SELECT * FROM notes WHERE deck_id = ${own} ORDER BY id`)).toEqual(ownBefore);
    expect((await notes()).filter((n) => n.word === "юл").map((n) => [n.slug, n.level, n.translation])).toEqual([[null, null, "мой путь"], ["a1", 1, "юл-ru"]]);
    expect(await progress()).toEqual([[userId, 0, 0, 2]]);
    expect(await all("SELECT total FROM decks WHERE id = " + own)).toEqual([{ total: 2 }]);
  });

  describe("the recount of the learners' progress", () => {
    it("counts a word once however many of its cards are started, and never a card that is still new", async () => {
      await load([A1(), A2()]);
      const { repo, userId } = await learner(["китап", "юл", "авыл"]);
      await repo.insertCard(userId, (await noteOf("китап")).id as number, "ru_tt", gradedMem(T));
      await repo.insertCard(userId, (await noteOf("юл")).id as number, "ru_tt", newMem(T));
      await repo.insertCard(userId, (await noteOf("су")).id as number, "tt_ru", newMem(T));
      const { userId: other } = await learner(["китап"], 2);

      await load([A1(), A2()]);

      expect(await progress()).toEqual([[userId, 1, 8, 2], [userId, 2, 0, 1], [other, 1, 8, 1]]);
    });

    it("corrects a wrong counter and removes one that no started word stands behind", async () => {
      await load([A1(), A2()]);
      const { userId } = await learner(["китап"]);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO user_progress (user_id, level, topic_no, started) VALUES (?1, 1, 8, 7), (?1, 2, 12, 4), (?1, 0, 0, 0)").bind(userId),
        env.DB.prepare("INSERT INTO catalog_groups (level, topic_no, total) VALUES (5, 3, 9)"),
        env.DB.prepare("UPDATE catalog_groups SET total = 40 WHERE level = 1 AND topic_no = 8"),
      ]);

      // One counter corrected, two removed; one pair corrected, one removed.
      expect((await load([A1(), A2()])).changes).toBe(5);

      expect(await progress()).toEqual([[userId, 1, 8, 1]]);
      expect(await groups()).toEqual([[1, 0, 1], [1, 8, 2], [2, 0, 1], [2, 12, 1]]);
      expect(await load([A1(), A2()])).toMatchObject({ changes: 0, rowsWritten: 0 });
    });
  });

  describe("a corrected headword (data/renames.csv)", () => {
    const fixed = [{ oldWord: "китаб", newWord: "китап" }];
    const misspelled = () => lvl(1, [row("китаб", { translation: "книга", topic: "food" }), row("су")], 27);
    const corrected = () => lvl(1, [row("китап", { translation: "книга", topic: "food" }), row("су")], 27);

    it("renames the note in place: the id, the learners' cards and the reports stay, the voice is made again", async () => {
      await load([misspelled()]);
      const before = await noteOf("китаб");
      await setAudio("китаб", "OLD-VOICE", 2);
      const { repo, userId } = await learner(["китаб"]);
      await repo.insertReport(userId, before.id as number, T);
      const cardsBefore = await cards();

      await load([corrected()], { renames: fixed });

      expect(await notes()).toEqual([
        { ...before, word: "китап", word_key: "китап", transcription: "китап", example_tt: "Бу — китап.", audio_file_id: null },
        expect.objectContaining({ word: "су" }),
      ]);
      expect(await audioOf("китап")).toEqual({ audio_file_id: null, audio_tries: 0 });
      expect((await decks())[0]).toMatchObject({ total: 2 });
      expect(await cards()).toEqual(cardsBefore);
      expect(await repo.getCardByNote(userId, before.id as number, "tt_ru")).toMatchObject({ word: "китап", mem: expect.objectContaining({ state: "review", reps: 1 }) });
      expect((await repo.recentReports(10)).map((r) => [r.noteId, r.word])).toEqual([[before.id, "китап"]]);
      expect(await progress()).toEqual([[userId, 1, 8, 1]]);
    });

    it("writes nothing when the same seed is loaded again, and keeps the new voice", async () => {
      await load([misspelled()]);
      const sql = seed([corrected()], { renames: fixed });
      await applySeed(env.DB, sql);
      await setAudio("китап", "NEW-VOICE");
      for (let i = 0; i < 2; i++) expect(await applySeed(env.DB, sql)).toMatchObject({ changes: 0, rowsWritten: 0 });
      expect(await audioOf("китап")).toEqual({ audio_file_id: "NEW-VOICE", audio_tries: 0 });
      expect(await countRows("notes")).toBe(2);
    });

    it("finds the old word in any level, also when the corrected word stands in another one", async () => {
      await load([misspelled(), A2()]);
      const before = await noteOf("китаб");
      await load([lvl(1, [row("су")], 27), lvl(2, [...A2().rows, row("китап", { translation: "книга", topic: "food" })], 36)], { renames: fixed });
      expect(await noteOf("китап")).toMatchObject({ id: before.id, slug: "a2", level: 2, seq: 3, word_key: "китап" });
      expect(await countRows("notes")).toBe(4);
    });

    it("does nothing when the catalog already has the new word: neither note is touched", async () => {
      // An earlier deploy loaded the corrected word as a second note, next to the misspelled one.
      await load([misspelled()]);
      await load([lvl(1, [...misspelled().rows, row("китап")], 27)]);
      await setAudio("китаб", "OLD-VOICE", 1);
      const before = await notes();
      expect(before.map((n) => n.word)).toEqual(["китаб", "су", "китап"]);
      const again = lvl(1, [row("китап"), row("су")], 27);
      await load([again], { renames: fixed });
      const after = await notes();
      expect(after.map((n) => [n.id, n.word, n.audio_file_id])).toEqual(before.map((n) => [n.id, n.word, n.audio_file_id]));
      expect(await audioOf("китаб")).toEqual({ audio_file_id: "OLD-VOICE", audio_tries: 1 });
      expect(await load([again], { renames: fixed })).toMatchObject({ changes: 0, rowsWritten: 0 });
    });

    it("finds the old word by its key and stores the key of the new one", async () => {
      await load([lvl(1, [row("Сау бул!"), row("су")])]);
      const before = await noteOf("Сау бул!");
      expect(before.word_key).toBe("сау бул");
      await load([lvl(1, [row("Сау бул'ыгыз!"), row("су")])], { renames: [{ oldWord: " сау бул ", newWord: "Сау бул'ыгыз!" }] });
      expect((await notes())[0]).toMatchObject({ id: before.id, word: "Сау бул'ыгыз!", word_key: "сау бул'ыгыз" });
    });

    it("refuses a rename without an old or a new word", () => {
      expect(() => seed([corrected()], { renames: [{ oldWord: " ", newWord: "китап" }] })).toThrow(/rename.*old/);
      expect(() => seed([corrected()], { renames: [{ oldWord: "китаб", newWord: "?!" }] })).toThrow(/rename.*«китаб».*new/);
    });
  });
});
