import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo, type User } from "../../src/db/repo";
import { ALL_POS } from "../../src/levels/scale";
import { addAllPos, addLevel, coverageOf, hub, setMode, setTopic, toggleLevel, togglePos, topicLines, unstartedIn } from "../../src/levels/service";
import { cumulative } from "../../src/stats/service";
import { countingDb } from "../helpers/countingDb";
import { gradedMem } from "../helpers/review";
import { note, recountProgress, seedCatalog, seedLearner, seedTopics } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 7, 0);

type CatalogRow = Parameters<typeof seedCatalog>[1][number];
/** `n` catalog words of one level and topic, named after them: «с1т2х1»… */
const words = (level: number, topic: number, n: number): CatalogRow[] => Array.from({ length: n }, (_, i) => ({ level, topic, word: `с${level}т${topic}х${i + 1}` }));
/** Starts the notes for the user: a graded card each, and the counters of started words in step with the cards. */
async function start(repo: Repo, userId: number, noteIds: number[]) {
  for (let i = 0; i < noteIds.length; i += 50) await repo.batch(noteIds.slice(i, i + 50).map((id) => repo.insertCardStmt(userId, id, "tt_ru", gradedMem(T))));
  await recountProgress(env.DB, userId);
}
const fresh = async (repo: Repo, user: User) => (await repo.getUser(user.id))!;
const setCoverage = (level: number, pct: number) => env.DB.prepare("UPDATE decks SET coverage_pct = ? WHERE level_no = ?").bind(pct, level).run();

/**
 * A1: 40 words of «Семья и близкие» (topic 2), 3 of «Знакомство и вежливость» (1), 5 of «Основа» (0), coverage 45%.
 * A2: 2 words of topic 2 and 4 of «Еда» (8). B1, B2, C1 have no cards. Returns the note ids by `level:topic`.
 */
async function catalog() {
  await seedTopics(env.DB);
  const rows = [...words(1, 2, 40), ...words(1, 1, 3), ...words(1, 0, 5), ...words(2, 2, 2), ...words(2, 8, 4)];
  const ids = await seedCatalog(env.DB, rows);
  await setCoverage(1, 45);
  const by: Record<string, number[]> = {};
  rows.forEach((r, i) => (by[`${r.level}:${r.topic}`] ??= []).push(ids[i]!));
  return by;
}

