import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { newMem } from "../../src/srs/fsrs";
import { gradedMem } from "./review";
import { TOPICS, WORDS, levelWords, note, recountProgress, seedCatalog, seedGuidedOrder, seedLearner, seedTopics, seedUser } from "./seed";

const T = Date.UTC(2026, 8, 30, 6);

const subscriptions = async (userId: number) =>
  (await env.DB.prepare("SELECT deck_id FROM user_decks WHERE user_id = ? ORDER BY deck_id").bind(userId).all<{ deck_id: number }>()).results.map((r) => r.deck_id);

describe("seed helpers", () => {
  it("seedUser gives an onboarded learner over A1 built from the first five WORDS, subscribed to nothing", async () => {
    const { repo, user, deckId, noteIds } = await seedUser(env.DB, { now: T });
    expect(user).toMatchObject({ onboardingStep: null, levels: 1, lang: "ru", direction: "tt_ru" });
    expect(await subscriptions(user.id)).toEqual([]);
    expect(await repo.getDeckBySlug("a1")).toEqual({ id: deckId, slug: "a1", ownerId: null, kind: "catalog", titleRu: "A1", titleTt: "A1", levelNo: 1, coveragePct: null, total: 5 });
    expect(noteIds).toHaveLength(5);
    const notes = await env.DB.prepare("SELECT id, word, translation, example_tt, level, topic_no, seq FROM notes ORDER BY seq").all();
    expect(notes.results).toEqual(WORDS.slice(0, 5).map(([word, translation], i) => ({ id: noteIds[i], word, translation, example_tt: `${word}.`, level: 1, topic_no: 0, seq: i + 1 })));
  });

  it("seedUser takes A1 as it is when it has words already, and a second learner shares it", async () => {
    const ids = await seedCatalog(env.DB, levelWords(1, ["дүрт", "биш"]));
    const first = await seedUser(env.DB, { now: T, words: 9, tgId: 1 });
    const second = await seedUser(env.DB, { now: T, tgId: 2, patch: { levels: 3 } });
    expect(first.noteIds).toEqual(ids);
    expect(second.noteIds).toEqual(ids);
    expect(second.deckId).toBe(first.deckId);
    expect([first.user.levels, second.user.levels]).toEqual([1, 3]);
    expect(await first.repo.getDeckBySlug("a1")).toMatchObject({ id: first.deckId, total: 2 });
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

  it("levelWords gives the rows of one level for seedCatalog, in the order given", async () => {
    expect(levelWords(2, ["бер", "ике"])).toEqual([{ level: 2, word: "бер" }, { level: 2, word: "ике" }]);
    await expect(seedCatalog(env.DB, levelWords(6, ["алты"]))).rejects.toThrow("no level 6");
  });

  it("seedLearner gives an onboarded user with the defaults of a new learner and creates no deck, so it goes with seedCatalog", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "бер" }]);
    const { user } = await seedLearner(env.DB, { now: T, patch: { direction: "both", levels: 3 } });
    expect(user).toMatchObject({ onboardingStep: null, tgId: 1, direction: "both", levels: 3, posGroups: 255, newMode: "guided", topicNo: null, tzOffsetMin: 180 });
    expect(user.nextDailyAt).toBeGreaterThan(T);
    expect(await subscriptions(user.id)).toEqual([]);
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
