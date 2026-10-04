import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Direction, LAST_LEVEL, type NewScope, Repo, wordKey } from "../../src/db/repo";
import { countingDb } from "../helpers/countingDb";
import { newMem } from "../../src/srs/fsrs";
import { dayWindow } from "../../src/users/service";
import { gradedMem, logStmt } from "../helpers/review";
import { note, seedLevels, seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6, 0, 0);
const DAY = 86_400_000;
/** Level 1 in the order of the level, every part of speech, no read position. */
const LEVEL_1: NewScope = { levels: [1], posCodes: null, mode: "freq", topicNo: null, spans: {}, spansVersion: 0 };

async function seed(repo: Repo) {
  const deckId = await repo.insertDeck({ slug: "l01", kind: "catalog", titleRu: "Уровень 1", titleTt: "1 нче дәрәҗә", levelNo: 1, coveragePct: null, ownerId: null });
  const ids = await repo.insertNotes(deckId, [
    { word: "китап", transcription: "кита́п", pos: "n", translation: "книга", exampleTt: "Бу китап яңа.", exampleRu: "Эта книга новая.", exampleSrc: "own" },
    { word: "Алма", transcription: null, pos: "n", translation: "яблоко", exampleTt: "Алма тәмле.", exampleRu: "Яблоко вкусное." },
    { word: "зур", transcription: null, pos: "adj", translation: "большой", exampleTt: "Өй зур.", exampleRu: "Дом большой." },
  ].map((n, i) => ({ ...n, level: 1, topicNo: 0, seq: i + 1 })));
  const userId = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now: T });
  await repo.subscribe(userId, deckId, T);
  return { deckId, ids, userId };
}