describe("hub: what /levels shows", () => {
  it("a learner with A1 checked and 12 of 40 started in topic 2: the lines of the levels, the current topic, the own decks", async () => {
    const ids = await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T });
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем1"), note("үзем2")]);
    await start(repo, user.id, [...ids["1:2"]!.slice(0, 12), ...ids["1:1"]!]);

    const h = await hub(repo, user);
    expect(h.levels).toEqual([
      { no: 1, code: "A1", checked: true, total: 48, size: 500, started: 15, coveragePct: 45 },
      { no: 2, code: "A2", checked: false, total: 6, size: 850, started: 0, coveragePct: null },
      // A level without cards: «скоро».
      { no: 3, code: "B1", checked: false, total: 0, size: 850, started: 0, coveragePct: null },
      { no: 4, code: "B2", checked: false, total: 0, size: 800, started: 0, coveragePct: null },
      { no: 5, code: "C1", checked: false, total: 0, size: 850, started: 0, coveragePct: null },
    ]);
    // Topic 1 is finished, so the guided order stands in topic 2; its numbers are those of the checked level alone.
    expect(h.topic).toEqual({ no: 2, titleRu: "Семья и близкие", titleTt: "Гаилә һәм якыннар", started: 12, total: 40 });
    expect(h.mode).toBe("guided");
    expect(h.posGroups).toBe(ALL_POS);
    expect(h.own).toEqual([{ kind: "custom", titleRu: "Мои слова", titleTt: "Минем сүзләр", total: 2 }]);
  });

  it("counts the started words of a level whatever is checked, and another learner's words not at all", async () => {
    const ids = await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { levels: 2 } });
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    await start(repo, user.id, [...ids["1:2"]!.slice(0, 7), ids["2:8"]![0]!]);
    await start(repo, other.user.id, ids["1:0"]!);
    await repo.insertNotes(await other.repo.customDeck(other.user.id, T), [note("чит")]);
    const h = await hub(repo, user);
    expect(h.levels.slice(0, 2).map((l) => [l.code, l.checked, l.started, l.total])).toEqual([["A1", false, 7, 48], ["A2", true, 1, 6]]);
    expect(h.own).toEqual([]);
  });

  it("the current topic: the chosen one; in the guided order without a choice the first themed topic that has a word left, then «Основа», then none", async () => {
    const ids = await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const topicOf = async (patch: Partial<User> = {}) => (await hub(repo, { ...(await fresh(repo, user)), ...patch })).topic?.no ?? null;
    // Nothing is started: topic 1 comes first, not «Основа» (topic 0), whose words are mixed into the themed topics.
    expect(await topicOf()).toBe(1);
    await start(repo, user.id, ids["1:1"]!);
    expect(await topicOf()).toBe(2);
    // A topic the learner chose is shown whatever its place, with its progress.
    expect((await hub(repo, { ...user, topicNo: 1 })).topic).toMatchObject({ no: 1, started: 3, total: 3 });
    expect(await topicOf({ newMode: "topic", topicNo: 2 })).toBe(2);
    // «Сам выбираю тему» without a choice has no current topic; «По частоте» has none at all.
    expect(await topicOf({ newMode: "topic" })).toBeNull();
    expect(await topicOf({ newMode: "freq" })).toBeNull();
    expect(await topicOf({ newMode: "freq", topicNo: 2 })).toBeNull();
    // Every themed word of the checked level is started and basic words are left: «Основа».
    await start(repo, user.id, ids["1:2"]!);
    expect((await hub(repo, user)).topic).toEqual({ no: 0, titleRu: "Основа", titleTt: "Нигез сүзләр", started: 0, total: 5 });
    await start(repo, user.id, ids["1:0"]!);
    expect(await topicOf()).toBeNull();
    // With A2 checked as well, its words of topic 2 are left.
    expect((await hub(repo, { ...user, levels: 3 })).topic).toMatchObject({ no: 2, started: 40, total: 42 });
  });

  it("is one D1 call, within the two the screen may make", async () => {
    await catalog();
    const { user } = await seedLearner(env.DB, { now: T });
    const db = countingDb(env.DB);
    await hub(new Repo(db), user);
    expect(db.calls).toBeLessThanOrEqual(2);
    expect(db.calls).toBe(1);
  });

  it("with an empty catalog every level is «скоро» and there is no topic", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const h = await hub(repo, user);
    expect(h.levels.map((l) => [l.code, l.checked, l.total, l.started, l.coveragePct])).toEqual(
      [["A1", true, 0, 0, null], ["A2", false, 0, 0, null], ["B1", false, 0, 0, null], ["B2", false, 0, 0, null], ["C1", false, 0, 0, null]]);
    expect(h.topic).toBeNull();
    expect(h.own).toEqual([]);
  });
});

describe("a catalog word the learner owns a copy of (ruling T6a)", () => {
  it("counts as started: the level reads «N из N», its coverage shows, and no topic is left to name", async () => {
    const ids = await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const a1 = [...ids["1:2"]!, ...ids["1:1"]!, ...ids["1:0"]!];
    // Every word of A1 but the last of topic 2 is started; that one the learner typed, so the session will never give it.
    await start(repo, user.id, a1.filter((id) => id !== ids["1:2"]![39]));
    const before = await hub(repo, user);
    expect(before.levels[0]).toMatchObject({ started: 47, total: 48 });
    expect(before.topic).toMatchObject({ no: 2, started: 39, total: 40 });
    expect(coverageOf(before.levels)).toBeNull();

    await repo.insertNotes(await repo.customDeck(user.id, T), [note("с1т2х40")]);
    const h = await hub(repo, user);
    expect(h.levels[0]).toEqual({ no: 1, code: "A1", checked: true, total: 48, size: 500, started: 48, coveragePct: 45 });
    expect(h.topic).toBeNull();
    expect(coverageOf(h.levels)).toBe(45);
    expect(unstartedIn(h.levels)).toBe(0);
    expect(await cumulative(repo, user, T)).toMatchObject({ levels: [1], fresh: 0, coveragePct: 45 });
    expect((await topicLines(repo, user)).map((l) => [l.no, l.started, l.total])).toEqual([[0, 5, 5], [1, 3, 3], [2, 40, 40]]);
  });
});

