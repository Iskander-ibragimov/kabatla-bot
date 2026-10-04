import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { WORDS, seedLevels, seedUser } from "./seed";

const T = Date.UTC(2026, 8, 30, 6);

describe("seed helpers", () => {
  it("seedLevels creates level decks l01… with the agreed note fields and returns their ids", async () => {
    const ids = await seedLevels(env.DB, { 1: ["бер"], 6: ["авыл", "су"] }, { 6: 61 });
    const repo = new Repo(env.DB);
    expect(await repo.getDeckBySlug("l01")).toEqual({ id: ids[1], slug: "l01", ownerId: null, kind: "catalog", titleRu: "Уровень 1", titleTt: "1 нче дәрәҗә", levelNo: 1, coveragePct: null, total: 1 });
    expect(await repo.getDeckBySlug("l06")).toMatchObject({ slug: "l06", titleRu: "Уровень 6", titleTt: "6 нчы дәрәҗә", levelNo: 6, coveragePct: 61, total: 2 });
    const notes = await env.DB.prepare("SELECT word, translation, example_tt FROM notes WHERE deck_id = ? ORDER BY id").bind(ids[6]).all();
    expect(notes.results).toEqual([
      { word: "авыл", translation: "авыл-ru", example_tt: "авыл." },
      { word: "су", translation: "су-ru", example_tt: "су." },
    ]);
  });

  it("seedLevels sets coverage for a level that already exists", async () => {
    const { deckId } = await seedUser(env.DB, { now: T, words: 2 });
    const ids = await seedLevels(env.DB, { 2: ["авыл"] }, { 1: 31 });
    const repo = new Repo(env.DB);
    expect(await repo.getDeckBySlug("l01")).toMatchObject({ id: deckId, coveragePct: 31, total: 2 });
    expect(await repo.getDeckBySlug("l02")).toMatchObject({ id: ids[2], coveragePct: null, total: 1 });
  });

  it("seedUser gives an onboarded user subscribed to level 1 built from the first five WORDS", async () => {
    const { repo, user, deckId, noteIds } = await seedUser(env.DB, { now: T });
    expect(user).toMatchObject({ onboardingStep: null, level: 1, lang: "ru", direction: "tt_ru" });
    expect(await repo.userDeckIds(user.id)).toEqual([deckId]);
    expect(await repo.getDeckBySlug("l01")).toMatchObject({ id: deckId, levelNo: 1, total: 5 });
    expect(noteIds).toHaveLength(5);
    expect(await repo.visibleNote(user.id, noteIds[1]!)).toMatchObject({ word: WORDS[1]![0], translation: WORDS[1]![1], exampleTt: "вакыт." });
  });

  it("seedUser reuses an existing level deck instead of creating one from WORDS", async () => {
    const ids = await seedLevels(env.DB, { 4: ["дүрт", "биш"] });
    const first = await seedUser(env.DB, { now: T, level: 4, words: 9, tgId: 1 });
    const second = await seedUser(env.DB, { now: T, level: 4, tgId: 2 });
    expect(first.deckId).toBe(ids[4]);
    expect(second.deckId).toBe(ids[4]);
    expect(first.user.level).toBe(4);
    expect(second.noteIds).toEqual(first.noteIds);
    expect(await first.repo.getDeckBySlug("l04")).toMatchObject({ id: ids[4], total: 2 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM decks").first<{ n: number }>())!.n).toBe(1);
  });
});
