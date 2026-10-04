import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderStats } from "../../src/bot/screens";
import { Repo } from "../../src/db/repo";
import { ReviewService } from "../../src/review/service";
import { cumulative, levelsView } from "../../src/stats/service";
import { newMem } from "../../src/srs/fsrs";
import { harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { note, seedLevels, seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
const DAY = 86_400_000;

describe("stats", () => {
  it("cumulative totals by stage, memory, retention and forecast", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 4, patch: { newPerDay: 0 } });
    const a = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 25 * DAY, scheduledDays: 25, stability: 25, difficulty: 5, reps: 5 });
    const b = await repo.insertCard(user.id, noteIds[1]!, "tt_ru", { ...newMem(T), state: "review", due: T + 2 * DAY, lastReview: T - 8 * DAY, scheduledDays: 10, stability: 10, difficulty: 5, reps: 3 });
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
    expect(s.level).toBe(1);
    expect(s.coveragePct).toBeNull();
  });

  it("shows the current level and the coverage of the levels below it", async () => {
    await seedLevels(env.DB, { 3: ["юл"], 4: ["өй", "эш"] }, { 3: 54, 4: 61 });
    const { repo, user } = await seedUser(env.DB, { now: T, level: 4, tgId: 42 });
    const s = await cumulative(repo, user, T);
    expect(s).toMatchObject({ level: 4, coveragePct: 54 });
    const text = renderStats(s, "ru");
    expect(text).toContain("Уровень 4");
    expect(text).toContain("≈54%");
    expect(text).toContain("🎓 Уровень 4 · покрытие текста ≈54%\n🏆 Выучено: 0");
    expect(renderStats(s, "tt")).toContain("🎓 4 нче дәрәҗә · текстта таныш сүзләр: ≈54%");

    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    await h.text("/stats");
    expect(h.lastText()).toContain("Уровень 4");
    expect(h.lastText()).toContain("≈54%");
    expect(db.calls).toBeLessThanOrEqual(8);
  });

  it("leaves the coverage out on level 1 and names the end after level 20", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 2 });
    await seedLevels(env.DB, { 20: ["юл"] }, { 1: 31, 20: 80 });
    const first = renderStats(await cumulative(repo, user, T), "ru");
    expect(first).toContain("🎓 Уровень 1\n");
    expect(first).not.toContain("≈");
    await repo.updateUser(user.id, { level: 21 });
    const done = await cumulative(repo, (await repo.getUser(user.id))!, T);
    expect(done).toMatchObject({ level: 21, coveragePct: 80 });
    expect(renderStats(done, "ru")).toContain("🎓 Все 20 уровней пройдены · покрытие текста ≈80%");
    expect(renderStats(done, "tt")).toContain("🎓 Барлык 20 дәрәҗә үтелде · текстта таныш сүзләр: ≈80%");
  });
});

