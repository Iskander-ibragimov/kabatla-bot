import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { countingDb } from "../helpers/countingDb";
import { newMem } from "../../src/srs/fsrs";
import { seedLevels } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6, 0, 0);
const DAY = 86_400_000;

async function seed(repo: Repo) {
  const deckId = await repo.insertDeck({ slug: "l01", kind: "catalog", titleRu: "Уровень 1", titleTt: "1 нче дәрәҗә", levelNo: 1, coveragePct: null, ownerId: null });
  const ids = await repo.insertNotes(deckId, [
    { word: "китап", transcription: "кита́п", pos: "n", translation: "книга", exampleTt: "Бу китап яңа.", exampleRu: "Эта книга новая.", exampleSrc: "own" },
    { word: "Алма", transcription: null, pos: "n", translation: "яблоко", exampleTt: "Алма тәмле.", exampleRu: "Яблоко вкусное." },
    { word: "зур", transcription: null, pos: "adj", translation: "большой", exampleTt: "Өй зур.", exampleRu: "Дом большой." },
  ]);
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

  it("candidateCards returns due learning, due-today reviews, unseen notes and counts in one batch", async () => {
    const { ids, userId } = await seed(repo);
    await repo.insertCard(userId, ids[0]!, "tt_ru", { ...newMem(T), state: "learning", step: 1, due: T - 1000, reps: 1, lastReview: T - 600_000, stability: 2, difficulty: 5 });
    await repo.insertCard(userId, ids[1]!, "tt_ru", { ...newMem(T), state: "review", due: T + 3 * 3_600_000, scheduledDays: 2, reps: 2, lastReview: T - 2 * DAY, stability: 2, difficulty: 5 });
    const db = countingDb(env.DB);
    const r = new Repo(db);
    const c = await r.candidateCards(userId, T, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["tt_ru"] });
    expect(db.calls).toBe(1);
    expect(c.learning.map((x) => x.word)).toEqual(["китап"]);
    expect(c.review.map((x) => x.word)).toEqual(["Алма"]);
    expect(c.newNotes.map((x) => x.word)).toEqual(["зур"]);
    expect(c.counts).toEqual({ learning: 1, review: 1, newAvailable: 1, newDoneToday: 0 });
    expect(c.learning[0]!.mem.state).toBe("learning");
    expect(c.learning[0]).toMatchObject({ transcription: "кита́п", exampleTt: "Бу китап яңа.", exampleSrc: "own", audioFileId: null });
    expect(c.newNotes[0]).toMatchObject({ transcription: null, exampleTt: "Өй зур.", exampleSrc: "" });
  });

  it("offers both directions of a new note Tatar → Russian first", async () => {
    const { userId } = await seed(repo);
    const c = await repo.candidateCards(userId, T, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["tt_ru", "ru_tt"] });
    expect(c.newNotes.slice(0, 4).map((x) => [x.word, x.direction])).toEqual([["китап", "tt_ru"], ["китап", "ru_tt"], ["Алма", "tt_ru"], ["Алма", "ru_tt"]]);
  });

  it("reads a deck with its level number, coverage and both titles", async () => {
    const { deckId, userId } = await seed(repo);
    expect(await repo.getDeck(deckId)).toEqual({ id: deckId, slug: "l01", ownerId: null, kind: "catalog", titleRu: "Уровень 1", titleTt: "1 нче дәрәҗә", levelNo: 1, coveragePct: null, total: 3 });
    const own = await repo.getDeck(await repo.customDeck(userId, T));
    expect(own).toMatchObject({ kind: "custom", ownerId: userId, titleRu: "Мои слова", titleTt: "Минем сүзләр", levelNo: null });
  });

  it("findNoteForUser is case-insensitive and trims", async () => {
    const { userId } = await seed(repo);
    const hit = await repo.findNoteForUser(userId, "  алма ");
    expect(hit).toMatchObject({ word: "Алма", deckTitleRu: "Уровень 1", deckTitleTt: "1 нче дәрәҗә" });
    expect(await repo.findNoteForUser(userId, "чия")).toBeNull();
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
