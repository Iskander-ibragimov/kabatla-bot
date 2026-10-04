import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { newMem } from "../../src/srs/fsrs";
import { gradedMem } from "./review";
import { TOPICS, WORDS, note, recountProgress, seedCatalog, seedGuidedOrder, seedLearner, seedLevels, seedTopics, seedUser } from "./seed";

const T = Date.UTC(2026, 8, 30, 6);

describe("seed helpers", () => {
  it("seedLevels creates level decks l01… with the agreed note fields and returns their ids", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"], 6: ["авыл", "су"] }, { 6: 61 });
    const repo = new Repo(env.DB);
    expect(await repo.getDeckBySlug("l01")).toEqual({ id: ids[1], slug: "l01", ownerId: null, kind: "catalog", titleRu: "Уровень 1", titleTt: "1 нче дәрәҗә", levelNo: 1, coveragePct: null, total: 1 });
    expect(await repo.getDeckBySlug("l06")).toMatchObject({ slug: "l06", titleRu: "Уровень 6", titleTt: "6 нчы дәрәҗә", levelNo: 6, coveragePct: 61, total: 2 });
    const notes = await env.DB.prepare("SELECT word, translation, example_tt FROM notes WHERE deck_id = ? ORDER BY id").bind(ids[6]).all();
    expect(notes.results).toEqual([
      { word: "авыл", translation: "авыл-ru", example_tt: "авыл." },
      { word: "су", translation: "су-ru", example_tt: "су." },
    ]);
  });

  it("seedLevels sets coverage for a level that already exists", async () => {
    const { deckId } = await seedUser(env.DB, { now: T, words: 2 });
    const ids = await seedLevels(env.DB, { 2: ["авыл"] }, { 1: 31 });
    const repo = new Repo(env.DB);
    expect(await repo.getDeckBySlug("l01")).toMatchObject({ id: deckId, coveragePct: 31, total: 2 });
    expect(await repo.getDeckBySlug("l02")).toMatchObject({ id: ids[2], coveragePct: null, total: 1 });
  });

  it("seedUser gives an onboarded user subscribed to level 1 built from the first five WORDS", async () => {
    const { repo, user, deckId, noteIds } = await seedUser(env.DB, { now: T });
    expect(user).toMatchObject({ onboardingStep: null, level: 1, lang: "ru", direction: "tt_ru" });
    expect(await repo.userDeckIds(user.id)).toEqual([deckId]);
    expect(await repo.getDeckBySlug("l01")).toMatchObject({ id: deckId, levelNo: 1, total: 5 });
    expect(noteIds).toHaveLength(5);
    expect(await repo.visibleNote(user.id, noteIds[1]!)).toMatchObject({ word: WORDS[1]![0], translation: WORDS[1]![1], exampleTt: "вакыт." });
  });

  it("seedUser reuses an existing level deck instead of creating one from WORDS", async () => {
    const ids = await seedLevels(env.DB, { 4: ["дүрт", "биш"] });
    const first = await seedUser(env.DB, { now: T, level: 4, words: 9, tgId: 1 });
    const second = await seedUser(env.DB, { now: T, level: 4, tgId: 2 });
    expect(first.deckId).toBe(ids[4]);
    expect(second.deckId).toBe(ids[4]);
    expect(first.user.level).toBe(4);
    expect(second.noteIds).toEqual(first.noteIds);
    expect(await first.repo.getDeckBySlug("l04")).toMatchObject({ id: ids[4], total: 2 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM decks").first<{ n: number }>())!.n).toBe(1);
  });
});

describe("seedCatalog and the new columns", () => {
  it("numbers seq per level in call order, derives tseq and keeps catalog_groups in step", async () => {
    const ids = await seedCatalog(env.DB, [
      { level: 1, word: "бер", topic: 2 }, { level: 1, word: "ике", topic: 2 }, { level: 1, word: "өч" }, { level: 2, word: "дүрт", topic: 5 },
    ]);
    expect(ids).toHaveLength(4);
    const rows = await env.DB.prepare("SELECT level, topic_no, seq, tseq FROM notes ORDER BY id").all();
    expect(rows.results).toEqual([
      { level: 1, topic_no: 2, seq: 1, tseq: 2_000_001 }, { level: 1, topic_no: 2, seq: 2, tseq: 2_000_002 },
      { level: 1, topic_no: 0, seq: 3, tseq: 3 }, { level: 2, topic_no: 5, seq: 1, tseq: 5_000_001 },
    ]);
    const groups = await env.DB.prepare("SELECT level, topic_no, total FROM catalog_groups ORDER BY level, topic_no").all();
    expect(groups.results).toEqual([{ level: 1, topic_no: 0, total: 1 }, { level: 1, topic_no: 2, total: 2 }, { level: 2, topic_no: 5, total: 1 }]);
    const repo = new Repo(env.DB);
    expect(await repo.getDeckBySlug("a1")).toMatchObject({ levelNo: 1, total: 3 });
    expect(await repo.getDeckBySlug("a2")).toMatchObject({ levelNo: 2, total: 1 });
  });

  it("seedLevels fills level, topic 0, seq and catalog_groups for any level number", async () => {
    await seedLevels(env.DB, { 1: ["бер", "ике"], 12: ["өч"] });
    const rows = await env.DB.prepare("SELECT level, topic_no, seq, tseq FROM notes ORDER BY id").all();
    expect(rows.results).toEqual([
      { level: 1, topic_no: 0, seq: 1, tseq: 1 }, { level: 1, topic_no: 0, seq: 2, tseq: 2 }, { level: 12, topic_no: 0, seq: 1, tseq: 1 },
    ]);
    const groups = await env.DB.prepare("SELECT level, topic_no, total FROM catalog_groups ORDER BY level").all();
    expect(groups.results).toEqual([{ level: 1, topic_no: 0, total: 2 }, { level: 12, topic_no: 0, total: 1 }]);
  });

  it("seedUser sets the level mask from the level, or takes an explicit one", async () => {
    await seedLevels(env.DB, { 2: ["ике"], 3: ["өч"], 7: ["җиде"] }); // distinct words: a catalog word key is unique across levels
    expect((await seedUser(env.DB, { now: T, level: 2 })).user.levels).toBe(2);
    expect((await seedUser(env.DB, { now: T, level: 3, tgId: 2 })).user.levels).toBe(4);
    expect((await seedUser(env.DB, { now: T, level: 1, tgId: 3, levels: 31 })).user.levels).toBe(31);
    expect((await seedUser(env.DB, { now: T, level: 7, tgId: 4 })).user.levels).toBe(1);
  });

  it("seedLearner gives an onboarded user with the defaults of a new learner and creates no deck, so it goes with seedCatalog", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "бер" }]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both", levels: 3 } });
    expect(user).toMatchObject({ onboardingStep: null, tgId: 1, direction: "both", levels: 3, posGroups: 255, newMode: "guided", topicNo: null, tzOffsetMin: 180 });
    expect(user.nextDailyAt).toBeGreaterThan(T);
    expect(await repo.userDeckIds(user.id)).toEqual([]);
    expect((await env.DB.prepare("SELECT slug FROM decks").all()).results).toEqual([{ slug: "a1" }]);
    expect((await seedLearner(env.DB, { now: T, tgId: 7 })).user).toMatchObject({ tgId: 7, levels: 1, direction: "tt_ru" });
  });

  it("seedGuidedOrder gives the catalog notes the places of the catalog seed: themed and basic words in turn, level by level", async () => {
    await seedCatalog(env.DB, [
      { level: 1, word: "мин" }, { level: 1, word: "аш", topic: 8 }, { level: 1, word: "син" }, { level: 1, word: "эш", topic: 12 },
      { level: 2, word: "ул" }, { level: 2, word: "су", topic: 8 },
    ]);
    const tseq = async () => (await env.DB.prepare("SELECT word, tseq FROM notes ORDER BY level, tseq").all<{ word: string; tseq: number }>()).results.map((n) => [n.word, n.tseq]);
    expect(await tseq()).toEqual([["мин", 1], ["син", 3], ["аш", 8_000_002], ["эш", 12_000_004], ["ул", 1], ["су", 8_000_002]]);
    await seedGuidedOrder(env.DB);
    expect(await tseq()).toEqual([["аш", 8_000_001], ["мин", 8_000_002], ["эш", 12_000_001], ["син", 12_000_002], ["су", 8_000_001], ["ул", 8_000_002]]);
  });

  it("seedTopics fills the topics table with «Основа» and the twenty topics, by number", async () => {
    await seedTopics(env.DB);
    expect(TOPICS.map((t) => t.no)).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect((await new Repo(env.DB).levelsData(1, false)).topics).toEqual(TOPICS);
  });

  it("recountProgress sets the counters of started words to what the cards and the own words say: a word once, own words under (0, 0), a card never graded not at all, a catalog word the learner owns a copy of as started", async () => {
    const ids = await seedCatalog(env.DB, [
      { level: 1, word: "бер", topic: 6 }, { level: 1, word: "ике", topic: 6 }, { level: 2, word: "су", topic: 8 }, { level: 2, word: "юл", topic: 10 }, { level: 3, word: "көн", topic: 5 },
    ]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    // «көн» and «бер» are words of the catalog too: «көн» is started by the copy alone, «бер» by its cards and the copy, once.
    const [own] = await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем"), note("көн"), note("бер")]);
    await repo.batch([
      repo.insertCardStmt(user.id, ids[0]!, "tt_ru", gradedMem(T)), repo.insertCardStmt(user.id, ids[0]!, "ru_tt", gradedMem(T)),
      repo.insertCardStmt(user.id, ids[1]!, "tt_ru", gradedMem(T)), repo.insertCardStmt(user.id, ids[2]!, "ru_tt", gradedMem(T)),
      repo.insertCardStmt(user.id, ids[3]!, "tt_ru", newMem(T)), repo.insertCardStmt(user.id, own!, "tt_ru", gradedMem(T)),
    ]);
    // What stood there before is replaced, and another learner's counters are left alone.
    await env.DB.prepare("INSERT INTO user_progress (user_id, level, topic_no, started) VALUES (?1, 5, 5, 9), (?1 + 1, 1, 6, 4)").bind(user.id).run();
    await recountProgress(env.DB, user.id);
    expect(await repo.progress(user.id)).toEqual([
      { level: 0, topicNo: 0, started: 1 }, { level: 1, topicNo: 6, started: 2 }, { level: 2, topicNo: 8, started: 1 }, { level: 3, topicNo: 5, started: 1 },
    ]);
    expect(await repo.progress(user.id + 1)).toEqual([{ level: 1, topicNo: 6, started: 4 }]);
  });
});