describe("topicLines: what «Темы» shows", () => {
  it("the topics that have cards in the checked levels, by number, with what is started of them there", async () => {
    const ids = await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T });
    await start(repo, user.id, [...ids["1:2"]!.slice(0, 12), ids["2:2"]![0]!, ids["2:8"]![0]!]);
    expect(await topicLines(repo, user)).toEqual([
      { no: 0, titleRu: "Основа", titleTt: "Нигез сүзләр", started: 0, total: 5 },
      { no: 1, titleRu: "Знакомство и вежливость", titleTt: "Танышу һәм әдәп", started: 0, total: 3 },
      { no: 2, titleRu: "Семья и близкие", titleTt: "Гаилә һәм якыннар", started: 12, total: 40 },
    ]);
    // With A2 checked too, topic 2 counts both levels and «Еда» appears.
    expect((await topicLines(repo, { ...user, levels: 3 })).map((l) => [l.no, l.started, l.total])).toEqual([[0, 0, 5], [1, 0, 3], [2, 13, 42], [8, 1, 4]]);
    expect((await topicLines(repo, { ...user, levels: 2 })).map((l) => [l.no, l.started, l.total])).toEqual([[2, 1, 2], [8, 1, 4]]);
    const db = countingDb(env.DB);
    await topicLines(new Repo(db), user);
    expect(db.calls).toBe(1);
  });
});

describe("toggleLevel", () => {
  it("checks a level that has cards and unchecks it again, one D1 call each", async () => {
    await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const db = countingDb(env.DB);
    expect(await toggleLevel(new Repo(db), user, 2)).toBe("ok");
    expect(db.calls).toBe(1);
    expect((await fresh(repo, user)).levels).toBe(3);
    expect(await toggleLevel(repo, user, 1)).toBe("ok");
    expect((await fresh(repo, user)).levels).toBe(2);
    expect(await toggleLevel(repo, user, 1)).toBe("ok");
    expect((await fresh(repo, user)).levels).toBe(3);
  });

  it("on the only checked level answers `last` and writes nothing (Review Focus 3)", async () => {
    await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { topicNo: 2, newCursors: "{\"k\":\"x\"}" } });
    const before = await fresh(repo, user);
    expect(await toggleLevel(repo, user, 1)).toBe("last");
    expect(await fresh(repo, user)).toEqual(before);
    // Two taps at once on the last level: the set is not empty after either.
    expect(await Promise.all([toggleLevel(repo, user, 1), toggleLevel(repo, user, 1)])).toEqual(["last", "last"]);
    expect(await fresh(repo, user)).toEqual(before);
  });

  it("two toggles at once both apply, whatever the user row the caller holds says (Review Focus 3)", async () => {
    await seedCatalog(env.DB, [1, 2, 3, 4].map((level) => ({ level, word: `сүз${level}` })));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    // Both callers hold the same row, read before either write: levels = A1.
    expect(await Promise.all([toggleLevel(repo, user, 2), toggleLevel(repo, user, 3)])).toEqual(["ok", "ok"]);
    expect((await fresh(repo, user)).levels).toBe(0b111);
    // The row the caller holds is stale by now; the toggle goes by the stored set, not by it.
    expect(await Promise.all([toggleLevel(repo, user, 1), toggleLevel(repo, user, 4), toggleLevel(repo, user, 2)])).toEqual(["ok", "ok", "ok"]);
    expect((await fresh(repo, user)).levels).toBe(0b1100);
    // Two taps on one level at once are two changes: the set is what it was, as after the last tap.
    expect(await Promise.all([toggleLevel(repo, user, 1), toggleLevel(repo, user, 1)])).toEqual(["ok", "ok"]);
    expect((await fresh(repo, user)).levels).toBe(0b1100);
    // The two checked levels unchecked at once: one of the two taps is refused, and the set is never empty.
    expect((await Promise.all([toggleLevel(repo, user, 3), toggleLevel(repo, user, 4)])).sort()).toEqual(["last", "ok"]);
    expect([0b0100, 0b1000]).toContain((await fresh(repo, user)).levels);
  });

  it("answers `soon` for a level without cards, for one the catalog has no deck of and for a number off the scale, and changes nothing", async () => {
    await catalog();
    // B1 has a deck and no card in it; B2 and C1 have no deck.
    await new Repo(env.DB).insertDeck({ slug: "b1", kind: "catalog", titleRu: "B1", titleTt: "B1", levelNo: 3, coveragePct: null, ownerId: null });
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const before = await fresh(repo, user);
    for (const no of [3, 4, 5, 0, 6, 1.5, -1]) expect(await toggleLevel(repo, user, no), `level ${no}`).toBe("soon");
    expect(await fresh(repo, user)).toEqual(before);
    // A catalog deck numbered off the scale is no level either, cards or not: the statement itself refuses it.
    const off = await repo.insertDeck({ slug: "l07", kind: "catalog", titleRu: "Уровень 7", titleTt: "7 нче дәрәҗә", levelNo: 7, coveragePct: null, ownerId: null });
    await repo.insertNotes(off, [note("җиде")]);
    expect(await repo.toggleLevel(user.id, 7)).toEqual({ changed: false, hasCards: false });
    expect(await fresh(repo, user)).toEqual(before);
    // A deck that is not of the catalog is not a level, whatever number stands on it.
    const own = await repo.insertDeck({ slug: null, kind: "custom", titleRu: "Мои слова", titleTt: "Минем сүзләр", levelNo: 4, coveragePct: null, ownerId: user.id });
    await repo.insertNotes(own, [note("үзем")]);
    expect(await toggleLevel(repo, user, 4)).toBe("soon");
    expect(await fresh(repo, user)).toEqual(before);
  });

  it("clears the chosen topic in the same statement when the new set of levels has no card of it", async () => {
    await catalog();
    // «Еда» (topic 8) has cards in A2 only; «Семья и близкие» (topic 2) in A1 and A2.
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { levels: 3, topicNo: 8, newMode: "topic" } });
    const db = countingDb(env.DB);
    expect(await toggleLevel(new Repo(db), user, 2)).toBe("ok");
    expect(db.calls).toBe(1);
    expect(await fresh(repo, user)).toMatchObject({ levels: 1, topicNo: null, newMode: "topic" });
    // A topic that still has cards in the levels left stays chosen; checking a level never clears it.
    await repo.updateUser(user.id, { levels: 3, topicNo: 2 });
    expect(await toggleLevel(repo, user, 2)).toBe("ok");
    expect(await fresh(repo, user)).toMatchObject({ levels: 1, topicNo: 2 });
    expect(await toggleLevel(repo, user, 2)).toBe("ok");
    expect(await fresh(repo, user)).toMatchObject({ levels: 3, topicNo: 2 });
    // A refused toggle leaves the topic as well.
    await repo.updateUser(user.id, { levels: 2, topicNo: 8 });
    expect(await toggleLevel(repo, user, 2)).toBe("last");
    expect(await fresh(repo, user)).toMatchObject({ levels: 2, topicNo: 8 });
  });
});