describe("repo", () => {
  let repo: Repo;
  beforeEach(() => { repo = new Repo(env.DB); });

  it("unique card per user note direction", async () => {
    const { ids, userId } = await seed(repo);
    await repo.insertCard(userId, ids[0]!, "tt_ru", newMem(T));
    await expect(repo.insertCard(userId, ids[0]!, "tt_ru", newMem(T))).rejects.toThrow();
    await repo.insertCard(userId, ids[0]!, "ru_tt", newMem(T));
  });

  it("queue returns due learning, due-today reviews, the next new word and counts in one batch", async () => {
    const { ids, userId } = await seed(repo);
    await repo.insertCard(userId, ids[0]!, "tt_ru", { ...newMem(T), state: "learning", step: 1, due: T - 1000, reps: 1, lastReview: T - 600_000, stability: 2, difficulty: 5 });
    await repo.insertCard(userId, ids[1]!, "tt_ru", { ...newMem(T), state: "review", due: T + 3 * 3_600_000, scheduledDays: 2, reps: 2, lastReview: T - 2 * DAY, stability: 2, difficulty: 5 });
    const db = countingDb(env.DB);
    const r = new Repo(db);
    const c = await r.queue(userId, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["tt_ru"] }, LEVEL_1);
    expect(db.calls).toBe(1);
    expect(c.learning.map((x) => x.word)).toEqual(["китап"]);
    expect(c.review.map((x) => x.word)).toEqual(["Алма"]);
    expect(c.streams[1]!.map((x) => x.word)).toEqual(["зур"]);
    expect(c.counts).toEqual({ learning: 1, review: 1, newDoneToday: 0, easyNewToday: 0 });
    expect(c.learning[0]!.mem.state).toBe("learning");
    expect(c.learning[0]).toMatchObject({ transcription: "кита́п", exampleTt: "Бу китап яңа.", exampleSrc: "own", audioFileId: null });
    expect(c.streams[1]![0]).toMatchObject({ transcription: null, exampleTt: "Өй зур.", exampleSrc: "" });
  });

  it("offers both directions of a new note Tatar → Russian first", async () => {
    const { userId } = await seed(repo);
    const directions: Direction[] = ["tt_ru", "ru_tt"];
    const c = await repo.queue(userId, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions }, LEVEL_1);
    expect(c.streams[1]!.map((x) => [x.word, x.direction])).toEqual([["китап", "tt_ru"], ["китап", "ru_tt"]]);
  });

  it("a deck numbered above the last level is not a level: not for /levels or the lookup of ready cards", async () => {
    expect(LAST_LEVEL).toBe(20);
    const { repo, user } = await seedUser(env.DB, { now: T, level: 20, words: 1 });
    const ids = await seedLevels(env.DB, { 21: ["авыл"] }, { 20: 80 });
    // The learner is done with the levels: «level 21», the number of that deck.
    await repo.updateUser(user.id, { level: 21 });
    expect(await repo.userDeckIds(user.id)).not.toContain(ids[21]);
    // /levels goes by the scale A1…C1 (1–5): neither deck is a level of it.
    expect((await repo.levelsData(user.id, false)).decks).toEqual([]);
    expect((await repo.findCatalogNotes(["авыл"])).size).toBe(0);
  });

  it("reads a deck with its level number, coverage and both titles", async () => {
    const { deckId, userId } = await seed(repo);
    expect(await repo.getDeckBySlug("l01")).toEqual({ id: deckId, slug: "l01", ownerId: null, kind: "catalog", titleRu: "Уровень 1", titleTt: "1 нче дәрәҗә", levelNo: 1, coveragePct: null, total: 3 });
    const ownId = await repo.customDeck(userId, T);
    const [own] = await repo.ownDecks(userId);
    expect(own).toMatchObject({ id: ownId, kind: "custom", ownerId: userId, titleRu: "Мои слова", titleTt: "Минем сүзләр", levelNo: null });
  });

  it("findNotesForUser is case-insensitive and trims", async () => {
    const { userId } = await seed(repo);
    const hits = await repo.findNotesForUser(userId, ["  алма ", "чия"]);
    expect([...hits.keys()]).toEqual(["алма"]);
    expect(hits.get("алма")).toMatchObject({ word: "Алма", deckTitleRu: "Уровень 1", deckTitleTt: "1 нче дәрәҗә" });
  });

  it("attaches a link only to a note in a deck the user owns, and only when the note has none", async () => {
    const { ids, userId } = await seed(repo);
    const other = await repo.insertUser({ tgId: 2, chatId: 2, lang: "ru", now: T });
    const [mine, linked] = await repo.insertNotes(await repo.customDeck(userId, T), [note("рәхмәт"), { ...note("сәлам"), sourceUrl: "https://old.example" }]);
    const [theirs] = await repo.insertNotes(await repo.customDeck(other, T), [note("дус")]);
    const res = await repo.batch([
      repo.setNoteSourceUrlStmt(userId, ids[0]!, "https://x.example/level"),   // a level word: shared by everyone
      repo.setNoteSourceUrlStmt(userId, theirs!, "https://x.example/theirs"),  // another user's word
      repo.setNoteSourceUrlStmt(userId, linked!, "https://x.example/second"),  // has a link already
      repo.setNoteSourceUrlStmt(userId, mine!, "https://x.example/mine"),
    ]);
    expect(res.map((r) => r.meta.changes)).toEqual([0, 0, 0, 1]);
    const { results } = await env.DB.prepare("SELECT id, source_url FROM notes WHERE id IN (?, ?, ?, ?) ORDER BY id").bind(ids[0], mine, linked, theirs).all();
    expect(results).toEqual([
      { id: ids[0], source_url: null }, { id: mine, source_url: "https://x.example/mine" }, { id: linked, source_url: "https://old.example" }, { id: theirs, source_url: null },
    ]);
  });

  it("findNotesForUser tells whether the note is in a deck the user owns", async () => {
    const { userId } = await seed(repo);
    await repo.insertNotes(await repo.customDeck(userId, T), [note("рәхмәт")]);
    const found = await repo.findNotesForUser(userId, ["китап", "рәхмәт"]);
    expect(found.get("китап")).toMatchObject({ word: "китап", owned: false, deckTitleRu: "Уровень 1" });
    expect(found.get("рәхмәт")).toMatchObject({ word: "рәхмәт", owned: true, deckTitleRu: "Мои слова" });
  });

  it("updateUser patches only given fields", async () => {
    const { userId } = await seed(repo);
    await repo.updateUser(userId, { streak: 3, lastStudyDay: "2026-09-30" });
    const u = await repo.getUserByTg(1);
    expect(u?.streak).toBe(3);
    expect(u?.lastStudyDay).toBe("2026-09-30");
    expect(u?.lang).toBe("ru");
  });
});