describe("levels view", () => {
  const graded = gradedMem(T);

  it("counts started words and own copies as seen, and separates passed, open and skipped levels", async () => {
    const ids = await seedLevels(env.DB, { 1: ["китап", "вакыт"], 2: ["авыл", "су"], 3: ["юл", "көн"], 4: ["өй", "эш", "кеше"], 5: ["сүз"] }, { 2: 40, 3: 54 });
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, level: 4, patch: { direction: "both" } });
    // Level 2 was opened later and is finished, level 3 was opened and has one word left; level 1 stays skipped.
    await repo.subscribe(user.id, ids[2]!, T);
    await repo.subscribe(user.id, ids[3]!, T);
    const idsOf = async (deck: number) => (await env.DB.prepare("SELECT id FROM notes WHERE deck_id = ? ORDER BY id").bind(deck).all<{ id: number }>()).results.map((r) => r.id);
    const [l2, l3] = [await idsOf(ids[2]!), await idsOf(ids[3]!)];
    for (const id of [...l2, l3[0]!]) await repo.insertCard(user.id, id, "tt_ru", graded);
    // Level 4: both directions of one word graded (one word, not two), one word shown but not graded, one copied to own words.
    await repo.insertCard(user.id, noteIds[0]!, "tt_ru", graded);
    await repo.insertCard(user.id, noteIds[0]!, "ru_tt", graded);
    await repo.insertCard(user.id, noteIds[1]!, "tt_ru", newMem(T));
    const own = await repo.customDeck(user.id, T);
    await repo.insertNotes(own, [note("Кеше", "человек")]);
    // Another learner's cards and words do not count.
    const other = await seedUser(env.DB, { now: T, level: 4, tgId: 2 });
    await other.repo.insertCard(other.user.id, noteIds[1]!, "tt_ru", graded);
    await other.repo.insertNotes(await other.repo.customDeck(other.user.id, T), [note("эш", "работа")]);

    expect(await repo.levelsOverview(user.id)).toEqual([
      { levelNo: 1, total: 2, coveragePct: null, open: false, seen: 0 },
      { levelNo: 2, total: 2, coveragePct: 40, open: true, seen: 2 },
      { levelNo: 3, total: 2, coveragePct: 54, open: true, seen: 1 },
      { levelNo: 4, total: 3, coveragePct: null, open: true, seen: 2 },
      { levelNo: 5, total: 1, coveragePct: null, open: false, seen: 0 },
    ]);
    const db = countingDb(env.DB);
    expect(await new Repo(db).levelsOverview(user.id)).toHaveLength(5);
    expect(db.calls).toBe(1);

    expect(await levelsView(repo, user)).toEqual({
      passed: [1, 2],
      inProgress: [{ levelNo: 3, seen: 1, total: 2 }, { levelNo: 4, seen: 2, total: 3 }],
      ahead: 1,
      own: [{ kind: "custom", titleRu: "Мои слова", titleTt: "Минем сүзләр", total: 1 }],
      coveragePct: 54,
      skipped: [1],
    });
  });

  it("tells a finished, an untouched and a half-done open level apart, with the words the learner owns a copy of", async () => {
    const ids = await seedLevels(env.DB, { 1: ["китап", "вакыт", "авыл"], 2: ["су", "юл", "көн"], 3: ["өй", "эш", "кеше"], 4: ["сүз", "яңа"], 5: ["зур", "кул"] });
    const { repo, user } = await seedUser(env.DB, { now: T, level: 4 });
    for (const l of [1, 2, 3]) await repo.subscribe(user.id, ids[l]!, T);
    const idsOf = async (deck: number) => (await env.DB.prepare("SELECT id FROM notes WHERE deck_id = ? ORDER BY id").bind(deck).all<{ id: number }>()).results.map((r) => r.id);
    // The learner owns copies of «авыл» (the last word of level 1), «юл» (level 2), «сүз» (level 4) and «зур» (level 5, closed); «юл» twice, in two own decks.
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("авыл"), note("Юл!"), note("сүз"), note("зур")]);
    const ai = await repo.insertDeck({ slug: null, kind: "ai", titleRu: "🤖 т", titleTt: "🤖 т", levelNo: null, coveragePct: null, ownerId: user.id });
    await repo.insertNotes(ai, [note("юл")]);
    // Level 1: the two words that are not copies are started — finished. Level 2: nothing started. Level 3: one of three. Level 4: nothing started.
    for (const id of (await idsOf(ids[1]!)).slice(0, 2)) await repo.insertCard(user.id, id, "tt_ru", graded);
    await repo.insertCard(user.id, (await idsOf(ids[3]!))[0]!, "tt_ru", graded);
    // A card that was shown and not graded is not a started word.
    await repo.insertCard(user.id, (await idsOf(ids[2]!))[0]!, "tt_ru", newMem(T));

    const db = countingDb(env.DB);
    expect(await new Repo(db).levelsOverview(user.id)).toEqual([
      { levelNo: 1, total: 3, coveragePct: null, open: true, seen: 3 },
      { levelNo: 2, total: 3, coveragePct: null, open: true, seen: 1 },
      { levelNo: 3, total: 3, coveragePct: null, open: true, seen: 1 },
      { levelNo: 4, total: 2, coveragePct: null, open: true, seen: 1 },
      { levelNo: 5, total: 2, coveragePct: null, open: false, seen: 0 },
    ]);
    expect(db.calls).toBe(1);
  });

  it("counts only the levels the catalog has above the current one as ahead", async () => {
    // Production today: level 1 is the only level published.
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 3 });
    expect(await levelsView(repo, user)).toEqual({ passed: [], inProgress: [{ levelNo: 1, seen: 0, total: 3 }], ahead: 0, own: [], coveragePct: null, skipped: [] });
    const ids = await seedLevels(env.DB, { 2: ["авыл"], 3: ["су"], 7: ["юл"] });
    expect((await levelsView(repo, user)).ahead).toBe(3);
    // On level 3, with its deck open, only level 7 is ahead.
    await repo.updateUser(user.id, { level: 3 });
    await repo.subscribe(user.id, ids[3]!, T);
    expect((await levelsView(repo, (await repo.getUser(user.id))!)).ahead).toBe(1);
  });

  it("has no line for the current level when its deck is not in the catalog", async () => {
    // A learner placed at level 4 while only level 1 was published: nothing is open.
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 3 });
    await env.DB.prepare("DELETE FROM user_decks").run();
    await repo.updateUser(user.id, { level: 4 });
    expect(await levelsView(repo, (await repo.getUser(user.id))!)).toEqual({ passed: [1], inProgress: [], ahead: 0, own: [], coveragePct: null, skipped: [1] });
  });

  it("a current level that exists but was never opened is a level ahead, in /levels as in the session; /stats is the same as for an open one (ruling T16c)", async () => {
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 42, chatId: 42, lang: "ru", now: T });
    await repo.updateUser(id, { onboardingStep: null, level: 4 });
    const user = (await repo.getUser(id))!;
    await seedLevels(env.DB, { 3: ["юл"], 4: ["авыл", "су"], 5: ["көн"] }, { 3: 54 });
    expect(await levelsView(repo, user)).toEqual({ passed: [3], inProgress: [], ahead: 2, own: [], coveragePct: 54, skipped: [3] });
    const h = harness(env.DB, { now: T });
    await h.text("/levels");
    expect(h.lastText()).toBe(["📚 <b>Уровни</b>", "✅ Пройдено: 3", "🔒 Впереди: 2", "📖 Покрытие текста ≈54%"].join("\n"));
    const closed = await cumulative(repo, user, T);
    expect(closed).toMatchObject({ level: 4, coveragePct: 54, fresh: 0 });
    // The session opens it: now it is the level in progress and one level is ahead.
    await h.text("/learn");
    expect(h.lastText()).toContain("<b>авыл</b>");
    expect(await levelsView(repo, user)).toEqual({ passed: [3], inProgress: [{ levelNo: 4, seen: 0, total: 2 }], ahead: 1, own: [], coveragePct: 54, skipped: [3] });
    expect(await cumulative(repo, user, T)).toMatchObject({ level: 4, coveragePct: 54, fresh: 2 });
  });

  it("takes the coverage from the nearest level below the current one when the catalog has a gap, in /levels and in /stats", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 1 });
    await seedLevels(env.DB, { 3: ["авыл"], 6: ["су"] }, { 1: 31, 3: 54 });
    const at = async (level: number) => { await repo.updateUser(user.id, { level }); return (await repo.getUser(user.id))!; };
    for (const [level, pct] of [[1, null], [3, 31], [6, 54], [21, null]] as const) {
      const u = await at(level);
      expect((await levelsView(repo, u)).coveragePct, `levels at ${level}`).toBe(pct);
      expect((await cumulative(repo, u, T)).coveragePct, `stats at ${level}`).toBe(pct);
    }
  });

  it("after level 20 has no level in progress unless words are left", async () => {
    await seedLevels(env.DB, { 19: ["юл"], 20: ["өй"] }, { 19: 79, 20: 80 });
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, level: 20 });
    await repo.openSkippedLevels(user.id, T);
    await repo.insertCard(user.id, noteIds[0]!, "tt_ru", graded);
    await repo.updateUser(user.id, { level: 21 });
    const v = await levelsView(repo, (await repo.getUser(user.id))!);
    expect(v).toEqual({ passed: [20], inProgress: [{ levelNo: 19, seen: 0, total: 1 }], ahead: 0, own: [], coveragePct: 80, skipped: [] });
  });
});
