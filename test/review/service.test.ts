import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type SeedLevel, type SeedTopic, catalogToSql } from "../../src/content/csv";
import { Repo, type User } from "../../src/db/repo";
import { LEVELS, levelBit } from "../../src/levels/scale";
import { ReviewService } from "../../src/review/service";
import { formatInterval, newMem } from "../../src/srs/fsrs";
import { ALL_HINTS, HINT } from "../../src/tutorial/hints";
import { countingDb } from "../helpers/countingDb";
import { asCard, gradeShown } from "../helpers/review";
import { WORDS, note, seedCatalog, seedLearner, seedUser } from "../helpers/seed";
import { applySeed } from "../helpers/seedSql";
import { study } from "../helpers/sim";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 local (+03:00)

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

  describe("hints", () => {
    /** The screen that follows a grade of the card on screen `s`, with the user's row as the database holds it. */
    const graded = async (repo: Repo, user: User, s: ReturnType<typeof asCard>, rating: 1 | 2 | 3 | 4, now = T) =>
      new ReviewService(repo, now).grade((await repo.getUser(user.id))!, s.view.cardId, s.view.reps, rating);
    const seen = async (repo: Repo, user: User) => (await repo.getUser(user.id))!.hintsSeen;

    it("a learner fresh from the introduction: the hint of the first card until a grade, then the hint of each button once, with the interval the grade gave", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, patch: { hintsSeen: HINT.update } });
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      expect(first.lead).toEqual({ kind: "front" });
      // Showing a card stores nothing about the hints: the grade does.
      expect(await seen(repo, user)).toBe(HINT.update);
      const second = asCard(await graded(repo, user, first, 3));
      expect(second.lead).toEqual({ kind: "button", rating: 3, interval: first.intervals[3], withOrder: true });
      expect(await seen(repo, user)).toBe(HINT.update | HINT.front | HINT.good | HINT.order);
      const third = asCard(await graded(repo, user, second, 3));
      expect(third.lead).toBeNull();
      const fourth = asCard(await graded(repo, user, third, 1));
      expect(fourth.lead).toEqual({ kind: "button", rating: 1, interval: third.intervals[1], withOrder: false });
      expect(await seen(repo, user)).toBe(HINT.update | HINT.front | HINT.good | HINT.order | HINT.again);
      // A screen that follows no grade carries nothing once a card was graded.
      expect(asCard(await new ReviewService(repo, T).nextScreen((await repo.getUser(user.id))!)).lead).toBeNull();
    });

    it("the interval of a hint is the one that stood on the pressed button, not the one the scheduler's fuzz gave the card", async () => {
      // «Легко» on a new card gives days, which the scheduler moves a little; among these users are grades that land on another day than the button named.
      await seedCatalog(env.DB, WORDS.slice(0, 2).map(([word, translation]) => ({ level: 1, word, translation })));
      const moved: boolean[] = [];
      for (const [tgId, lang, at] of [[1, "tt", T], [2, "ru", T + 7 * MIN], [3, "ru", T + 3 * 60 * MIN], [4, "tt", T + DAY + 11 * MIN]] as const) {
        const { repo, user } = await seedLearner(env.DB, { now: T, tgId, patch: { hintsSeen: HINT.update, lang } });
        const first = asCard(await new ReviewService(repo, at).nextScreen(user));
        const second = asCard(await graded(repo, user, first, 4, at));
        expect(second.lead).toEqual({ kind: "button", rating: 4, interval: first.intervals[4], withOrder: true });
        expect(first.intervals[4]).toMatch(lang === "tt" ? /^\d+көн$/ : /^\d+д$/);
        const card = (await repo.getCard(user.id, first.view.cardId))!;
        moved.push(formatInterval(card.mem.due - at, lang) !== first.intervals[4]);
      }
      expect(moved).toContain(true);
    });

    it("a learner who knew the bot before the levels: the update notice until a grade, no hint after it", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, patch: { hintsSeen: ALL_HINTS } });
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      expect(first.lead).toEqual({ kind: "update" });
      expect(asCard(await graded(repo, user, first, 3)).lead).toBeNull();
      expect(await seen(repo, user)).toBe(127);
    });

    it("the screen that ends a session carries the hint of the grade before it; without a grade the update notice, never the hint of the first card", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { hintsSeen: HINT.update } });
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      const done = await graded(repo, user, first, 4);
      expect(done).toMatchObject({ kind: "done", lead: { kind: "button", rating: 4, withOrder: true } });
      const end = async (hintsSeen: number) => new ReviewService(repo, T).nextScreen({ ...(await repo.getUser(user.id))!, hintsSeen });
      expect(await end(127)).toMatchObject({ kind: "done", lead: null });
      expect(await end(HINT.update)).toMatchObject({ kind: "done", lead: null });
      expect(await end(ALL_HINTS)).toMatchObject({ kind: "done", lead: { kind: "update" } });
      expect(await end(0)).toMatchObject({ kind: "done", lead: { kind: "update" } });
    });

    it("a grade that is not applied marks no hint; undo gives the card back without one and leaves the hints as the grade marked them", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, words: 2, patch: { hintsSeen: HINT.update } });
      const svc = new ReviewService(repo, T);
      const first = asCard(await svc.nextScreen(user));
      // The button of a card that was graded already (another number of grades): stale, and nothing is stored.
      expect((await svc.grade(user, first.view.cardId, 5, 3)).kind).toBe("stale");
      expect(await seen(repo, user)).toBe(HINT.update);
      await graded(repo, user, first, 3);
      const undone = asCard(await svc.undo((await repo.getUser(user.id))!));
      expect(undone.lead).toBeNull();
      expect(await seen(repo, user)).toBe(HINT.update | HINT.front | HINT.good | HINT.order);
    });

    it("a hint costs no D1 call: a grade with one makes as many as a grade without", async () => {
      const calls = async (hintsSeen: number, tgId: number) => {
        const { repo, user } = await seedLearner(env.DB, { now: T, tgId, patch: { hintsSeen } });
        const first = asCard(await new ReviewService(repo, T).nextScreen(user));
        const db = countingDb(env.DB);
        const next = await new ReviewService(new Repo(db), T).grade((await repo.getUser(user.id))!, first.view.cardId, 0, 3);
        return { d1: db.calls, hinted: asCard(next).lead != null };
      };
      await seedCatalog(env.DB, WORDS.slice(0, 5).map(([word, translation]) => ({ level: 1, word, translation })));
      const [withHint, without] = [await calls(HINT.update, 1), await calls(127, 2)];
      expect([withHint.hinted, without.hinted]).toEqual([true, false]);
      expect(withHint.d1).toBe(without.d1);
      expect(withHint.d1).toBeLessThanOrEqual(7);
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