describe("schema", () => {
  it("accepts only ru and tt as interface language", async () => {
    await expect(env.DB.prepare("INSERT INTO users (tg_id, chat_id, lang, created_at) VALUES (1, 1, 'en', 0)").run()).rejects.toThrow();
    await env.DB.prepare("INSERT INTO users (tg_id, chat_id, lang, created_at) VALUES (1, 1, 'tt', 0)").run();
    const u = await env.DB.prepare("SELECT direction, level FROM users").first();
    expect(u).toEqual({ direction: "tt_ru", level: 1 });
  });

  it("has the Tatar note columns and none of the English ones", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(notes)").all()).results.map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(["transcription", "example_tt", "example_src", "audio_tries"]));
    expect(cols).not.toEqual(expect.arrayContaining(["ipa"]));
    expect(cols).not.toContain("example_en");
    expect(cols).not.toContain("audio_url");
  });

  it("allows one level deck per level number", async () => {
    await seedLevels(env.DB, { 1: ["бер"] });
    await expect(new Repo(env.DB).insertDeck({ slug: "x", kind: "catalog", titleRu: "x", titleTt: "x", levelNo: 1, coveragePct: null, ownerId: null })).rejects.toThrow();
  });

  it("accepts only tt_ru and ru_tt as card direction", async () => {
    const { ids, userId } = await seed(new Repo(env.DB));
    const card = (direction: string) => env.DB.prepare("INSERT INTO cards (user_id, note_id, direction, state, due) VALUES (?, ?, ?, 'new', 0)").bind(userId, ids[0], direction).run();
    await expect(card("en_ru")).rejects.toThrow();
    await expect(card("both")).rejects.toThrow();
    await card("tt_ru");
    await card("ru_tt");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first<{ n: number }>())!.n).toBe(2);
  });

  it("keeps one report per user and note", async () => {
    const report = (userId: number, noteId: number) => env.DB.prepare("INSERT INTO reports (user_id, note_id, created_at) VALUES (?, ?, 0)").bind(userId, noteId).run();
    await report(1, 1);
    await report(2, 1);
    await report(1, 2);
    await expect(report(1, 1)).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>())!.n).toBe(3);
  });
});

describe("a note's link is read only by the owner of its deck", () => {
  const STRAY = "https://stray.example/left-by-someone";
  const OWN = "https://own.example/mine";
  const window = { ...dayWindow(180, T), directions: ["tt_ru" as const] };

  /** Level 1 with «китап» carrying a link written straight into the row, and a learner with a linked word of their own. */
  async function planted() {
    const a = await seedUser(env.DB, { now: T, words: 1, tgId: 1 }); // l01: китап
    const b = await seedUser(env.DB, { now: T, words: 1, tgId: 2 });
    const level = a.noteIds[0]!;
    await env.DB.prepare("UPDATE notes SET source_url = ? WHERE id = ?").bind(STRAY, level).run();
    const [own] = await a.repo.insertNotes(await a.repo.customDeck(a.user.id, T), [{ ...note("рәхмәт"), sourceUrl: OWN }]);
    return { repo: a.repo, a: a.user.id, b: b.user.id, level, own: own! };
  }

  it("the word lookups give no link for a level note and the owner's link for an own note", async () => {
    const { repo, a, b, level, own } = await planted();
    for (const viewer of [a, b]) {
      expect((await repo.findNotesForUser(viewer, ["китап"])).get("китап")!.sourceUrl).toBeNull();
      expect((await repo.visibleNote(viewer, level))!.sourceUrl).toBeNull();
    }
    expect((await repo.findCatalogNotes(["китап"])).get("китап")!.sourceUrl).toBeNull();
    expect((await repo.findNotesForUser(a, ["рәхмәт"])).get("рәхмәт")).toMatchObject({ sourceUrl: OWN, owned: true });
    expect((await repo.visibleNote(a, own))!.sourceUrl).toBe(OWN);
    // The row itself is not touched: nothing is deleted from the database.
    expect(await env.DB.prepare("SELECT source_url FROM notes WHERE id = ?").bind(level).first()).toEqual({ source_url: STRAY });
  });

  it("the queue and the card give no link for a level note and the owner's link for an own note", async () => {
    const { repo, a, b, level, own } = await planted();
    for (const viewer of [a, b]) {
      const fresh = await repo.queue(viewer, window, LEVEL_1);
      expect(fresh.streams[1]!.find((n) => n.noteId === level)).toMatchObject({ word: "китап", sourceUrl: null });
      const id = await repo.insertCard(viewer, level, "tt_ru", { ...newMem(T), state: "learning", step: 0, due: T - 1 });
      expect((await repo.getCard(viewer, id))!.sourceUrl).toBeNull();
      expect((await repo.getCardByNote(viewer, level, "tt_ru"))!.sourceUrl).toBeNull();
      expect((await repo.queue(viewer, window, LEVEL_1)).learning.map((c) => [c.word, c.sourceUrl])).toEqual([["китап", null]]);
      await env.DB.prepare("UPDATE cards SET state = 'review' WHERE id = ?").bind(id).run();
      expect((await repo.queue(viewer, window, LEVEL_1)).review.map((c) => [c.word, c.sourceUrl])).toEqual([["китап", null]]);
    }
    expect((await repo.queue(a, window, LEVEL_1)).ownNew.find((n) => n.noteId === own)).toMatchObject({ word: "рәхмәт", sourceUrl: OWN });
    const mine = await repo.insertCard(a, own, "tt_ru", { ...newMem(T), state: "learning", step: 0, due: T - 1 });
    expect((await repo.getCard(a, mine))!.sourceUrl).toBe(OWN);
    expect((await repo.getCardByNote(a, own, "tt_ru"))!.sourceUrl).toBe(OWN);
    expect((await repo.queue(a, window, LEVEL_1)).learning.map((c) => [c.word, c.sourceUrl])).toEqual([["рәхмәт", OWN]]);
    await env.DB.prepare("UPDATE cards SET state = 'review' WHERE id = ?").bind(mine).run();
    expect((await repo.queue(a, window, LEVEL_1)).review.map((c) => c.sourceUrl)).toContain(OWN);
    // A card that another learner somehow holds for that own note shows them no link.
    const foreign = await repo.insertCard(b, own, "tt_ru", newMem(T));
    expect((await repo.getCard(b, foreign))!.sourceUrl).toBeNull();
    expect((await repo.getCardByNote(b, own, "tt_ru"))!.sourceUrl).toBeNull();
    expect((await repo.visibleNote(b, own))!.sourceUrl).toBeNull();
  });
});

