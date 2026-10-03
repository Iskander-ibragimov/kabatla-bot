import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { PLACEMENT_WORDS, placementLevel } from "../../src/users/placement";
import { advanceOnboarding, getOrCreate, langFromTelegram, nextOccurrence, offsetFromReported, setSetting, startOnboarding } from "../../src/users/service";
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
  it("placement levels", () => {
    expect(PLACEMENT_WORDS).toHaveLength(10);
    expect([0, 2, 3, 5, 6, 8, 9, 10].map(placementLevel)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
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

  it("full onboarding flow subscribes the level deck", async () => {
    const repo = new Repo(env.DB);
    const deckId = (await seedLevels(env.DB, { 1: ["китап"], 2: ["авыл"] }))[2]!;
    let { user } = await getOrCreate(repo, 9, 9, "ru", T);
    expect(startOnboarding(user)).toEqual({ kind: "lang" });
    const step = async (answer: string) => { const s = await advanceOnboarding(repo, user, answer, T); user = (await repo.getUser(user.id))!; return s; };
    expect(await step("ru")).toMatchObject({ kind: "placement", index: 0, word: "house" });
    for (let i = 0; i < 10; i++) await step(i < 4 ? "1" : "0");
    expect(user.level).toBe(2);
    expect(user.onboardingStep).toBe("goal");
    expect(startOnboarding(user)).toEqual({ kind: "goal", level: 2, known: 4 });
    expect(await step("20")).toEqual({ kind: "remind" });
    const tz = await step("08:00");
    expect(tz.kind).toBe("tz");
    expect(await step("hello")).toMatchObject({ kind: "invalid" });
    const deck = await step("180");
    expect(deck).toEqual({ kind: "deck", slug: "l02" });
    expect(startOnboarding(user)).toEqual({ kind: "deck", slug: "l02" });
    expect(await step("l02")).toMatchObject({ kind: "finished", remindAt: "08:00", tzOffsetMin: 180 });
    expect(user.onboardingStep).toBeNull();
    expect(user.newPerDay).toBe(20);
    expect(await repo.userDeckIds(user.id)).toEqual([deckId]);
  });

  it("first reminder is scheduled for the next occurrence, not right after onboarding", async () => {
    const repo = new Repo(env.DB);
    await seedLevels(env.DB, { 1: ["китап"] });
    let { user } = await getOrCreate(repo, 11, 11, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: "deck", level: 1, remindAt: "09:00", tzOffsetMin: 180 });
    user = (await repo.getUser(user.id))!;
    const at1500 = Date.UTC(2026, 8, 30, 12, 0); // 15:00 local
    await advanceOnboarding(repo, user, "l01", at1500);
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
    expect(s).toEqual({ kind: "deck", slug: "l03" });
    expect((await repo.getUser(user.id))!.tzOffsetMin).toBe(480);
  });
});