describe("addLevel", () => {
  it("checks a level that has cards and never unchecks it, one D1 call; it gives the levels checked after it and leaves the rest of the row alone", async () => {
    await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { topicNo: 2, newMode: "topic" } });
    const db = countingDb(env.DB);
    expect(await addLevel(new Repo(db), user, 2)).toBe(0b11);
    expect(db.calls).toBe(1);
    expect(await fresh(repo, user)).toEqual({ ...user, levels: 0b11 });
    // A second press, and two that arrive together, leave it checked.
    expect(await addLevel(repo, user, 2)).toBe(0b11);
    expect(await Promise.all([addLevel(repo, user, 2), addLevel(repo, user, 2)])).toEqual([0b11, 0b11]);
    expect(await fresh(repo, user)).toEqual({ ...user, levels: 0b11 });
  });

  it("checks nothing for a level without cards or a number off the scale: the levels stay as they are", async () => {
    await catalog();
    await new Repo(env.DB).insertDeck({ slug: "b1", kind: "catalog", titleRu: "B1", titleTt: "B1", levelNo: 3, coveragePct: null, ownerId: null });
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const off = await repo.insertDeck({ slug: "l07", kind: "catalog", titleRu: "Уровень 7", titleTt: "7 нче дәрәҗә", levelNo: 7, coveragePct: null, ownerId: null });
    await repo.insertNotes(off, [note("җиде")]);
    for (const no of [3, 4, 5, 0, 6, 7, -1]) expect(await addLevel(repo, user, no), `level ${no}`).toBe(0b1);
    expect(await fresh(repo, user)).toEqual(user);
  });
});

describe("togglePos", () => {
  it("flips one part-of-speech group in one D1 call; the last group stays, and two toggles at once both apply", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const db = countingDb(env.DB);
    expect(await togglePos(new Repo(db), user, 1)).toBe("ok");
    expect(db.calls).toBe(1);
    expect((await fresh(repo, user)).posGroups).toBe(0b11111101);
    expect(await Promise.all([togglePos(repo, user, 0), togglePos(repo, user, 7)])).toEqual(["ok", "ok"]);
    expect((await fresh(repo, user)).posGroups).toBe(0b01111100);
    expect(await togglePos(repo, user, 1)).toBe("ok");
    expect((await fresh(repo, user)).posGroups).toBe(0b01111110);

    await repo.updateUser(user.id, { posGroups: 1 << 5 });
    const before = await fresh(repo, user);
    expect(await togglePos(repo, user, 5)).toBe("last");
    expect(await Promise.all([togglePos(repo, user, 5), togglePos(repo, user, 5)])).toEqual(["last", "last"]);
    expect(await fresh(repo, user)).toEqual(before);
    await expect(togglePos(repo, user, 8)).rejects.toThrow(RangeError);
    expect(await fresh(repo, user)).toEqual(before);
  });

  it("addAllPos checks every group", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { posGroups: 1 << 5 } });
    await addAllPos(repo, user);
    expect((await fresh(repo, user)).posGroups).toBe(ALL_POS);
  });
});

