import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type SeedLevel, type SeedTopic, catalogToSql } from "../../src/content/csv";
import { Repo, type User } from "../../src/db/repo";
import { LEVELS, levelBit } from "../../src/levels/scale";
import { ReviewService } from "../../src/review/service";
import { formatInterval } from "../../src/srs/interval";
import { type Mem, newMem } from "../../src/srs/ladder";
import { bulkCards } from "../helpers/catalog";
import { HINT } from "../../src/tutorial/hints";
import { countingDb } from "../helpers/countingDb";
import { asCard, gradeShown, logStmt } from "../helpers/review";
import { WORDS, note, seedCatalog, seedLearner, seedUser } from "../helpers/seed";
import { applySeed } from "../helpers/seedSql";
import { study } from "../helpers/sim";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 local (+03:00)

describe("review service", () => {
  it("first card shows reference intervals", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    expect(s.intervals).toEqual({ 1: "1 минута", 2: "5 минут", 3: "10 минут", 4: "1 день" });
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
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 3 * DAY, scheduledDays: 3, reps: 2 });
    const s = await new ReviewService(repo, T).grade(user, id, 2, 3);
    expect(s.kind === "done" || s.kind === "card").toBe(true);
    const fb = s.kind === "done" || s.kind === "card" ? s.feedback : null;
    // From the 3-day rung «Хорошо» goes one rung up, to 7 days.
    expect(fb).toEqual({ word: "китап", kind: "grow", beforeDays: 3, afterMs: 7 * DAY });
  });

  it("lapse feedback shows the days the word stood on and the minute it comes back in", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 30 * DAY, scheduledDays: 30, reps: 5 });
    const s = await new ReviewService(repo, T).grade(user, id, 5, 1);
    const fb = s.kind === "done" || s.kind === "card" ? s.feedback : null;
    // «Снова» sends the word to the first rung whatever rung it stood on: nothing of its 30 days is kept.
    expect(fb).toEqual({ word: "китап", kind: "lapse", beforeDays: 30, afterMs: MIN });
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
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 14 * DAY, scheduledDays: 14, reps: 4 });
    await repo.updateUser(user.id, { newPerDay: 0 });
    // «Хорошо» on the 14-day rung is 30 days: the word is learned (21 days and more) from this grade on.
    const s = await new ReviewService(repo, T).grade((await repo.getUser(user.id))!, id, 4, 3);
    if (s.kind !== "done") throw new Error(s.kind);
    expect(s.summary).toEqual({ reviewsToday: 1, learnedToday: 1, postponedToday: 0, nextLearningInMs: null, streak: 1 });
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
    /** What a row held while each grade button had a hint of its own: the first card and those five bits; the update notice is not among them. */
    const OLD_HINTS = 63;

    it("a learner fresh from the introduction: the hint of the first card until a grade, and no hint after one, whichever button it was", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, patch: { hintsSeen: HINT.update } });
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      expect(first.lead).toEqual({ kind: "front" });
      // Showing a card stores nothing about the hints: the grade does.
      expect(await seen(repo, user)).toBe(HINT.update);
      const second = asCard(await graded(repo, user, first, 3));
      expect(first.intervals).toMatchObject({ 3: "10 минут" });
      // What a button does is shown by the practice card, not said after a grade.
      expect(second.lead).toBeNull();
      expect(await seen(repo, user)).toBe(HINT.update | HINT.front);
      const third = asCard(await graded(repo, user, second, 3));
      expect(third.lead).toBeNull();
      const fourth = asCard(await graded(repo, user, third, 1));
      expect(third.intervals).toMatchObject({ 1: "1 минута" });
      expect(fourth.lead).toBeNull();
      expect(asCard(await graded(repo, user, fourth, 2)).lead).toBeNull();
      expect(await seen(repo, user)).toBe(HINT.update | HINT.front);
      // A screen that follows no grade carries nothing once a card was graded.
      expect(asCard(await new ReviewService(repo, T).nextScreen((await repo.getUser(user.id))!)).lead).toBeNull();
    });

    it("the interval on a button is the one the grade gives, and the card is due exactly then: the ladder moves no interval", async () => {
      // «Легко» on a new card is one day at whatever moment it is pressed.
      await seedCatalog(env.DB, WORDS.slice(0, 2).map(([word, translation]) => ({ level: 1, word, translation })));
      for (const [tgId, lang, at] of [[1, "tt", T], [2, "ru", T + 7 * MIN], [3, "ru", T + 3 * 60 * MIN], [4, "tt", T + DAY + 11 * MIN]] as const) {
        const { repo, user } = await seedLearner(env.DB, { now: T, tgId, patch: { hintsSeen: HINT.update, lang } });
        const first = asCard(await new ReviewService(repo, at).nextScreen(user));
        const second = asCard(await graded(repo, user, first, 4, at));
        expect(second.lead).toBeNull();
        expect(first.intervals[4]).toBe(lang === "tt" ? "1 көн" : "1 день");
        const card = (await repo.getCard(user.id, first.view.cardId))!;
        expect(card.mem.due - at).toBe(DAY);
        expect(formatInterval(card.mem.due - at, lang)).toBe(first.intervals[4]);
      }
    });

    it("a learner who knew the bot before the levels: the update notice until a grade, no hint after it; the bits of the hints that are gone stay in the row", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, patch: { hintsSeen: OLD_HINTS } });
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      expect(first.lead).toEqual({ kind: "update" });
      expect(asCard(await graded(repo, user, first, 3)).lead).toBeNull();
      expect(await seen(repo, user)).toBe(127);
    });

    it("the screen that ends a session carries no hint after a grade; without a grade the update notice, never the hint of the first card", async () => {
      const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { hintsSeen: HINT.update } });
      const first = asCard(await new ReviewService(repo, T).nextScreen(user));
      const done = await graded(repo, user, first, 4);
      expect(done).toMatchObject({ kind: "done", lead: null });
      const end = async (hintsSeen: number) => new ReviewService(repo, T).nextScreen({ ...(await repo.getUser(user.id))!, hintsSeen });
      expect(await end(127)).toMatchObject({ kind: "done", lead: null });
      expect(await end(HINT.update)).toMatchObject({ kind: "done", lead: null });
      expect(await end(OLD_HINTS)).toMatchObject({ kind: "done", lead: { kind: "update" } });
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
      expect(await seen(repo, user)).toBe(HINT.update | HINT.front);
    });

    it("marking the hints costs no D1 call: the grade of the first card, which carried the hint, makes as many as a grade of a learner who has seen it", async () => {
      const calls = async (hintsSeen: number, tgId: number) => {
        const { repo, user } = await seedLearner(env.DB, { now: T, tgId, patch: { hintsSeen } });
        const first = asCard(await new ReviewService(repo, T).nextScreen(user));
        const db = countingDb(env.DB);
        await new ReviewService(new Repo(db), T).grade((await repo.getUser(user.id))!, first.view.cardId, 0, 3);
        return { d1: db.calls, hinted: first.lead != null, seen: await seen(repo, user) };
      };
      await seedCatalog(env.DB, WORDS.slice(0, 5).map(([word, translation]) => ({ level: 1, word, translation })));
      const [withHint, without] = [await calls(HINT.update, 1), await calls(127, 2)];
      expect([withHint.hinted, without.hinted]).toEqual([true, false]);
      expect([withHint.seen, without.seen]).toEqual([HINT.update | HINT.front, 127]);
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

  describe("hard words (spec A)", () => {
    const AGAIN_STEP = MIN + 1000;
    /** A word on its first learning step, due at `due`, answered three times in the minutes before `at`. */
    async function answeredThrice(at: number, due: number) {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: at, words: 1 });
      await bulkCards(env.DB, user.id, [[noteIds[0]!, "tt_ru", { ...newMem(at), state: "learning", step: 0, reps: 3, due, lastReview: at - 2 * MIN }, null]]);
      const id = (await env.DB.prepare("SELECT id FROM cards WHERE user_id = ?").bind(user.id).first<{ id: number }>())!.id;
      await env.DB.batch([4, 3, 2].map((m) => logStmt(env.DB, {
        cardId: id, userId: user.id, rating: 1, stateBefore: { ...newMem(at), state: "learning", step: 0 }, intervalBeforeDays: 0, intervalAfterMs: MIN, reviewedAt: at - m * MIN, wasNew: false,
      })));
      return { repo, user, id };
    }
    /** 04:00 local (+03:00) on 2026-09-30: the learner's day begins. */
    const DAY_START = Date.UTC(2026, 8, 30, 1, 0);

    it("the day boundary: a card shown at 03:59 with «1 день» and graded at 04:00 goes to tomorrow as its button said", async () => {
      const shownAt = DAY_START - MIN;
      const { repo, user, id } = await answeredThrice(shownAt, shownAt - 1000);
      const s = asCard(await new ReviewService(repo, shownAt).nextScreen(user));
      expect(s.view.tomorrow).toBe(true);
      expect(s.intervals).toEqual({ 1: "1 день", 2: "1 день", 3: "10 минут", 4: "1 день" });
      // At 04:00 the count of today's answers is 0, but the button said «1 день».
      await gradeShown(repo, user, s, 2, DAY_START);
      expect((await repo.getCard(user.id, id))!.mem.due).toBe(DAY_START + DAY);
    });

    it("a button that did not say «1 день» gives no postponement, though the count reached three since", async () => {
      const { repo, user, id } = await answeredThrice(T, T - 1000);
      // An old button, or one shown before the third answer: no flag.
      await new ReviewService(repo, T).grade(user, id, 3, 2, false);
      expect((await repo.getCard(user.id, id))!.mem.due).toBe(T + 5 * MIN);
    });

    it("the owner's case: ten hard words graded «Трудно» until the session ends", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 10, patch: { newPerDay: 5 } });
      await seedCatalog(env.DB, ["бер", "ике", "өч", "дүрт", "биш", "алты"].map((word) => ({ level: 1, word })));
      const hard = (i: number): Mem => ({ ...newMem(T), state: "learning", step: 0, reps: 1, due: T - (20 - i) * MIN, lastReview: T - (25 - i) * MIN });
      await bulkCards(env.DB, user.id, noteIds.map((id, i) => [id, "tt_ru", hard(i), null]));
      const labels: string[] = [];
      const shown = await study(repo, user.id, T, { rate: () => 2, onCard: async (c) => { labels.push(c.intervals[2]); } });
      // Every label shown is the interval the grade stored.
      const log = (await env.DB.prepare("SELECT interval_after_ms AS ms, was_new FROM review_log WHERE user_id = ? ORDER BY id").bind(user.id).all<{ ms: number; was_new: number }>()).results;
      expect(log.map((l) => formatInterval(l.ms, "ru"))).toEqual(labels);
      // New words never go over the day's limit, and the limit is used.
      expect(log.filter((l) => l.was_new === 1)).toHaveLength(5);
      // The session ends: every word shown waits for tomorrow, and the done screen says so.
      const words = new Set(shown.map((x) => x.noteId));
      expect(words.size).toBe(15);
      const end = shown[shown.length - 1]!.at + 10_000;
      const done = await new ReviewService(repo, end).nextScreen((await repo.getUser(user.id))!);
      if (done.kind !== "done") throw new Error(`expected done, got ${done.kind}`);
      expect(done.summary.postponedToday).toBe(15);
      expect(done.summary.nextLearningInMs).toBeNull();
      expect(labels.filter((l) => l === "1 день")).toHaveLength(15);
    });

    /** One word answered «Снова» three times, each time once it is due; the screen after the third answer and its time. */
    async function threeTimes() {
      const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
      let s = asCard(await new ReviewService(repo, T).nextScreen(user));
      let at = T;
      for (let i = 0; i < 3; i++) {
        s = asCard(await gradeShown(repo, user, s, 1, at));
        at += AGAIN_STEP;
      }
      return { repo, user, s, at };
    }

    it("the fourth answer of a word today: «Снова» and «Трудно» say and give 1 day", async () => {
      const { repo, user, s, at } = await threeTimes();
      expect(s.intervals).toEqual({ 1: "1 день", 2: "1 день", 3: "10 минут", 4: "1 день" });
      const done = await gradeShown(repo, user, s, 2, at);
      if (done.kind !== "done") throw new Error(`expected done, got ${done.kind}`);
      expect(done.summary.postponedToday).toBe(1);
      expect(done.summary.nextLearningInMs).toBeNull();
      const card = (await repo.getCard(user.id, s.view.cardId))!;
      expect(card.mem).toMatchObject({ due: at + DAY, state: "learning", step: 0 });
    });

    it("«Хорошо» on the fourth answer goes on as before", async () => {
      const { repo, user, s, at } = await threeTimes();
      await gradeShown(repo, user, s, 3, at);
      const card = (await repo.getCard(user.id, s.view.cardId))!;
      expect(card.mem).toMatchObject({ due: at + 10 * MIN, state: "learning", step: 1 });
    });

    it("an undone answer does not count", async () => {
      const { repo, user, at } = await threeTimes();
      const back = asCard(await new ReviewService(repo, at).undo((await repo.getUser(user.id))!));
      expect(back.intervals).toEqual({ 1: "1 минута", 2: "5 минут", 3: "10 минут", 4: "1 день" });
      // Graded again after the undo, «Трудно» is a fourth answer only by the log rows that count: 5 minutes.
      await gradeShown(repo, user, back, 2, at);
      expect((await repo.getCard(user.id, back.view.cardId))!.mem.due).toBe(at + 5 * MIN);
    });

    it("ten hard words: a new word comes after every two learning cards, and no word twice in a row", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 10, patch: { newPerDay: 5 } });
      await seedCatalog(env.DB, ["бер", "ике", "өч", "дүрт", "биш", "алты"].map((word) => ({ level: 1, word })));
      const hard = (i: number): Mem => ({ ...newMem(T), state: "learning", step: 0, reps: 1, due: T - (20 - i) * MIN, lastReview: T - (25 - i) * MIN });
      await bulkCards(env.DB, user.id, noteIds.map((id, i) => [id, "tt_ru", hard(i), null]));
      let s = asCard(await new ReviewService(repo, T).nextScreen((await repo.getUser(user.id))!));
      const seen: { noteId: number; kind: string }[] = [];
      for (let i = 0; i < 12; i++) {
        seen.push({ noteId: s.view.noteId, kind: s.view.reps === 0 ? "new" : "learning" });
        s = asCard(await gradeShown(repo, user, s, 2, T + (i + 1) * 1000));
      }
      for (let i = 1; i < seen.length; i++) expect(seen[i]!.noteId).not.toBe(seen[i - 1]!.noteId);
      expect(seen.map((x) => x.kind)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 3 === 2 ? "new" : "learning")));
    });

    it("the next day the postponed word is an ordinary learning card", async () => {
      const { repo, user, s, at } = await threeTimes();
      await gradeShown(repo, user, s, 2, at);
      const next = asCard(await new ReviewService(repo, at + DAY).nextScreen((await repo.getUser(user.id))!));
      expect(next.view.cardId).toBe(s.view.cardId);
      expect(next.counts.l).toBe(1);
      expect(next.intervals).toEqual({ 1: "1 минута", 2: "5 минут", 3: "10 минут", 4: "1 день" });
    });

    it("direction «both»: the word just answered does not come back by its other card while another can be shown", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 2, patch: { direction: "both", newPerDay: 0 } });
      const due = (d: number): Mem => ({ ...newMem(T), state: "learning", step: 0, reps: 1, due: T - d * MIN, lastReview: T - 10 * MIN });
      await bulkCards(env.DB, user.id, [[noteIds[0]!, "tt_ru", due(3), null], [noteIds[0]!, "ru_tt", due(2), null], [noteIds[1]!, "tt_ru", due(1), null]]);
      const first = asCard(await new ReviewService(repo, T).nextScreen((await repo.getUser(user.id))!));
      expect(first.view.noteId).toBe(noteIds[0]);
      const second = asCard(await gradeShown(repo, user, first, 2, T));
      expect(second.view.noteId).toBe(noteIds[1]);
    });
  });
});