describe("wordKey", () => {
  it("ignores case, extra spaces and the punctuation at the edges of a word or phrase", () => {
    expect(wordKey("Рәхмәт!")).toBe("рәхмәт");
    expect(wordKey(" Хәлләр  ничек? ")).toBe("хәлләр ничек");
    expect(wordKey("Минем исемем …")).toBe("минем исемем");
    expect(wordKey("Мин белмим.")).toBe("мин белмим");
    expect(wordKey("«Сүз»")).toBe("сүз");
    expect(wordKey("(\"сүз\")")).toBe("сүз");
    expect(wordKey("'сүз'")).toBe("сүз");
    expect(wordKey("— сүз: ")).toBe("сүз");
    expect(wordKey("сүз – ")).toBe("сүз");
    expect(wordKey("сүз;,-")).toBe("сүз");
    expect(wordKey("?! ...")).toBe("");
  });
  it("ignores typographic quotes at the edges: a phrase copied from a chat is found without them", () => {
    expect(wordKey("“Рәхмәт!”")).toBe("рәхмәт");
    expect(wordKey("„сүз“")).toBe("сүз");
    expect(wordKey("‘сүз’")).toBe("сүз");
    expect(wordKey("сүз’")).toBe("сүз");
    expect(wordKey("«“Хәлләр ничек?”»")).toBe("хәлләр ничек");
    expect(wordKey("“ ”")).toBe("");
    // Inside a phrase they stay.
    expect(wordKey("кул’язма")).toBe("кул’язма");
    expect(wordKey("ул “әйе” диде")).toBe("ул “әйе” диде");
  });
  it("keeps the punctuation inside", () => {
    expect(wordKey("Юк, рәхмәт!")).toBe("юк, рәхмәт");
    expect(wordKey("кул'язма, кулъязма")).toBe("кул'язма, кулъязма");
    expect(wordKey("ак-кара")).toBe("ак-кара");
    expect(wordKey("Әйе… юк.")).toBe("әйе… юк");
  });
});

