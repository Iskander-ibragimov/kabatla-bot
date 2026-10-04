import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { csvToSql } from "../src/content/csv";
import { Repo } from "../src/db/repo";
import { dict } from "../src/i18n";
import { levelSlug } from "../src/users/service";
import { gradedMem } from "./helpers/review";
import { seedUser } from "./helpers/seed";
import { applySeed } from "./helpers/seedSql";

const T = Date.UTC(2026, 9, 3, 6);

const meta = (levelNo: number, coveragePct: number | null = 38) =>
  ({ slug: levelSlug(levelNo), titleRu: dict("ru").levelTitle(levelNo), titleTt: dict("tt").levelTitle(levelNo), levelNo, coveragePct });
const meta1 = meta(1);

/** A level row as the CSV holds it. */
const row = (word: string, over: Record<string, string> = {}): Record<string, string> => ({
  word, transcription: word, pos: "n", translation: `${word}-ru`, example_tt: `Бу — ${word}.`, example_ru: "Это слово.", example_src: "own", audio_file_id: "", ...over,
});

const countRows = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const notes = async () =>
  (await env.DB.prepare(
    "SELECT d.slug, n.id, n.word, n.word_key, n.transcription, n.pos, n.translation, n.example_tt, n.example_ru, n.example_src, n.audio_file_id FROM notes n JOIN decks d ON d.id = n.deck_id ORDER BY n.id",
  ).all<Record<string, unknown>>()).results;
const deckOf = async (slug: string) => (await env.DB.prepare("SELECT * FROM decks WHERE slug = ?").bind(slug).first<Record<string, unknown>>())!;