describe("setMode and setTopic", () => {
  it("setMode stores the order of new words and leaves the chosen topic", async () => {
    await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { topicNo: 2 } });
    for (const mode of ["topic", "freq", "guided"] as const) {
      await setMode(repo, user, mode);
      expect(await fresh(repo, user)).toMatchObject({ newMode: mode, topicNo: 2 });
    }
  });

  it("setTopic chooses a topic that has cards in the checked levels, and answers `empty` for one that has none", async () => {
    await catalog();
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const db = countingDb(env.DB);
    expect(await setTopic(new Repo(db), user, 2)).toBe("ok");
    expect(db.calls).toBe(1);
    expect((await fresh(repo, user)).topicNo).toBe(2);
    // «Еда» has cards in A2, which is not checked; topic 15 has none anywhere; 99 is no topic.
    for (const no of [8, 15, 99]) expect(await setTopic(repo, user, no), `topic ${no}`).toBe("empty");
    expect((await fresh(repo, user)).topicNo).toBe(2);
    // The check goes by the stored set of levels, not by the row the caller holds.
    await repo.updateUser(user.id, { levels: 2 });
    expect(await setTopic(repo, user, 8)).toBe("ok");
    expect((await fresh(repo, user)).topicNo).toBe(8);
    expect(await setTopic(repo, user, 0)).toBe("empty");
    // «Не выбирать».
    expect(await setTopic(repo, user, null)).toBe("ok");
    expect((await fresh(repo, user)).topicNo).toBeNull();
  });
});

describe("the catalog as the repo reads it for these screens", () => {
  it("levelsData: the decks of the levels A1…C1 with their cards and coverage, and the topics by number", async () => {
    await catalog();
    const repo = new Repo(env.DB);
    // Neither an own deck nor a catalog deck numbered off the scale is a level.
    const { user } = await seedLearner(env.DB, { now: T });
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем")]);
    await repo.insertDeck({ slug: "l07", kind: "catalog", titleRu: "Уровень 7", titleTt: "7 нче дәрәҗә", levelNo: 7, coveragePct: 60, ownerId: null });
    const { decks, topics } = await repo.levelsData(user.id, false);
    expect(decks).toEqual([{ level: 1, total: 48, coveragePct: 45 }, { level: 2, total: 6, coveragePct: null }]);
    expect(topics).toHaveLength(21);
    expect(topics.slice(0, 3)).toEqual([
      { no: 0, slug: "core", titleRu: "Основа", titleTt: "Нигез сүзләр" },
      { no: 1, slug: "greet", titleRu: "Знакомство и вежливость", titleTt: "Танышу һәм әдәп" },
      { no: 2, slug: "family", titleRu: "Семья и близкие", titleTt: "Гаилә һәм якыннар" },
    ]);
  });
});

describe("what the lines of the levels say together", () => {
  const line = (no: 1 | 2 | 3 | 4 | 5, checked: boolean, started: number, total: number, coveragePct: number | null = null) =>
    ({ no, code: `L${no}`, checked, total, size: 850, started, coveragePct });

  it("unstartedIn: the cards of the checked levels that are not started, never below 0", () => {
    expect(unstartedIn([line(1, true, 10, 400), line(2, false, 0, 850), line(3, true, 5, 20)])).toBe(405);
    expect(unstartedIn([line(1, true, 400, 400), line(2, false, 0, 850)])).toBe(0);
    // A counter above the cards of its level does not hide the words left in another level.
    expect(unstartedIn([line(1, true, 410, 400), line(2, true, 0, 7)])).toBe(7);
    expect(unstartedIn([])).toBe(0);
  });

  it("coverageOf: the coverage of the highest level up to which every level is started whole, checked or not", () => {
    expect(coverageOf([line(1, true, 399, 400, 45), line(2, true, 850, 850, 60)])).toBeNull();
    expect(coverageOf([line(1, true, 400, 400, 45), line(2, true, 849, 850, 60)])).toBe(45);
    expect(coverageOf([line(1, false, 400, 400, 45), line(2, true, 850, 850, 60), line(3, false, 0, 0)])).toBe(60);
    // A level without cards is not started whole, and a level without a coverage has none to give.
    expect(coverageOf([line(1, true, 0, 0, 45)])).toBeNull();
    expect(coverageOf([line(1, true, 400, 400)])).toBeNull();
  });
});
