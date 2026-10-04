import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { WORDS, seedCatalog, seedLearner, seedLevels, seedUser } from "./seed";

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
});
