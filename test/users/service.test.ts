import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo, type User } from "../../src/db/repo";
import { HINT } from "../../src/tutorial/hints";
import { advanceOnboarding, getOrCreate, levelSlug, langFromTelegram, nextOccurrence, setSetting, startOnboarding } from "../../src/users/service";
import { seedCatalog, seedLearner } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6, 0);

describe("users", () => {
  it("lang detection", () => {
    expect(langFromTelegram("tt")).toBe("tt");
    expect(langFromTelegram("TT-ru")).toBe("tt");
    expect(langFromTelegram("ru")).toBe("ru");
    expect(langFromTelegram("uk")).toBe("ru");
    expect(langFromTelegram("en-US")).toBe("ru");
    expect(langFromTelegram("tts")).toBe("ru");
    expect(langFromTelegram(undefined)).toBe("ru");
  });
  it("level slug is l01…l20", () => expect([1, 9, 20].map(levelSlug)).toEqual(["l01", "l09", "l20"]));
  it("invalid settings rejected", async () => {
    const repo = new Repo(env.DB);
    const { user } = await getOrCreate(repo, 5, 5, "ru", T);
    await expect(setSetting(repo, user.id, "retention", 0.5)).rejects.toThrow();
    await expect(setSetting(repo, user.id, "newPerDay", 7)).rejects.toThrow();
    await expect(setSetting(repo, user.id, "remindAt", "25:00")).rejects.toThrow();
    await expect(setSetting(repo, user.id, "lang", "en")).rejects.toThrow();
    await expect(setSetting(repo, user.id, "direction", "en_ru")).rejects.toThrow();
    await setSetting(repo, user.id, "retention", 0.95);
    await setSetting(repo, user.id, "direction", "both");
    const u = (await repo.getUser(user.id))!;
    expect(u.retention).toBe(0.95);
    expect(u.direction).toBe("both");
    await setSetting(repo, user.id, "lang", "tt");
    await setSetting(repo, user.id, "direction", "ru_tt");
    expect(await repo.getUser(user.id)).toMatchObject({ lang: "tt", direction: "ru_tt" });
  });
  it("getOrCreate is idempotent", async () => {
    const repo = new Repo(env.DB);
    const a = await getOrCreate(repo, 7, 7, "tt", T);
    const b = await getOrCreate(repo, 7, 7, "tt", T);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.user.id).toBe(a.user.id);
    expect(b.user.lang).toBe("tt");
    expect(b.user).toMatchObject({ level: 1, direction: "tt_ru" });
  });

  describe("onboarding", () => {
    /** A1 has two words and covers 45% of a text, A2 has one word; B1, B2 and C1 have none. */
    async function catalog() {
      await seedCatalog(env.DB, [{ level: 1, word: "бер" }, { level: 1, word: "ике" }, { level: 2, word: "өч" }]);
      await env.DB.prepare("UPDATE decks SET coverage_pct = 45 WHERE level_no = 1").run();
    }
    /** A new user (Telegram id `tgId`) and `step`: one answer, after which the user's row is read again. */
    async function newcomer(repo: Repo, tgId: number) {
      const state = { user: (await getOrCreate(repo, tgId, tgId, "ru", T)).user };
      const step = async (answer: string, now = T) => { const s = await advanceOnboarding(repo, state.user, answer, now); state.user = (await repo.getUser(state.user.id))!; return s; };
      return { state, step };
    }
    /** A user on the step «Уровни», with `patch` over the row. */
    async function atLevels(repo: Repo, tgId: number, patch: Partial<User> = {}) {
      const { user } = await getOrCreate(repo, tgId, tgId, "ru", T);
      await repo.updateUser(user.id, { onboardingStep: "levels", ...patch });
      return (await repo.getUser(user.id))!;
    }
    const line = (no: number, code: string, checked: boolean, total: number, size: number, coveragePct: number | null = null) => ({ no, code, checked, total, size, started: 0, coveragePct });
    const lines = (a1: boolean, a2: boolean) => [line(1, "A1", a1, 2, 500, 45), line(2, "A2", a2, 1, 850), line(3, "B1", false, 0, 850), line(4, "B2", false, 0, 800), line(5, "C1", false, 0, 850)];

    it("the steps: language, two screens, the levels, and the finish with the defaults stored", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const { state, step } = await newcomer(repo, 9);
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "lang" });
      expect(await step("tt")).toEqual({ kind: "intro", n: 1 });
      expect(state.user).toMatchObject({ lang: "tt", onboardingStep: "intro1" });
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "intro", n: 1 });
      expect(await step("n1")).toEqual({ kind: "intro", n: 2 });
      expect(state.user.onboardingStep).toBe("intro2");
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "intro", n: 2 });
      expect(await step("n2")).toEqual({ kind: "levels", lines: lines(true, false) });
      expect(state.user).toMatchObject({ onboardingStep: "levels", levels: 0b1 });
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "levels", lines: lines(true, false) });
      expect(await step("lv:2")).toEqual({ kind: "levels", lines: lines(true, true) });
      expect(state.user).toMatchObject({ onboardingStep: "levels", levels: 0b11 });
      expect(await step("lv:1")).toEqual({ kind: "levels", lines: lines(false, true) });
      expect(state.user.levels).toBe(0b10);
      const at1500 = Date.UTC(2026, 8, 30, 12, 0); // 15:00 in Moscow
      expect(await step("go", at1500)).toEqual({ kind: "finished" });
      expect(state.user).toMatchObject({
        onboardingStep: null, onboardingData: null, hintsSeen: HINT.update, lang: "tt", levels: 0b10, posGroups: 255, newMode: "guided", topicNo: null,
        newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180,
        // The first reminder is the next 09:00 in Moscow, not the moment of the finish; the evening one is today's 20:00.
        nextDailyAt: Date.UTC(2026, 9, 1, 6, 0), nextEveningAt: Date.UTC(2026, 8, 30, 17, 0),
      });
      expect(await repo.userDeckIds(state.user.id)).toEqual([]);
    });

    it("an answer the step does not take is invalid and writes nothing", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const { state, step } = await newcomer(repo, 10);
      const refused = async (answers: string[]) => {
        const before = state.user;
        for (const answer of answers) expect(await step(answer), answer).toEqual({ kind: "invalid", step: before.onboardingStep });
        expect(state.user).toEqual(before);
      };
      // The answers of the introduction that is gone are among them: «Знаю», the words a day, the hour, the time zone.
      const old = ["1", "0", "10", "09:00", "180", "14:35", ""];
      await refused(["en", "n1", "n2", "next", "go", "lv:1", ...old]);
      await step("ru");
      await refused(["ru", "tt", "n2", "next", "go", "lv:1", ...old]);
      await step("n1");
      await refused(["ru", "tt", "n1", "next", "go", "lv:1", ...old]);
      await step("n2");
      await refused(["ru", "tt", "n1", "n2", "next", "lv:", "lv:x", "lv:1.5", "lv:12", "lv:0", "lv:6", ...old]);
    });

    it("«Дальше» of the first screen pressed twice does not pass the second screen: each screen has an answer of its own", async () => {
      const repo = new Repo(env.DB);
      const { state, step } = await newcomer(repo, 17);
      await step("ru");
      const onFirst = state.user;
      expect(await step("n1")).toEqual({ kind: "intro", n: 2 });
      // The second tap is read after the first was stored: the learner stands on the second screen, which does not take it.
      expect(await step("n1")).toEqual({ kind: "invalid", step: "intro2" });
      expect(state.user.onboardingStep).toBe("intro2");
      // Two taps read before either was stored both show the second screen.
      await repo.updateUser(onFirst.id, { onboardingStep: "intro1" });
      expect(await Promise.all([advanceOnboarding(repo, onFirst, "n1", T), advanceOnboarding(repo, onFirst, "n1", T)])).toEqual([{ kind: "intro", n: 2 }, { kind: "intro", n: 2 }]);
      expect((await repo.getUser(onFirst.id))!.onboardingStep).toBe("intro2");
    });

    it("the only checked level is not unchecked, and a level without cards is not checked: invalid, with the reason, and nothing written", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const user = await atLevels(repo, 11);
      expect(await advanceOnboarding(repo, user, "lv:1", T)).toEqual({ kind: "invalid", step: "levels", why: "last" });
      for (const answer of ["lv:3", "lv:4", "lv:5"]) expect(await advanceOnboarding(repo, user, answer, T), answer).toEqual({ kind: "invalid", step: "levels", why: "soon" });
      expect(await repo.getUser(user.id)).toEqual(user);
    });

    it("of two «Начать» at once one finishes; the other is stale", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const user = await atLevels(repo, 12);
      const screens = await Promise.all([advanceOnboarding(repo, user, "go", T), advanceOnboarding(repo, user, "go", T)]);
      expect(screens.map((s) => s.kind).sort()).toEqual(["finished", "stale"]);
      expect(await repo.getUser(user.id)).toMatchObject({ onboardingStep: null, hintsSeen: HINT.update, nextDailyAt: nextOccurrence(180, "09:00", T) });
    });

    it("«Начать» that arrives with the user row read before the finish changes nothing", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const before = await atLevels(repo, 13);
      expect(await advanceOnboarding(repo, before, "go", T)).toEqual({ kind: "finished" });
      // The learner has studied and changed the settings since; the late answer brings neither the hints nor the defaults back.
      await repo.updateUser(before.id, { hintsSeen: 127, newPerDay: 20, remindAt: "19:00", tzOffsetMin: 300, nextDailyAt: 5, nextEveningAt: 6 });
      const studied = await repo.getUser(before.id);
      expect(await advanceOnboarding(repo, before, "go", T + 60_000)).toEqual({ kind: "stale" });
      expect(await repo.getUser(before.id)).toEqual(studied);
    });

    it("the finish stores what the step «Уровни» says, also for a learner who had answered the introduction that is gone", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const user = await atLevels(repo, 14, { newPerDay: 20, remindAt: "19:00", tzOffsetMin: 300, onboardingData: JSON.stringify({ i: 10, known: 4 }), level: 2 });
      expect(await advanceOnboarding(repo, user, "go", T)).toEqual({ kind: "finished" });
      expect(await repo.getUser(user.id)).toMatchObject({
        onboardingStep: null, onboardingData: null, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180, levels: 0b1,
        nextDailyAt: nextOccurrence(180, "09:00", T), nextEveningAt: nextOccurrence(180, "20:00", T),
      });
    });

    it.each(["placement", "goal", "remind", "tz", "zzz"])("a step the introduction does not have (%s) is the language step: the learner is not stuck", async (stored) => {
      const repo = new Repo(env.DB);
      const { user } = await getOrCreate(repo, 15, 15, "ru", T);
      await repo.updateUser(user.id, { onboardingStep: stored });
      const there = (await repo.getUser(user.id))!;
      expect(await startOnboarding(repo, there)).toEqual({ kind: "lang" });
      expect(await advanceOnboarding(repo, there, "1", T)).toEqual({ kind: "invalid", step: stored });
      expect(await advanceOnboarding(repo, there, "ru", T)).toEqual({ kind: "intro", n: 1 });
      expect((await repo.getUser(user.id))!.onboardingStep).toBe("intro1");
    });

    it("a learner who has finished is answered as stale, whatever the answer, and nothing is written", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const { user } = await seedLearner(env.DB, { now: T, tgId: 16 });
      for (const answer of ["ru", "next", "lv:2", "go", "1"]) expect(await advanceOnboarding(repo, user, answer, T), answer).toEqual({ kind: "stale" });
      expect(await repo.getUser(user.id)).toEqual(user);
    });
  });

  it("changing the reminder time reschedules it", async () => {
    const repo = new Repo(env.DB);
    const { user } = await getOrCreate(repo, 12, 12, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: null, tzOffsetMin: 180 });
    await setSetting(repo, user.id, "remindAt", "21:00", T);
    expect((await repo.getUser(user.id))!.nextDailyAt).toBe(Date.UTC(2026, 8, 30, 18, 0));
  });
});
