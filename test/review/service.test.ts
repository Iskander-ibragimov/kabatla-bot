import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type SeedLevel, type SeedTopic, catalogToSql } from "../../src/content/csv";
import { Repo, type User } from "../../src/db/repo";
import { LEVELS, levelBit } from "../../src/levels/scale";
import { ReviewService } from "../../src/review/service";
import { newMem } from "../../src/srs/fsrs";
import { countingDb } from "../helpers/countingDb";
import { asCard, gradeShown } from "../helpers/review";
import { WORDS, note, seedCatalog, seedLearner } from "../helpers/seed";
import { applySeed } from "../helpers/seedSql";
import { study } from "../helpers/sim";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 local (+03:00)

/** A learner with A1 checked and the first `words` (default 5) entries of WORDS as the words of A1, in that order. */
async function seedUser(db: D1Database, o: { now: number; words?: number; patch?: Partial<User> }) {
  const noteIds = await seedCatalog(db, WORDS.slice(0, o.words ?? 5).map(([word, translation]) => ({ level: 1, word, translation })));
  return { ...(await seedLearner(db, { now: o.now, patch: o.patch })), noteIds };
}

describe("review service", () => {
  it("first card shows reference intervals", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    expect(s.intervals).toEqual({ 1: "<1м", 2: "<6м", 3: "<10м", 4: "8д" });
    expect(s.view.word).toBe("китап");
    expect(s.view).toMatchObject({ direction: "tt_ru", translation: "книга", exampleTt: "китап.", transcription: null, hasAudio: false });
    // While a level has a word to give, the new cards to come are as many as the day allows (10), not the words left in the level.
    expect(s.counts).toEqual({ n: 10, l: 0, r: 0 });
    expect(s.feedback).toBeNull();
  });

  it("again brings the card back via learn-ahead when nothing else is left", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const first = asCard(await new ReviewService(repo, T).nextScreen(user));
    const u = (await repo.getUser(user.id))!;
    const next = asCard(await new ReviewService(repo, T + 1000).grade(u, first.view.cardId, 0, 1));
    expect(next.view.cardId).toBe(first.view.cardId);
    expect(next.feedback).toMatchObject({ kind: "step", word: "китап" });
    expect(next.canUndo).toBe(true);
  });

  it("stale callback is ignored, also after undo", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 2 });
    const svc = new ReviewService(repo, T);
    const s = asCard(await svc.nextScreen(user));
    expect((await svc.grade(user, s.view.cardId, 0, 3)).kind).toBe("card");
    expect((await svc.grade((await repo.getUser(user.id))!, s.view.cardId, 0, 3)).kind).toBe("stale");
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>();
    expect(logs!.n).toBe(1);
    const undone = asCard(await svc.undo((await repo.getUser(user.id))!));
    expect(undone.view.cardId).toBe(s.view.cardId);
    expect((await svc.grade((await repo.getUser(user.id))!, s.view.cardId, 1, 3)).kind).toBe("stale");
    expect((await svc.undo((await repo.getUser(user.id))!)).kind).toBe("noundo");
  });

  it("grow feedback shows before and after days", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 2 * DAY, scheduledDays: 2, stability: 2.3, difficulty: 5, reps: 2 });
    const s = await new ReviewService(repo, T).grade(user, id, 2, 3);
    expect(s.kind === "done" || s.kind === "card").toBe(true);
    const fb = s.kind === "done" || s.kind === "card" ? s.feedback : null;
    expect(fb).toMatchObject({ kind: "grow", beforeDays: 2 });
    expect(fb!.afterMs).toBeGreaterThan(2 * DAY);
  });

  it("lapse keeps memory", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 30 * DAY, scheduledDays: 30, stability: 30, difficulty: 5, reps: 5 });
    const s = await new ReviewService(repo, T).grade(user, id, 5, 1);
    const fb = s.kind === "done" || s.kind === "card" ? s.feedback : null;
    expect(fb).toMatchObject({ kind: "lapse", beforeDays: 30 });
    expect(fb!.keptDays).toBeGreaterThan(1);
    expect(fb!.afterMs).toBe(10 * MIN);
  });

  it("daily new limit uses the 04:00 local boundary", async () => {
    const local = (h: number, m: number) => Date.UTC(2026, 8, 30, h, m) - 180 * MIN;
    const { repo, user } = await seedUser(env.DB, { now: local(3, 0), words: 4, patch: { newPerDay: 2 } });
    let now = local(3, 30);
    for (let i = 0; i < 2; i++) {
      const s = asCard(await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!));
      await new ReviewService(repo, now).grade((await repo.getUser(user.id))!, s.view.cardId, 0, 3);
    }
    // Good (not Easy) spends the limit; the two learning cards come back, no third new word
    now = local(3, 50);
    expect(asCard(await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!)).counts.n).toBe(0);
    now = local(4, 10);
    const s = asCard(await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!));
    expect(s.counts.n).toBe(2);
  });

  it("the end of the session counts the grades and the words learned today, and gives no totals for all time", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 3 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 15 * DAY, scheduledDays: 15, stability: 15, difficulty: 4, reps: 4 });
    await repo.updateUser(user.id, { newPerDay: 0 });
    const s = await new ReviewService(repo, T).grade((await repo.getUser(user.id))!, id, 4, 3);
    if (s.kind !== "done") throw new Error(s.kind);
    expect(s.summary).toEqual({ reviewsToday: 1, learnedToday: 1, nextLearningInMs: null, streak: 1 });
    // No new words are allowed today (the limit is 0), so nothing is said about why none came.
    expect(s.empty).toBeNull();
  });

  it("streak grows on consecutive days and resets after a gap", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 5, patch: { streak: 4, lastStudyDay: "2026-09-29" } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    await new ReviewService(repo, T).grade(user, s.view.cardId, 0, 4);
    expect((await repo.getUser(user.id))!.streak).toBe(5);
    const later = T + 3 * DAY;
    const u = (await repo.getUser(user.id))!;
    const s2 = asCard(await new ReviewService(repo, later).nextScreen(u));
    await new ReviewService(repo, later).grade(u, s2.view.cardId, s2.view.reps, 3);
    expect((await repo.getUser(user.id))!.streak).toBe(1);
  });

  it("sibling in the other direction is hidden until tomorrow", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { direction: "both" } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    expect(s.view.direction).toBe("tt_ru");
    const after = await new ReviewService(repo, T).grade(user, s.view.cardId, 0, 4);
    expect(after.kind).toBe("done");
    const tomorrow = asCard(await new ReviewService(repo, T + DAY).nextScreen((await repo.getUser(user.id))!));
    expect(tomorrow.view.direction).toBe("ru_tt");
  });

  it("grade uses at most 4 D1 calls", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 5 });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    const db = countingDb(env.DB);
    await new ReviewService(new Repo(db), T).grade((await repo.getUser(user.id))!, s.view.cardId, 0, 3);
    expect(db.calls).toBeLessThanOrEqual(4);
  });

  describe("the counters of started words", () => {
    it("a first grade adds the word to the counter of its level and topic, a later grade adds nothing, and undo takes the word back", async () => {
      await seedCatalog(env.DB, [{ level: 1, word: "китап", topic: 8 }, { level: 1, word: "су", topic: 8 }]);
      const { repo, user } = await seedLearner(env.DB, { now: T });
      const me = async () => (await repo.getUser(user.id))!;
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      expect(await repo.progress(user.id)).toEqual([]);
      const second = asCard(await new ReviewService(repo, T).grade(await me(), first.view.cardId, 0, 1));
      expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 8, started: 1 }]);
      expect(second.view.word).toBe("су");
      const third = asCard(await new ReviewService(repo, T + 1000).grade(await me(), second.view.cardId, 0, 3));
      expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 8, started: 2 }]);
      // «китап» is back from its learning step; its second grade starts no word.
      expect(third.view.cardId).toBe(first.view.cardId);
      await new ReviewService(repo, T + 2000).grade(await me(), third.view.cardId, third.view.reps, 3);
      expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 8, started: 2 }]);
      // Undo of the second grade of «китап»: the word stays started.
      expect(asCard(await new ReviewService(repo, T + 3000).undo(await me())).view.word).toBe("китап");
      expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 8, started: 2 }]);
      // Undo of the grade before it, the first grade of «су»: the word is not started any more.
      expect(asCard(await new ReviewService(repo, T + 4000).undo(await me())).view.word).toBe("су");
      expect(await repo.progress(user.id)).toEqual([{ level: 1, topicNo: 8, started: 1 }]);
    });

    it("after grades of catalog and own words the counters are what the catalog seed counts: loading the same catalog again writes nothing", async () => {
      const topics: SeedTopic[] = [{ no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" }, { no: 8, slug: "food", titleRu: "Еда", titleTt: "Ризык" }];
      const row = (word: string, topic: string) =>
        ({ word, transcription: word, pos: "n", translation: `${word}-ru`, example_tt: `Бу — ${word}.`, example_ru: "Это слово.", example_src: "own", topic, audio_file_id: "" });
      const level = (no: number, rows: Record<string, string>[]): SeedLevel => {
        const { slug, code } = LEVELS[no - 1]!;
        return { level: no, slug, titleRu: code, titleTt: code, coveragePct: null, rows };
      };
      const sql = catalogToSql([level(1, [row("китап", "food"), row("су", "core"), row("юл", "food")]), level(2, [row("авыл", "core"), row("көн", "food")])], topics, [], "one");
      await applySeed(env.DB, sql);
      const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both", levels: levelBit(1) | levelBit(2) } });
      await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем1"), note("үзем2")]);
      // Three days of both directions with every grade there is; the learner leaves whenever «авыл» comes up, so it is never started.
      for (const d of [0, 1, 2]) await study(repo, user.id, T + d * DAY, { rate: (_, nth) => ((nth % 4) + 1) as 1 | 2 | 3 | 4, leaveAt: (v) => v.word === "авыл" });
      const counted = await repo.progress(user.id);
      expect(counted).toEqual([
        { level: 0, topicNo: 0, started: 2 }, { level: 1, topicNo: 0, started: 1 }, { level: 1, topicNo: 8, started: 2 }, { level: 2, topicNo: 8, started: 1 },
      ]);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND state != 'new'").bind(user.id).first<{ n: number }>())!.n).toBeGreaterThan(6);
      expect((await applySeed(env.DB, sql)).rowsWritten).toBe(0);
      expect(await repo.progress(user.id)).toEqual(counted);
      // A counter that is off is put right by the load, so the load does compare them.
      await env.DB.prepare("UPDATE user_progress SET started = 5 WHERE user_id = ? AND level = 1 AND topic_no = 8").bind(user.id).run();
      expect((await applySeed(env.DB, sql)).rowsWritten).toBeGreaterThan(0);
      expect(await repo.progress(user.id)).toEqual(counted);
    });
  });

  it("two parallel taps on the same button grade once", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 3, patch: { streak: 2, lastStudyDay: "2026-09-29" } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    const results = await Promise.all([
      new ReviewService(repo, T).grade(user, s.view.cardId, 0, 3),
      new ReviewService(repo, T).grade(user, s.view.cardId, 0, 3),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["card", "stale"]);
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>();
    expect(logs!.n).toBe(1);
    const u = (await repo.getUser(user.id))!;
    expect(u.streak).toBe(3);
    expect(u.mixCounter).toBe(1);
  });

  describe("new-word queue", () => {
    const insertEasyNewLogs = async (db: D1Database, userId: number, n: number, now: number) => {
      await db.batch(Array.from({ length: n }, () => db.prepare(
        `INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new)
         VALUES (0, ?, 4, '{}', 0, 0, ?, 1)`).bind(userId, now)));
    };

    it("does not spend the daily limit on a new word graded Easy", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, words: 12, patch: { newPerDay: 5 } });
      let s = await new ReviewService(repo, T).nextScreen(user);
      for (let i = 0; i < 3; i++) s = await gradeShown(repo, user, s, 4, T);
      expect(s.kind === "card" && s.counts.n).toBe(5);
      s = await gradeShown(repo, user, s, 3, T);
      expect(s.kind === "card" && s.counts.n).toBe(4);
    });

    it("stops new words after 200 Easy-on-first-sight grades in a day", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, words: 5 });
      await insertEasyNewLogs(env.DB, user.id, 200, T);
      const s = await new ReviewService(repo, T).nextScreen(user);
      expect(s.kind).not.toBe("card");
    });
  });
});
