import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { PLACEMENT, placementLevel } from "../../src/users/placement";
import { advanceOnboarding, getOrCreate, levelSlug, langFromTelegram, nextOccurrence, offsetFromReported, setSetting, startOnboarding } from "../../src/users/service";
import { seedLevels } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6, 0);

describe("users", () => {
  it("offset across midnight", () => {
    expect(offsetFromReported(0, 30, Date.UTC(2026, 8, 29, 21, 30))).toBe(180);
  });
  it("negative offset", () => {
    expect(offsetFromReported(5, 0, Date.UTC(2026, 8, 30, 10, 0))).toBe(-300);
  });
  it("offset rounds to 30 minutes and India works", () => {
    expect(offsetFromReported(11, 32, Date.UTC(2026, 8, 30, 6, 0))).toBe(330);
  });
  it("lang detection", () => {
    expect(langFromTelegram("tt")).toBe("tt");
    expect(langFromTelegram("TT-ru")).toBe("tt");
    expect(langFromTelegram("ru")).toBe("ru");
    expect(langFromTelegram("uk")).toBe("ru");
    expect(langFromTelegram("en-US")).toBe("ru");
    expect(langFromTelegram("tts")).toBe("ru");
    expect(langFromTelegram(undefined)).toBe("ru");
  });
  it.each([[0, 1], [2, 1], [3, 2], [4, 2], [5, 4], [6, 4], [7, 7], [8, 7], [9, 10], [10, 10]])("%i known → level %i", (k, l) => expect(placementLevel(k)).toBe(l));
  it("tests ten words from levels 1,1,2,3,4,6,8,10,13,16", () => expect(PLACEMENT.map((p) => p.level)).toEqual([1, 1, 2, 3, 4, 6, 8, 10, 13, 16]));
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

  it("finishes onboarding on the time-zone step and opens only the start level", async () => {
    const repo = new Repo(env.DB);
    const deckIds = await seedLevels(env.DB, { 1: ["бер"], 4: ["дүрт"] });
    let { user } = await getOrCreate(repo, 9, 9, "ru", T);
    expect(startOnboarding(user)).toEqual({ kind: "lang" });
    const step = async (answer: string) => { const s = await advanceOnboarding(repo, user, answer, T); user = (await repo.getUser(user.id))!; return s; };
    expect(await step("tt")).toMatchObject({ kind: "placement", index: 0, word: PLACEMENT[0]!.word });
    expect(user.lang).toBe("tt");
    for (let i = 0; i < 10; i++) await step(i < 5 ? "1" : "0");
    expect(user.level).toBe(4);
    expect(user.onboardingStep).toBe("goal");
    expect(startOnboarding(user)).toEqual({ kind: "goal", level: 4, known: 5 });
    expect(await step("10")).toEqual({ kind: "remind" });
    expect((await step("09:00")).kind).toBe("tz");
    expect(await step("hello")).toMatchObject({ kind: "invalid" });
    expect(await step("180")).toEqual({ kind: "finished", remindAt: "09:00", tzOffsetMin: 180, level: 4 });
    expect(await repo.userDeckIds(user.id)).toEqual([deckIds[4]]);
    expect(user).toMatchObject({ onboardingStep: null, onboardingData: null, level: 4, newPerDay: 10 });
  });

  /** A user on the time-zone step who was placed at `level`. */
  async function placedAt(repo: Repo, tgId: number, level: number) {
    const { user } = await getOrCreate(repo, tgId, tgId, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: "tz", level });
    return (await repo.getUser(user.id))!;
  }

  describe("start level on an incomplete catalog (ruling T16b)", () => {
    it("starts at the highest existing level not above the placed one", async () => {
      const repo = new Repo(env.DB);
      const deckIds = await seedLevels(env.DB, { 1: ["бер"], 2: ["ике"], 9: ["тугыз"] });
      const user = await placedAt(repo, 13, 7);
      expect(await advanceOnboarding(repo, user, "180", T)).toEqual({ kind: "finished", remindAt: "09:00", tzOffsetMin: 180, level: 2 });
      expect(await repo.userDeckIds(user.id)).toEqual([deckIds[2]]);
      expect(await repo.getUser(user.id)).toMatchObject({ onboardingStep: null, level: 2 });
    });

    it("with only level 1 published everybody starts at level 1", async () => {
      const repo = new Repo(env.DB);
      const deckIds = await seedLevels(env.DB, { 1: ["бер"] });
      for (const [tgId, placed] of [[21, 1], [22, 2], [23, 4], [24, 7], [25, 10]] as const) {
        const user = await placedAt(repo, tgId, placed);
        expect(await advanceOnboarding(repo, user, "180", T)).toMatchObject({ kind: "finished", level: 1 });
        expect(await repo.userDeckIds(user.id)).toEqual([deckIds[1]]);
        expect((await repo.getUser(user.id))!.level).toBe(1);
      }
    });

    it("starts at the lowest existing level when there is none at or below the placed one", async () => {
      const repo = new Repo(env.DB);
      const deckIds = await seedLevels(env.DB, { 5: ["биш"], 8: ["сигез"] });
      const user = await placedAt(repo, 14, 2);
      expect(await advanceOnboarding(repo, user, "180", T)).toMatchObject({ kind: "finished", level: 5 });
      expect(await repo.userDeckIds(user.id)).toEqual([deckIds[5]]);
      expect((await repo.getUser(user.id))!.level).toBe(5);
    });

    it("keeps the placed level without a subscription when the catalog is empty", async () => {
      const repo = new Repo(env.DB);
      const user = await placedAt(repo, 15, 4);
      expect(await advanceOnboarding(repo, user, "180", T)).toMatchObject({ kind: "finished", level: 4 });
      expect(await repo.userDeckIds(user.id)).toEqual([]);
      expect(await repo.getUser(user.id)).toMatchObject({ onboardingStep: null, level: 4 });
    });

    it("own decks and AI decks are not levels to start from", async () => {
      const repo = new Repo(env.DB);
      const other = await getOrCreate(repo, 16, 16, "ru", T);
      await repo.customDeck(other.user.id, T);
      expect(await repo.startLevel(4)).toBeNull();
      const deckIds = await seedLevels(env.DB, { 3: ["өч"] });
      expect(await repo.startLevel(4)).toEqual({ deckId: deckIds[3], levelNo: 3 });
      expect(await repo.startLevel(3)).toEqual({ deckId: deckIds[3], levelNo: 3 });
      expect(await repo.startLevel(1)).toEqual({ deckId: deckIds[3], levelNo: 3 });
    });

    it("the placement test already names the level that will be opened", async () => {
      const repo = new Repo(env.DB);
      await seedLevels(env.DB, { 1: ["бер"], 2: ["ике"] });
      let { user } = await getOrCreate(repo, 17, 17, "ru", T);
      const step = async (answer: string) => { const s = await advanceOnboarding(repo, user, answer, T); user = (await repo.getUser(user.id))!; return s; };
      await step("ru");
      let last = await step("1");
      for (let i = 1; i < 10; i++) last = await step("1");
      // Ten known words place at level 10; the catalog ends at level 2.
      expect(last).toEqual({ kind: "goal", level: 2, known: 10 });
      expect(user).toMatchObject({ level: 2, onboardingStep: "goal" });
      expect(startOnboarding(user)).toEqual({ kind: "goal", level: 2, known: 10 });
    });
  });

  it("first reminder is scheduled for the next occurrence, not right after onboarding", async () => {
    const repo = new Repo(env.DB);
    await seedLevels(env.DB, { 1: ["китап"] });
    let { user } = await getOrCreate(repo, 11, 11, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: "tz", level: 1, remindAt: "09:00" });
    user = (await repo.getUser(user.id))!;
    const at1500 = Date.UTC(2026, 8, 30, 12, 0); // 15:00 local
    await advanceOnboarding(repo, user, "180", at1500);
    const u = (await repo.getUser(user.id))!;
    expect(u.nextDailyAt).toBe(Date.UTC(2026, 9, 1, 6, 0)); // tomorrow 09:00 local
    expect(u.nextEveningAt).toBe(Date.UTC(2026, 8, 30, 17, 0)); // today 20:00 local
    expect(nextOccurrence(180, "09:00", Date.UTC(2026, 8, 30, 5, 0))).toBe(Date.UTC(2026, 8, 30, 6, 0));
  });

  it("changing the reminder time reschedules it", async () => {
    const repo = new Repo(env.DB);
    const { user } = await getOrCreate(repo, 12, 12, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: null, tzOffsetMin: 180 });
    await setSetting(repo, user.id, "remindAt", "21:00", T);
    expect((await repo.getUser(user.id))!.nextDailyAt).toBe(Date.UTC(2026, 8, 30, 18, 0));
  });

  it("typed local time answers the timezone step", async () => {
    const repo = new Repo(env.DB);
    let { user } = await getOrCreate(repo, 10, 10, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: "tz", level: 3 });
    user = (await repo.getUser(user.id))!;
    const s = await advanceOnboarding(repo, user, "14:00", T);
    expect(s).toMatchObject({ kind: "finished", tzOffsetMin: 480, level: 3 });
    expect((await repo.getUser(user.id))!.tzOffsetMin).toBe(480);
  });
});
