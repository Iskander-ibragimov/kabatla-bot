import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderStats } from "../../src/bot/screens";
import { Repo } from "../../src/db/repo";
import { ReviewService } from "../../src/review/service";
import { cumulative } from "../../src/stats/service";
import { type Mem, newMem } from "../../src/srs/fsrs";
import { harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { note, recountProgress, seedCatalog, seedLearner } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
const DAY = 86_400_000;

/** A card in review whose interval is `days`: «учу» below 7 days, «знаю» from 7, «выучено» from 21. */
const reviewing = (days: number): Mem => ({ ...gradedMem(T), scheduledDays: days, stability: days });
const setCoverage = (level: number, pct: number) => env.DB.prepare("UPDATE decks SET coverage_pct = ? WHERE level_no = ?").bind(pct, level).run();

describe("stats", () => {
  it("cumulative totals by stage, memory, retention and forecast", async () => {
    const ids = await seedCatalog(env.DB, ["китап", "вакыт", "авыл", "су"].map((word) => ({ level: 1, word })));
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { newPerDay: 0 } });
    const a = await repo.insertCard(user.id, ids[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 25 * DAY, scheduledDays: 25, stability: 25, difficulty: 5, reps: 5 });
    const b = await repo.insertCard(user.id, ids[1]!, "tt_ru", { ...newMem(T), state: "review", due: T + 2 * DAY, lastReview: T - 8 * DAY, scheduledDays: 10, stability: 10, difficulty: 5, reps: 3 });
    await recountProgress(env.DB, user.id);
    await new ReviewService(repo, T).grade(user, a, 5, 3);
    await new ReviewService(repo, T + 1000).grade((await repo.getUser(user.id))!, b, 3, 1);
    const s = await cumulative(repo, (await repo.getUser(user.id))!, T + 2000);
    expect(s.learned).toBe(1);
    expect(s.learning).toBe(1);
    expect(s.fresh).toBe(2);
    expect(s.total).toBe(2);
    expect(s.r30).toBe(2);
    expect(s.retention30).toBe(0.5);
    expect(s.memory).toBeGreaterThan(25);
    expect(s.forecast7).toHaveLength(7);
    expect(s.forecast7[0]).toBe(1);
    expect(s.streak).toBe(1);
    expect(s.levels).toEqual([1]);
    expect(s.coveragePct).toBeNull();
  });

  it("levels: the checked levels; fresh: the cards of the checked levels that are not started, by the counters", async () => {
    const ids = await seedCatalog(env.DB, [
      ...["китап", "вакыт", "авыл"].map((word) => ({ level: 1, word })), ...["су", "юл"].map((word) => ({ level: 2, word })), { level: 3, word: "көн" },
    ]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { levels: 0b101 } });
    // Own words are no cards of a level: they are not among the new words ahead.
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем1"), note("үзем2")]);
    expect(await cumulative(repo, user, T)).toMatchObject({ levels: [1, 3], fresh: 4, learned: 0, known: 0, learning: 0 });
    // Two words of A1 and one of A2, which is not checked: the word of A2 is not taken from what A1 and B1 have left.
    for (const id of [ids[0]!, ids[1]!, ids[3]!]) await repo.insertCard(user.id, id, "tt_ru", gradedMem(T));
    await recountProgress(env.DB, user.id);
    expect(await cumulative(repo, user, T)).toMatchObject({ levels: [1, 3], fresh: 2 });
    expect(await cumulative(repo, { ...user, levels: 0b111 }, T)).toMatchObject({ levels: [1, 2, 3], fresh: 3 });
    expect(await cumulative(repo, { ...user, levels: 0b10 }, T)).toMatchObject({ levels: [2], fresh: 1 });
    // A counter that says more than the level has (a word left the level and the catalog was not loaded again) gives 0, not less.
    await env.DB.prepare("UPDATE user_progress SET started = 9 WHERE user_id = ? AND level = 1").bind(user.id).run();
    expect((await cumulative(repo, user, T)).fresh).toBe(1);
  });

  it("coveragePct: the coverage of the highest level up to which every level is started whole, else none", async () => {
    const ids = await seedCatalog(env.DB, [...["китап", "вакыт"].map((word) => ({ level: 1, word })), { level: 2, word: "су" }, { level: 3, word: "көн" }]);
    for (const [level, pct] of [[1, 45], [2, 60], [3, 70]] as const) await setCoverage(level, pct);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { levels: 0b101 } });
    const after = async (noteId: number) => {
      await repo.insertCard(user.id, noteId, "tt_ru", gradedMem(T));
      await recountProgress(env.DB, user.id);
      return (await cumulative(repo, user, T)).coveragePct;
    };
    expect((await cumulative(repo, user, T)).coveragePct).toBeNull();
    // B1 is started whole, but A1 below it is not.
    expect(await after(ids[3]!)).toBeNull();
    expect(await after(ids[0]!)).toBeNull();
    expect(await after(ids[1]!)).toBe(45);
    // A2 is not checked; once its words are started it counts all the same, and B1 above it with it.
    expect(await after(ids[2]!)).toBe(70);
  });

  it("the stages are counted over the learner's own cards in the direction shown", async () => {
    const ids = await seedCatalog(env.DB, ["китап", "вакыт", "авыл", "су", "юл", "көн"].map((word) => ({ level: 1, word })));
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    const [own] = await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем")]);
    await repo.batch([
      repo.insertCardStmt(user.id, ids[0]!, "tt_ru", reviewing(21)),
      repo.insertCardStmt(user.id, ids[1]!, "tt_ru", reviewing(20)),
      repo.insertCardStmt(user.id, ids[2]!, "tt_ru", reviewing(7)),
      repo.insertCardStmt(user.id, ids[3]!, "tt_ru", reviewing(6)),
      repo.insertCardStmt(user.id, ids[4]!, "tt_ru", { ...gradedMem(T), state: "relearning", step: 0 }),
      // A card that was shown and not graded is in no stage; an own word is counted like any other.
      repo.insertCardStmt(user.id, ids[5]!, "tt_ru", newMem(T)),
      repo.insertCardStmt(user.id, own!, "tt_ru", { ...gradedMem(T), state: "learning", step: 1 }),
      // The other direction of a word and another learner's cards are not counted.
      repo.insertCardStmt(user.id, ids[0]!, "ru_tt", reviewing(30)),
      repo.insertCardStmt(other.user.id, ids[0]!, "tt_ru", reviewing(30)),
    ]);
    expect(await repo.stageCounts(user.id, "tt_ru")).toEqual({ learned: 1, known: 2, learning: 3 });
    expect(await repo.stageCounts(user.id, "ru_tt")).toEqual({ learned: 1, known: 0, learning: 0 });
    expect(await repo.stageCounts(other.user.id, "ru_tt")).toEqual({ learned: 0, known: 0, learning: 0 });
    expect(await cumulative(repo, user, T)).toMatchObject({ learned: 1, known: 2, learning: 3 });
    expect(await cumulative(repo, { ...user, direction: "ru_tt" }, T)).toMatchObject({ learned: 1, known: 0, learning: 0 });
  });

  it("/stats names the checked levels and the coverage, within the budget of D1 calls", async () => {
    const ids = await seedCatalog(env.DB, [{ level: 1, word: "китап" }, { level: 2, word: "су" }, { level: 2, word: "юл" }]);
    await setCoverage(1, 45);
    const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42, patch: { levels: 0b11 } });
    const none = await cumulative(repo, user, T);
    expect(renderStats(none, "ru")).toContain("🎓 Уровни: A1, A2\n🏆 Выучено: 0");
    expect(renderStats(none, "tt")).toContain("🎓 Дәрәҗәләр: A1, A2\n");
    await repo.insertCard(user.id, ids[0]!, "tt_ru", gradedMem(T));
    await recountProgress(env.DB, user.id);
    const s = await cumulative(repo, user, T);
    expect(s).toMatchObject({ levels: [1, 2], coveragePct: 45, fresh: 2 });
    expect(renderStats(s, "ru")).toContain("🎓 Уровни: A1, A2 · покрытие текста ≈45%\n🏆 Выучено: 0\n🌳 Знаю: 0\n🌿 Учу: 1\n🌱 Новых впереди: 2");
    expect(renderStats(s, "tt")).toContain("🎓 Дәрәҗәләр: A1, A2 · текстта таныш сүзләр: ≈45%");

    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/stats");
    expect(h.lastText()).toContain("🎓 Уровни: A1, A2 · покрытие текста ≈45%");
    expect(db.calls).toBeLessThanOrEqual(8);
    // The numbers alone, without the read of the user: three reads.
    db.calls = 0;
    await cumulative(new Repo(db), user, T);
    expect(db.calls).toBe(3);
  });
});