describe("migration 0002: word keys without the punctuation at the edges", () => {
  const migration = () => env.TEST_MIGRATIONS.find((m) => m.name === "0002_word_key_punctuation.sql")!;
  /** The key as it was built before the migration: trimmed, lower case, single spaces. */
  const oldKey = (w: string) => w.trim().toLowerCase().replace(/\s+/g, " ");
  const insert = (deckId: number, word: string) =>
    env.DB.prepare("INSERT INTO notes (deck_id, word, word_key, translation) VALUES (?, ?, ?, 'перевод')").bind(deckId, word, oldKey(word)).run();
  const keys = async (deckId: number) =>
    (await env.DB.prepare("SELECT word, word_key FROM notes WHERE deck_id = ? ORDER BY id").bind(deckId).all<{ word: string; word_key: string }>()).results;
  const run = async () => { for (const q of migration().queries) await env.DB.prepare(q).run(); };

  it("rewrites the stored keys the way wordKey builds them now", async () => {
    const repo = new Repo(env.DB);
    const l1 = (await seedLevels(env.DB, { 1: [] }))[1]!;
    const words = ["Рәхмәт!", "Хәлләр ничек?", "Мин белмим.", "Минем исемем …", "Юк, рәхмәт!", "китап", "«Сүз»", "(\"авыл\")", "'су'", "— юл:", "ак-кара;", "көн –"];
    for (const w of words) await insert(l1, w);
    expect((await keys(l1)).map((r) => r.word_key)).toContain("рәхмәт!");
    await run();
    expect(await keys(l1)).toEqual(words.map((word) => ({ word, word_key: wordKey(word) })));
    expect((await keys(l1)).map((r) => r.word_key)).toEqual(
      ["рәхмәт", "хәлләр ничек", "мин белмим", "минем исемем", "юк, рәхмәт", "китап", "сүз", "авыл", "су", "юл", "ак-кара", "көн"]);
    // The lookup that missed the phrase before now finds it.
    expect((await repo.findCatalogNotes(["рәхмәт"])).get("рәхмәт")).toMatchObject({ word: "Рәхмәт!", levelNo: 1 });
    // A second run changes nothing.
    await run();
    expect((await keys(l1)).map((r) => r.word_key)).toContain("минем исемем");
    expect(await keys(l1)).toHaveLength(words.length);
  });

  it("leaves a row alone when its new key is taken in the same deck, and does not fail", async () => {
    const ids = await seedLevels(env.DB, { 1: [], 2: [] });
    for (const w of ["сау бул", "Сау бул!", "Сау бул…", "Әйе!"]) await insert(ids[1]!, w);
    await insert(ids[2]!, "Әйе.");
    await run();
    expect(await keys(ids[1]!)).toEqual([
      { word: "сау бул", word_key: "сау бул" }, { word: "Сау бул!", word_key: "сау бул!" }, { word: "Сау бул…", word_key: "сау бул…" }, { word: "Әйе!", word_key: "әйе" },
    ]);
    // The same word in another deck is not a collision.
    expect(await keys(ids[2]!)).toEqual([{ word: "Әйе.", word_key: "әйе" }]);
  });

  it("keeps a key that is nothing but punctuation", async () => {
    const l1 = (await seedLevels(env.DB, { 1: [] }))[1]!;
    await insert(l1, "?!");
    await run();
    expect(await keys(l1)).toEqual([{ word: "?!", word_key: "?!" }]);
  });
});

