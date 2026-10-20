import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo, type User } from "../../src/db/repo";
import { HINT } from "../../src/tutorial/hints";
import { advanceOnboarding, getOrCreate, langFromTelegram, nextOccurrence, onLanguageStep, onPracticeStep, onZoneStep, setSetting, startOnboarding } from "../../src/users/service";
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
  it("invalid settings rejected", async () => {
    const repo = new Repo(env.DB);
    const { user } = await getOrCreate(repo, 5, 5, "ru", T);
    await expect(setSetting(repo, user.id, "newPerDay", 7)).rejects.toThrow();
    await expect(setSetting(repo, user.id, "remindAt", "25:00")).rejects.toThrow();
    await expect(setSetting(repo, user.id, "lang", "en")).rejects.toThrow();
    await expect(setSetting(repo, user.id, "direction", "en_ru")).rejects.toThrow();
    // The retention of the old scheduler is no setting any more: no value of it is taken, and the column keeps what it held.
    for (const value of [0.85, 0.9, 0.95]) await expect(setSetting(repo, user.id, "retention" as never, value)).rejects.toThrow("invalid retention");
    await setSetting(repo, user.id, "direction", "both");
    const u = (await repo.getUser(user.id))!;
    expect(u.retention).toBe(0.9);
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
    expect(b.user).toMatchObject({ levels: 1, direction: "tt_ru" });
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
    /** A user on the step «Уровни» (or on `onboardingStep` of the patch), with `patch` over the row. */
    async function atLevels(repo: Repo, tgId: number, patch: Partial<User> = {}) {
      const { user } = await getOrCreate(repo, tgId, tgId, "ru", T);
      await repo.updateUser(user.id, { onboardingStep: "levels", ...patch });
      return (await repo.getUser(user.id))!;
    }
    /** The buttons of the time-zone step at T (06:00 UTC): the time it is now in each zone. */
    const zones = [{ offset: 120, label: "08:00" }, { offset: 180, label: "09:00" }, { offset: 240, label: "10:00" }, { offset: 300, label: "11:00" }, { offset: 420, label: "13:00" }, { offset: 600, label: "16:00" }];
    const line = (no: number, code: string, checked: boolean, total: number, size: number, coveragePct: number | null = null) => ({ no, code, checked, total, size, started: 0, coveragePct });
    const lines = (a1: boolean, a2: boolean) => [line(1, "A1", a1, 2, 500, 45), line(2, "A2", a2, 1, 850), line(3, "B1", false, 0, 850), line(4, "B2", false, 0, 800), line(5, "C1", false, 0, 850)];

    it("the steps: language, the screen about the bot, the practice card, the levels, the reminder hour, the time zone, and the finish", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const { state, step } = await newcomer(repo, 9);
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "lang" });
      expect(await step("tt")).toEqual({ kind: "intro" });
      expect(state.user).toMatchObject({ lang: "tt", onboardingStep: "intro1" });
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "intro" });
      expect(await step("n1")).toEqual({ kind: "practice" });
      expect(state.user.onboardingStep).toBe("practice");
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "practice" });
      // The step asks nothing of the learner's row: the practice card stores nothing, and its buttons are no answers of the introduction.
      const practising = state.user;
      for (const pressed of ["pr:0:3", "pr:start", "0:3", "3"]) expect(await step(pressed), pressed).toEqual({ kind: "invalid", step: "practice" });
      expect(state.user).toEqual(practising);
      expect(await step("n2")).toEqual({ kind: "levels", lines: lines(true, false) });
      expect(state.user).toMatchObject({ onboardingStep: "levels", levels: 0b1 });
      expect(await startOnboarding(repo, state.user)).toEqual({ kind: "levels", lines: lines(true, false) });
      expect(await step("lv:2")).toEqual({ kind: "levels", lines: lines(true, true) });
      expect(state.user).toMatchObject({ onboardingStep: "levels", levels: 0b11 });
      expect(await step("lv:1")).toEqual({ kind: "levels", lines: lines(false, true) });
      expect(state.user.levels).toBe(0b10);
      expect(await step("go")).toEqual({ kind: "reminder" });
      expect(state.user).toMatchObject({ onboardingStep: "reminder", levels: 0b10 });
      expect(await startOnboarding(repo, state.user, T)).toEqual({ kind: "reminder" });
      expect(await step("08:00")).toEqual({ kind: "zone", options: zones });
      expect(state.user).toMatchObject({ onboardingStep: "zone", remindAt: "08:00" });
      expect([onZoneStep(state.user), onPracticeStep(state.user), onLanguageStep(state.user)]).toEqual([true, false, false]);
      expect(await startOnboarding(repo, state.user, T)).toEqual({ kind: "zone", options: zones });
      const at1500 = Date.UTC(2026, 8, 30, 12, 0); // 15:00 in Moscow, 17:00 in Ufa
      expect(await step("tz:300", at1500)).toEqual({ kind: "finished", remindAt: "08:00", tzOffsetMin: 300 });
      expect(state.user).toMatchObject({
        onboardingStep: null, onboardingData: null, hintsSeen: HINT.update, lang: "tt", levels: 0b10, posGroups: 255, newMode: "guided", topicNo: null,
        newPerDay: 10, remindAt: "08:00", tzOffsetMin: 300,
        // The first reminder is the next 08:00 in Ufa, not the moment of the finish; the evening one is today's 20:00.
        nextDailyAt: Date.UTC(2026, 9, 1, 3, 0), nextEveningAt: Date.UTC(2026, 8, 30, 15, 0),
      });
      // The levels are the checked ones of the row: no deck is subscribed to.
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_decks").first()).toEqual({ n: 0 });
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
      await step("go");
      await refused(["ru", "n2", "go", "lv:1", "1", "10", "180", "tz:180", "at:09:00", "9:00", "24:00", "09:60", "14:35", ""]);
      await step("21:00");
      // A zone the settings do not have is no answer: neither a button that is not offered nor a typed time that gives it.
      // A button carries `tz:` and a typed time `at:`, so an hour or a zone of an old message is no answer either.
      await refused(["ru", "go", "lv:1", "21:00", "09:00", "180", "tz:0", "tz:60", "tz:330", "tz:-180", "tz:180.5", "tz:", ""]);
      // A typed answer that is refused says why: no time could be read, or the time gives a zone the bot does not have.
      const zoneRow = state.user;
      for (const typed of ["at:14:35:00", "at:25:00", "at:09:60", "at:1435", "at:", "at:в 14:35", "at:tz:180", "at:UTC-5"]) expect(await step(typed), typed).toEqual({ kind: "invalid", step: "zone", why: "time" });
      for (const typed of ["at:14:35", "at:07:00", "at:23:00"]) expect(await step(typed), typed).toEqual({ kind: "invalid", step: "zone", why: "zone" });
      expect(state.user).toEqual(zoneRow);
      expect(await step("at:10:00", T)).toMatchObject({ kind: "finished", tzOffsetMin: 240 });
    });

    it("the time zone may be typed as the time it is now: rounded to the half hour, taken when the settings have that zone", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      // At T it is 06:00 UTC.
      for (const [i, [typed, offset]] of ([["9:00", 180], ["08.58", 180], ["11:14", 300], ["18:00", 720]] as const).entries()) {
        const user = await atLevels(repo, 30 + i, { onboardingStep: "zone" });
        expect(await advanceOnboarding(repo, user, `at:${typed}`, T), typed).toMatchObject({ kind: "finished", tzOffsetMin: offset });
      }
      // UTC+1 and UTC+5:30 are not among the zones of the settings.
      const user = await atLevels(repo, 40, { onboardingStep: "zone" });
      for (const typed of ["07:00", "11:30"]) expect(await advanceOnboarding(repo, user, `at:${typed}`, T), typed).toEqual({ kind: "invalid", step: "zone", why: "zone" });
      expect(await repo.getUser(user.id)).toEqual(user);
    });

    it("«Попробовать» pressed twice does not pass the practice card: the screen and the card have an answer each", async () => {
      const repo = new Repo(env.DB);
      const { state, step } = await newcomer(repo, 17);
      await step("ru");
      const onFirst = state.user;
      expect(await step("n1")).toEqual({ kind: "practice" });
      // The second tap is read after the first was stored: the learner stands on the practice card, which does not take it.
      expect(await step("n1")).toEqual({ kind: "invalid", step: "practice" });
      expect(state.user.onboardingStep).toBe("practice");
      // Two taps read before either was stored both show the practice card.
      await repo.updateUser(onFirst.id, { onboardingStep: "intro1" });
      expect(await Promise.all([advanceOnboarding(repo, onFirst, "n1", T), advanceOnboarding(repo, onFirst, "n1", T)])).toEqual([{ kind: "practice" }, { kind: "practice" }]);
      expect((await repo.getUser(onFirst.id))!.onboardingStep).toBe("practice");
    });

    it("a learner stored on `intro2`, the second screen the introduction had, stands on the practice card: its screen, its answer, and not the language step", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const { state, step } = await newcomer(repo, 18);
      await step("tt");
      await repo.updateUser(state.user.id, { onboardingStep: "intro2" });
      state.user = (await repo.getUser(state.user.id))!;
      const stored = state.user;
      expect([onLanguageStep(stored), onPracticeStep(stored)]).toEqual([false, true]);
      expect(await startOnboarding(repo, stored)).toEqual({ kind: "practice" });
      // Only the answer of the practice card is taken; the others keep the row as it is, the stored name of the step with it.
      for (const answer of ["ru", "tt", "n1", "go", "lv:1", "next"]) expect(await step(answer), answer).toEqual({ kind: "invalid", step: "intro2" });
      expect(state.user).toEqual(stored);
      expect(await step("n2")).toEqual({ kind: "levels", lines: lines(true, false) });
      expect(state.user).toMatchObject({ lang: "tt", onboardingStep: "levels" });
    });

    it("says who stands on the practice card: a learner on that step, and nobody else", async () => {
      expect((["practice", "intro2"] as const).map((onboardingStep) => onPracticeStep({ onboardingStep }))).toEqual([true, true]);
      for (const onboardingStep of [null, "lang", "intro1", "levels", "placement", "zzz", ""]) expect(onPracticeStep({ onboardingStep }), String(onboardingStep)).toBe(false);
    });

    it("the only checked level is not unchecked, and a level without cards is not checked: invalid, with the reason, and nothing written", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const user = await atLevels(repo, 11);
      expect(await advanceOnboarding(repo, user, "lv:1", T)).toEqual({ kind: "invalid", step: "levels", why: "last" });
      for (const answer of ["lv:3", "lv:4", "lv:5"]) expect(await advanceOnboarding(repo, user, answer, T), answer).toEqual({ kind: "invalid", step: "levels", why: "soon" });
      expect(await repo.getUser(user.id)).toEqual(user);
    });

    it("of two «Начать» at once one goes on to the reminder hour, the other is stale; so are two hours and two time zones", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const user = await atLevels(repo, 12);
      const kinds = async (u: User, a: string, b: string) => (await Promise.all([advanceOnboarding(repo, u, a, T), advanceOnboarding(repo, u, b, T)])).map((s) => s.kind).sort();
      expect(await kinds(user, "go", "go")).toEqual(["reminder", "stale"]);
      expect(await kinds((await repo.getUser(user.id))!, "08:00", "08:00")).toEqual(["stale", "zone"]);
      expect(await kinds((await repo.getUser(user.id))!, "tz:180", "at:09:00")).toEqual(["finished", "stale"]);
      expect(await repo.getUser(user.id)).toMatchObject({ onboardingStep: null, hintsSeen: HINT.update, nextDailyAt: nextOccurrence(180, "08:00", T) });
    });

    it("an answer that arrives with the user row read before the finish changes nothing: «Начать», an hour or a time zone", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const onLevels = await atLevels(repo, 13);
      await advanceOnboarding(repo, onLevels, "go", T);
      const onReminder = (await repo.getUser(onLevels.id))!;
      await advanceOnboarding(repo, onReminder, "12:00", T);
      const onZone = (await repo.getUser(onLevels.id))!;
      expect(await advanceOnboarding(repo, onZone, "tz:180", T)).toMatchObject({ kind: "finished" });
      // The learner has studied and changed the settings since; the late answers bring neither the hints, the step nor the defaults back.
      await repo.updateUser(onLevels.id, { hintsSeen: 127, newPerDay: 20, remindAt: "19:00", tzOffsetMin: 300, nextDailyAt: 5, nextEveningAt: 6 });
      const studied = await repo.getUser(onLevels.id);
      for (const [row, answer] of [[onLevels, "go"], [onReminder, "08:00"], [onZone, "tz:240"]] as const) expect(await advanceOnboarding(repo, row, answer, T + 60_000), answer).toEqual({ kind: "stale" });
      expect(await repo.getUser(onLevels.id)).toEqual(studied);
    });

    it("the finish stores the hour and the zone chosen and the new words a day the step «Уровни» names, also for a learner who had answered the introduction that is gone", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const user = await atLevels(repo, 14, { newPerDay: 20, remindAt: "19:00", tzOffsetMin: 300, onboardingData: JSON.stringify({ i: 10, known: 4 }) });
      expect(await advanceOnboarding(repo, user, "go", T)).toEqual({ kind: "reminder" });
      expect(await advanceOnboarding(repo, (await repo.getUser(user.id))!, "09:00", T)).toMatchObject({ kind: "zone" });
      expect(await advanceOnboarding(repo, (await repo.getUser(user.id))!, "tz:180", T)).toEqual({ kind: "finished", remindAt: "09:00", tzOffsetMin: 180 });
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
      expect(await advanceOnboarding(repo, there, "ru", T)).toEqual({ kind: "intro" });
      expect((await repo.getUser(user.id))!.onboardingStep).toBe("intro1");
    });

    it("a learner who has finished is answered as stale, whatever the answer, and nothing is written", async () => {
      const repo = new Repo(env.DB);
      await catalog();
      const { user } = await seedLearner(env.DB, { now: T, tgId: 16 });
      for (const answer of ["ru", "next", "lv:2", "go", "1", "09:00", "tz:180", "at:09:00"]) expect(await advanceOnboarding(repo, user, answer, T), answer).toEqual({ kind: "stale" });
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