describe("catalog seed", () => {
  it("reseeding fixes card fields but keeps progress and audio", async () => {
    await applySeed(env.DB, csvToSql(meta1, [row("китап", { translation: "книга", audio_file_id: "AUD1" })]));
    const [before] = await notes();
    const { repo, user } = await seedUser(env.DB, { now: T });
    const cardId = await repo.insertCard(user.id, before!.id as number, "tt_ru", gradedMem(T));

    await applySeed(env.DB, csvToSql(meta1, [row("китап", { translation: "книга, том", example_ru: "Это книга.", audio_file_id: "" })]));

    const [note] = await notes();
    expect(note).toMatchObject({ id: before!.id, translation: "книга, том", example_ru: "Это книга.", audio_file_id: "AUD1" });
    expect(await countRows("cards")).toBe(1);
    expect(await countRows("notes")).toBe(1);
    expect(await repo.getCard(user.id, cardId)).toMatchObject({ noteId: before!.id, translation: "книга, том", mem: expect.objectContaining({ state: "review", reps: 1 }) });
  });

  it("creates level decks with level_no, coverage and both titles", async () => {
    await applySeed(env.DB, csvToSql(meta(6, 61), [row("авыл")]));
    const deck = await deckOf("l06");
    expect(deck).toMatchObject({ slug: "l06", level_no: 6, coverage_pct: 61, title_ru: "Уровень 6", title_tt: "6 нчы дәрәҗә", total: 1 });
    expect(deck).toMatchObject({ kind: "catalog", owner_id: null });
    expect(await new Repo(env.DB).getDeckBySlug("l06")).toMatchObject({ kind: "catalog", levelNo: 6, coveragePct: 61, total: 1 });
  });

  it("stores every column of the row, the word key, and NULL for an empty transcription or audio", async () => {
    await applySeed(env.DB, csvToSql(meta1, [
      row(" Китап ", { transcription: "кита́п", pos: "n", translation: "книга", example_tt: "Бу — китап.", example_ru: "Это книга.", example_src: "tatoeba:123", audio_file_id: "AUD1" }),
      row("су", { transcription: "" }),
    ]));
    expect(await notes()).toEqual([
      { slug: "l01", id: expect.any(Number), word: "Китап", word_key: "китап", transcription: "кита́п", pos: "n", translation: "книга", example_tt: "Бу — китап.", example_ru: "Это книга.", example_src: "tatoeba:123", audio_file_id: "AUD1" },
      { slug: "l01", id: expect.any(Number), word: "су", word_key: "су", transcription: null, pos: "n", translation: "су-ru", example_tt: "Бу — су.", example_ru: "Это слово.", example_src: "own", audio_file_id: null },
    ]);
    expect(await new Repo(env.DB).findCatalogNotes(["китап"])).toEqual(new Map([["китап", expect.objectContaining({ word: "Китап", levelNo: 1 })]]));
  });

  it("writes one statement per line: the deck, a line per note, the total", () => {
    const sql = csvToSql(meta1, [row("китап"), row("су"), row("юл")]);
    const lines = sql.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("");
    expect(lines[0]).toMatch(/^WITH .* INSERT INTO decks .*;$/);
    for (const line of lines.slice(1, 4)) expect(line).toMatch(/^WITH .* INSERT INTO notes .*;$/);
    expect(lines[4]).toMatch(/^UPDATE decks SET total .*;$/);
  });

  it("escapes apostrophes, commas, semicolons and line breaks", async () => {
    const tricky = row("кул'язма, кулъязма", {
      transcription: "къул'йазма́", translation: "рукопись; it's «a», b", example_tt: "Бу — 'кул'язма'; әйе.", example_ru: "Это\nрукопись\r\n'да'", example_src: "own",
    });
    const sql = csvToSql(meta1, [tricky, row("су")]);
    expect(sql.split("\n")).toHaveLength(5);
    const first = await applySeed(env.DB, sql);
    expect(first.statements).toBe(4);
    expect(await notes()).toEqual([
      expect.objectContaining({ word: tricky.word, word_key: "кул'язма, кулъязма", transcription: tricky.transcription, translation: tricky.translation, example_tt: tricky.example_tt, example_ru: tricky.example_ru }),
      expect.objectContaining({ word: "су" }),
    ]);
    expect(await applySeed(env.DB, sql)).toMatchObject({ changes: 0, rowsWritten: 0 });
  });

  it("refuses a row without a word, a translation or one of the columns, so that a broken file cannot blank a live card", () => {
    expect(() => csvToSql(meta1, [row("китап"), row(" ")])).toThrow(/l01.*line 3.*word/);
    expect(() => csvToSql(meta1, [row("китап", { translation: " " })])).toThrow(/l01.*line 2.*translation/);
    const { example_ru: _, ...short } = row("китап");
    expect(() => csvToSql(meta1, [short])).toThrow(/l01.*line 2.*example_ru/);
    const { audio_file_id: __, ...noAudio } = row("китап");
    expect(() => csvToSql(meta1, [noAudio])).toThrow(/l01.*line 2.*audio_file_id/);
  });

  it("writes no rows when an unchanged catalog is loaded again", async () => {
    const sql = [1, 2].map((n) => csvToSql(meta(n), [row(`бер${n}`), row(`ике${n}`, { audio_file_id: "AUD" }), row(`өч${n}`, { transcription: "" })])).join("");
    const first = await applySeed(env.DB, sql);
    expect(first.statements).toBe(10);
    expect(first.changes).toBe(10);
    expect(await countRows("notes")).toBe(6);

    const second = await applySeed(env.DB, sql);
    expect(second).toEqual({ statements: 10, changes: 0, rowsWritten: 0 });
    expect(await countRows("notes")).toBe(6);
  });

  it("rewrites only the row that changed, and the deck only when its total, titles or coverage change", async () => {
    await applySeed(env.DB, csvToSql(meta1, [row("бер"), row("ике"), row("өч")]));

    expect((await applySeed(env.DB, csvToSql(meta1, [row("бер"), row("ике", { translation: "два" }), row("өч")]))).changes).toBe(1);
    expect((await notes()).map((n) => n.translation)).toEqual(["бер-ru", "два", "өч-ru"]);

    expect((await applySeed(env.DB, csvToSql(meta1, [row("бер"), row("ике", { translation: "два" }), row("өч"), row("дүрт")]))).changes).toBe(2);
    expect(await deckOf("l01")).toMatchObject({ total: 4, coverage_pct: 38 });

    expect((await applySeed(env.DB, csvToSql(meta(1, 40), [row("бер"), row("ике", { translation: "два" }), row("өч"), row("дүрт")]))).changes).toBe(1);
    expect(await deckOf("l01")).toMatchObject({ total: 4, coverage_pct: 40 });
  });

  it("takes a deck without coverage and fills it in later", async () => {
    await applySeed(env.DB, csvToSql(meta(1, null), [row("бер")]));
    expect((await deckOf("l01")).coverage_pct).toBeNull();
    expect((await applySeed(env.DB, csvToSql(meta(1, null), [row("бер")]))).changes).toBe(0);
    expect((await applySeed(env.DB, csvToSql(meta(1, 31), [row("бер")]))).changes).toBe(1);
    expect((await deckOf("l01")).coverage_pct).toBe(31);
  });

  it("never erases the audio a voicing job attached, and takes a new audio id from the CSV", async () => {
    const sql = csvToSql(meta1, [row("китап"), row("су")]);
    await applySeed(env.DB, sql);
    const [kitap] = await notes();
    await env.DB.prepare("UPDATE notes SET audio_file_id = 'VOICE1' WHERE id = ?").bind(kitap!.id).run();

    expect(await applySeed(env.DB, sql)).toMatchObject({ changes: 0, rowsWritten: 0 });
    expect((await notes()).map((n) => n.audio_file_id)).toEqual(["VOICE1", null]);

    expect((await applySeed(env.DB, csvToSql(meta1, [row("китап", { audio_file_id: "VOICE1" }), row("су", { audio_file_id: "VOICE2" })]))).changes).toBe(1);
    expect((await notes()).map((n) => n.audio_file_id)).toEqual(["VOICE1", "VOICE2"]);

    await applySeed(env.DB, csvToSql(meta1, [row("китап", { audio_file_id: "VOICE3" }), row("су")]));
    expect((await notes()).map((n) => n.audio_file_id)).toEqual(["VOICE3", "VOICE2"]);
  });

  it("never deletes a note that left the CSV", async () => {
    await applySeed(env.DB, csvToSql(meta1, [row("китап"), row("су")]));
    expect((await applySeed(env.DB, csvToSql(meta1, [row("китап")]))).changes).toBe(0);
    expect((await notes()).map((n) => n.word)).toEqual(["китап", "су"]);
    expect(await deckOf("l01")).toMatchObject({ total: 2 });
  });

  it("never moves or copies a word to another level: it stays where it was first loaded", async () => {
    await applySeed(env.DB, csvToSql(meta1, [row("китап"), row("су")]));
    await applySeed(env.DB, csvToSql(meta(2), [row("Су", { translation: "вода" }), row("юл")]));
    expect((await notes()).map((n) => [n.slug, n.word, n.translation])).toEqual([["l01", "китап", "китап-ru"], ["l01", "су", "су-ru"], ["l02", "юл", "юл-ru"]]);
    expect(await deckOf("l02")).toMatchObject({ total: 1 });
  });

  describe("a corrected headword (data/renames.csv, ruling F1)", () => {
    const fixed = [{ oldWord: "китаб", newWord: "китап" }];
    const setAudio = (word: string, fileId: string, tries: number) =>
      env.DB.prepare("UPDATE notes SET audio_file_id = ?, audio_tries = ? WHERE word = ?").bind(fileId, tries, word).run();
    const audioOf = async (word: string) => env.DB.prepare("SELECT audio_file_id, audio_tries FROM notes WHERE word = ?").bind(word).first();

    it("renames the note in place: the id, the learners' cards and the reports stay, the voice is made again", async () => {
      await applySeed(env.DB, csvToSql(meta1, [row("китаб", { translation: "книга" }), row("су")]));
      const [before] = await notes();
      await setAudio("китаб", "OLD-VOICE", 2);
      const { repo, user } = await seedUser(env.DB, { now: T });
      const cardId = await repo.insertCard(user.id, before!.id as number, "tt_ru", gradedMem(T));
      await repo.insertReport(user.id, before!.id as number, T);

      const sql = csvToSql(meta1, [row("китап", { translation: "книга" }), row("су")], fixed);
      const first = await applySeed(env.DB, sql);
      // The rename, and the note's other fields from its row (transcription and example changed with the word).
      expect(first.changes).toBe(2);
      expect(await notes()).toEqual([
        expect.objectContaining({ slug: "l01", id: before!.id, word: "китап", word_key: "китап", transcription: "китап", translation: "книга", example_tt: "Бу — китап.", audio_file_id: null }),
        expect.objectContaining({ word: "су" }),
      ]);
      expect(await audioOf("китап")).toEqual({ audio_file_id: null, audio_tries: 0 });
      expect(await deckOf("l01")).toMatchObject({ total: 2 });
      expect(await countRows("cards")).toBe(1);
      expect(await repo.getCard(user.id, cardId)).toMatchObject({ noteId: before!.id, word: "китап", mem: expect.objectContaining({ state: "review", reps: 1 }) });
      expect((await repo.recentReports(10)).map((r) => [r.noteId, r.word])).toEqual([[before!.id, "китап"]]);
      // The corrected word is found, the misspelled one is gone.
      expect([...(await repo.findCatalogNotes(["китап", "китаб"])).keys()]).toEqual(["китап"]);
    });

    it("writes nothing when the same seed is loaded again, and keeps the new voice", async () => {
      await applySeed(env.DB, csvToSql(meta1, [row("китаб"), row("су")]));
      const sql = csvToSql(meta1, [row("китап"), row("су")], fixed);
      await applySeed(env.DB, sql);
      await setAudio("китап", "NEW-VOICE", 0);
      expect(await applySeed(env.DB, sql)).toMatchObject({ changes: 0, rowsWritten: 0 });
      expect(await applySeed(env.DB, sql)).toMatchObject({ changes: 0, rowsWritten: 0 });
      expect(await audioOf("китап")).toEqual({ audio_file_id: "NEW-VOICE", audio_tries: 0 });
      expect(await countRows("notes")).toBe(2);
    });

    it("does nothing when the level already has the new word: neither note is touched", async () => {
      // An earlier deploy loaded the corrected word as a second note, next to the misspelled one.
      await applySeed(env.DB, csvToSql(meta1, [row("китаб"), row("су")]));
      await applySeed(env.DB, csvToSql(meta1, [row("китап"), row("су")]));
      await setAudio("китаб", "OLD-VOICE", 1);
      const before = await notes();
      expect(before.map((n) => n.word)).toEqual(["китаб", "су", "китап"]);
      expect(await applySeed(env.DB, csvToSql(meta1, [row("китап"), row("су")], fixed))).toMatchObject({ changes: 0, rowsWritten: 0 });
      expect(await notes()).toEqual(before);
      expect(await audioOf("китаб")).toEqual({ audio_file_id: "OLD-VOICE", audio_tries: 1 });
    });

    it("does nothing when the old word is not in the level, and touches no other deck", async () => {
      await applySeed(env.DB, csvToSql(meta1, [row("китап"), row("су")]));
      await applySeed(env.DB, csvToSql(meta(2), [row("китаб")]));
      const { repo, user } = await seedUser(env.DB, { now: T });
      await repo.insertNotes(await repo.customDeck(user.id, T), [{ word: "китаб", transcription: null, pos: "n", translation: "моя книга", exampleTt: "", exampleRu: "", exampleSrc: "" }]);
      const before = await notes();
      expect(await applySeed(env.DB, csvToSql(meta1, [row("китап"), row("су")], fixed))).toMatchObject({ changes: 0, rowsWritten: 0 });
      // «китаб» of level 2 and the learner's own «китаб» are other notes: the rename is for level 1 only.
      expect(await notes()).toEqual(before);
      expect(before.filter((n) => n.word === "китаб").map((n) => n.slug)).toEqual(["l02", null]);
    });

    it("finds the old word by its key and stores the key of the new one", async () => {
      await applySeed(env.DB, csvToSql(meta1, [row("Сау бул!"), row("су")]));
      const [before] = await notes();
      expect(before!.word_key).toBe("сау бул");
      await applySeed(env.DB, csvToSql(meta1, [row("Сау бул'ыгыз!"), row("су")], [{ oldWord: " сау бул ", newWord: "Сау бул'ыгыз!" }]));
      expect((await notes())[0]).toMatchObject({ id: before!.id, word: "Сау бул'ыгыз!", word_key: "сау бул'ыгыз" });
    });

    it("stands in the seed after the deck and before the notes, one statement per line", () => {
      const lines = csvToSql(meta1, [row("китап"), row("су")], [...fixed, { oldWord: "со", newWord: "су" }]).split("\n");
      expect(lines).toHaveLength(7);
      expect(lines[0]).toMatch(/^WITH .* INSERT INTO decks .*;$/);
      for (const line of lines.slice(1, 3)) expect(line).toMatch(/^UPDATE notes SET word = .*;$/);
      for (const line of lines.slice(3, 5)) expect(line).toMatch(/^WITH .* INSERT INTO notes .*;$/);
      expect(lines[5]).toMatch(/^UPDATE decks SET total .*;$/);
    });

    it("refuses a rename without an old or a new word", () => {
      expect(() => csvToSql(meta1, [row("китап")], [{ oldWord: " ", newWord: "китап" }])).toThrow(/l01.*rename.*old/);
      expect(() => csvToSql(meta1, [row("китап")], [{ oldWord: "китаб", newWord: "?!" }])).toThrow(/l01.*rename.*new/);
    });
  });

  it("leaves a user's own copy of a level word alone", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const own = await repo.customDeck(user.id, T);
    await repo.insertNotes(own, [{ word: "юл", transcription: null, pos: "n", translation: "мой путь", exampleTt: "", exampleRu: "", exampleSrc: "" }]);
    await applySeed(env.DB, csvToSql(meta(2), [row("юл")]));
    expect((await notes()).filter((n) => n.word === "юл").map((n) => [n.slug, n.translation])).toEqual([[null, "мой путь"], ["l02", "юл-ru"]]);
  });
});