describe("migration 0006: word keys without typographic quotes at the edges", () => {
  const migration = () => env.TEST_MIGRATIONS.find((m) => m.name === "0006_word_key_quotes.sql")!;
  /** The key as it was built before the migration: without the edge punctuation of migration 0002, typographic quotes kept. */
  const EDGES_0002 = /^[ .,!?\u2026:;\u00AB\u00BB"'()\-\u2013\u2014]+|[ .,!?\u2026:;\u00AB\u00BB"'()\-\u2013\u2014]+$/g;
  const oldKey = (w: string) => w.trim().toLowerCase().replace(/\s+/g, " ").replace(EDGES_0002, "");
  const insert = (deckId: number, word: string) =>
    env.DB.prepare("INSERT INTO notes (deck_id, word, word_key, translation) VALUES (?, ?, ?, 'перевод')").bind(deckId, word, oldKey(word)).run();
  const keys = async (deckId: number) =>
    (await env.DB.prepare("SELECT word, word_key FROM notes WHERE deck_id = ? ORDER BY id").bind(deckId).all<{ word: string; word_key: string }>()).results;
  const run = async () => { for (const q of migration().queries) await env.DB.prepare(q).run(); };

  it("rewrites the stored keys the way wordKey builds them now", async () => {
    const repo = new Repo(env.DB);
    const l1 = (await seedLevels(env.DB, { 1: [] }))[1]!;
    const words = ["“Рәхмәт!”", "„Сүз“", "‘су’", "юл’", "«“Хәлләр ничек?”»", "китап", "Юк, рәхмәт!", "кул’язма", "ул “әйе” диде", "(“авыл”)."];
    for (const w of words) await insert(l1, w);
    expect((await keys(l1)).map((r) => r.word_key)).toContain("“рәхмәт!”");
    await run();
    expect(await keys(l1)).toEqual(words.map((word) => ({ word, word_key: wordKey(word) })));
    expect((await keys(l1)).map((r) => r.word_key)).toEqual(
      ["рәхмәт", "сүз", "су", "юл", "хәлләр ничек", "китап", "юк, рәхмәт", "кул’язма", "ул “әйе” диде", "авыл"]);
    // The lookup that missed the phrase before now finds it.
    expect((await repo.findCatalogNotes(["рәхмәт"])).get("рәхмәт")).toMatchObject({ word: "“Рәхмәт!”", levelNo: 1 });
    // A second run changes nothing.
    const before = await keys(l1);
    await run();
    expect(await keys(l1)).toEqual(before);
  });

  it("leaves a row alone when its new key is taken in the same deck, and does not fail", async () => {
    const ids = await seedLevels(env.DB, { 1: [], 2: [] });
    for (const w of ["сау бул", "“Сау бул”", "‘Сау бул’", "“Әйе”"]) await insert(ids[1]!, w);
    await insert(ids[2]!, "„Әйе“");
    await run();
    expect(await keys(ids[1]!)).toEqual([
      { word: "сау бул", word_key: "сау бул" }, { word: "“Сау бул”", word_key: "“сау бул”" }, { word: "‘Сау бул’", word_key: "‘сау бул’" }, { word: "“Әйе”", word_key: "әйе" },
    ]);
    // The same word in another deck is not a collision.
    expect(await keys(ids[2]!)).toEqual([{ word: "„Әйе“", word_key: "әйе" }]);
  });

  it("keeps a key that is nothing but quotes and punctuation", async () => {
    const l1 = (await seedLevels(env.DB, { 1: [] }))[1]!;
    await insert(l1, "“…”");
    await run();
    expect(await keys(l1)).toEqual([{ word: "“…”", word_key: "“…”" }]);
  });
});

describe("migration 0003: learners whose level has no open deck start at the nearest level the catalog has (ruling T16c)", () => {
  const migration = () => env.TEST_MIGRATIONS.find((m) => m.name === "0003_start_level_for_stranded_users.sql")!;
  const run = async () => { for (const q of migration().queries) await env.DB.prepare(q).run(); };
  /** A user who finished onboarding at `level` (or is still on `step`), subscribed to nothing. */
  async function userAt(tgId: number, level: number, step: string | null = null) {
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId, chatId: tgId, lang: "ru", now: T });
    await repo.updateUser(id, { level, onboardingStep: step });
    return id;
  }
  const levelOf = async (id: number) => (await new Repo(env.DB).getUser(id))!.level;
  const decksOf = (id: number) => new Repo(env.DB).userDeckIds(id);
  const snapshot = async () => ({
    users: (await env.DB.prepare("SELECT * FROM users ORDER BY id").all()).results,
    subscriptions: (await env.DB.prepare("SELECT * FROM user_decks ORDER BY user_id, deck_id").all()).results,
  });

  it("is two statements: the deck is opened first, then the level is moved", () => {
    expect(migration().queries.map((q) => q.trim().split(/\s+/).slice(0, 2).join(" "))).toEqual(["INSERT OR", "UPDATE users"]);
  });

  it("the owner's case: level 4, only level 1 published, nothing open → level 1 with level 1 open", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"] });
    const owner = await userAt(1, 4);
    await run();
    expect(await levelOf(owner)).toBe(1);
    expect(await decksOf(owner)).toEqual([ids[1]]);
    const row = await env.DB.prepare("SELECT added_at FROM user_decks WHERE user_id = ?").bind(owner).first<{ added_at: number }>();
    expect(Math.abs(row!.added_at - Date.now())).toBeLessThan(60_000);
  });

  it("the same learner after «Открыть пропущенные»: level 1, still one subscription row, with its date", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"] });
    const owner = await userAt(1, 4);
    await new Repo(env.DB).subscribe(owner, ids[1]!, T);
    await run();
    expect(await levelOf(owner)).toBe(1);
    expect((await env.DB.prepare("SELECT deck_id, added_at FROM user_decks WHERE user_id = ?").bind(owner).all()).results).toEqual([{ deck_id: ids[1], added_at: T }]);
  });

  it("leaves alone a learner whose level is open, one in onboarding and one who finished every level", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"], 2: ["ике"] });
    const repo = new Repo(env.DB);
    const settled = await userAt(1, 2);
    await repo.subscribe(settled, ids[2]!, T);
    const onboarding = await userAt(2, 4, "tz");
    const placing = await userAt(3, 1, "placement");
    const done = await userAt(4, 21);
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
    expect([await levelOf(settled), await levelOf(onboarding), await levelOf(placing), await levelOf(done)]).toEqual([2, 4, 1, 21]);
    expect(await decksOf(onboarding)).toEqual([]);
    expect(await decksOf(done)).toEqual([]);
  });

  it("changes nothing while the catalog has no levels", async () => {
    const repo = new Repo(env.DB);
    const stranded = await userAt(1, 4);
    // A deck of the learner's own is not a level.
    await repo.customDeck(stranded, T);
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
    expect(await levelOf(stranded)).toBe(4);
  });

  it("applies the start-level rule: the highest level not above the learner's, else the lowest one", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"], 3: ["өч"] });
    const between = await userAt(1, 2);
    const above = await userAt(2, 10);
    await run();
    expect([await levelOf(between), await levelOf(above)]).toEqual([1, 3]);
    expect(await decksOf(between)).toEqual([ids[1]]);
    expect(await decksOf(above)).toEqual([ids[3]]);
    // Only levels above the learner's exist: the lowest of them.
    await env.DB.batch(["user_decks", "notes", "decks", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const high = await seedLevels(env.DB, { 5: ["биш"], 8: ["сигез"] });
    const below = await userAt(3, 2);
    await run();
    expect(await levelOf(below)).toBe(5);
    expect(await decksOf(below)).toEqual([high[5]]);
  });

  it("opens the learner's own level when its deck exists but was never opened, and keeps the level", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"], 4: ["дүрт"] });
    const owner = await userAt(1, 4);
    await run();
    expect(await levelOf(owner)).toBe(4);
    expect(await decksOf(owner)).toEqual([ids[4]]);
  });

  it("touches neither cards, review history, own words nor other subscriptions, and a second run changes nothing", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер", "ике"] });
    const repo = new Repo(env.DB);
    const owner = await userAt(1, 4);
    const own = await repo.customDeck(owner, T);
    const [ownNote] = await repo.insertNotes(own, [note("үзем")]);
    const cardId = await repo.insertCard(owner, ownNote!, "tt_ru", { ...newMem(T), state: "review", reps: 1, due: T + DAY, scheduledDays: 1, stability: 1, difficulty: 5, lastReview: T });
    await logStmt(env.DB, { cardId, userId: owner, rating: 3, stateBefore: newMem(T), intervalBeforeDays: 0, intervalAfterMs: DAY, reviewedAt: T, wasNew: true }).run();
    const rest = async () => ({
      cards: (await env.DB.prepare("SELECT * FROM cards").all()).results,
      log: (await env.DB.prepare("SELECT * FROM review_log").all()).results,
      notes: (await env.DB.prepare("SELECT * FROM notes").all()).results,
      decks: (await env.DB.prepare("SELECT * FROM decks").all()).results,
    });
    const before = await rest();
    await run();
    expect(await rest()).toEqual(before);
    expect(await levelOf(owner)).toBe(1);
    expect((await decksOf(owner)).sort((a, b) => a - b)).toEqual([ids[1]!, own].sort((a, b) => a - b));
    const once = await snapshot();
    await run();
    expect(await snapshot()).toEqual(once);
  });
});
