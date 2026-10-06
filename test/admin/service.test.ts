import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { adminStatsText, checkUsage } from "../../src/admin/service";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { seedUser } from "../helpers/seed";
import { harness } from "../helpers/botHarness";

const T = Date.UTC(2026, 8, 30, 6);

describe("admin", () => {
  it("non-admin cannot use admin commands", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    // Before a language is chosen every message is answered with the language screen, /admin as any other.
    const repo = new Repo(env.DB);
    await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
    const before = h.tg.calls.length;
    await h.text("/admin");
    expect(h.tg.calls.length).toBe(before);
  });

  it("warns the admin once when D1 writes pass 80%", async () => {
    const repo = new Repo(env.DB);
    await env.DB.prepare("INSERT INTO usage_daily (day, reviews, rows_written_est, requests) VALUES ('2026-09-30', 1000, 81000, 0)").run();
    const tg = fakeTelegram();
    expect(await checkUsage(repo, tg, 999, T)).toBe(true);
    expect(await checkUsage(repo, tg, 999, T)).toBe(false);
    expect(tg.of("sendMessage")).toHaveLength(1);
  });

  describe("reports", () => {
    it("insertReport is true once per user and word", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T });
      expect(await repo.insertReport(user.id, noteIds[0]!, T)).toBe(true);
      expect(await repo.insertReport(user.id, noteIds[0]!, T + 1)).toBe(false);
      expect(await repo.insertReport(user.id, noteIds[1]!, T + 2)).toBe(true);
    });

    it("recentReports groups by word with a count, newest first, limited", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T });
      const second = await repo.insertUser({ tgId: 2, chatId: 2, lang: "ru", now: T });
      await repo.insertReport(user.id, noteIds[0]!, T + 10);
      await repo.insertReport(second, noteIds[0]!, T + 30);
      await repo.insertReport(user.id, noteIds[1]!, T + 20);
      const list = await repo.recentReports(10);
      expect(list.map((r) => [r.word, r.count, r.lastAt])).toEqual([["китап", 2, T + 30], ["вакыт", 1, T + 20]]);
      expect(list[0]).toMatchObject({ noteId: noteIds[0], translation: "книга" });
      expect(await repo.recentReports(1)).toHaveLength(1);
    });

    it("the admin text lists the 10 most recent reported words with counts, escaped", async () => {
      const { repo, user, deckId } = await seedUser(env.DB, { now: T, words: 1 });
      const ids = await repo.insertNotes(deckId, Array.from({ length: 11 }, (_, i) => ({ word: `с${i}<`, transcription: null, pos: "n", translation: `п${i}`, exampleTt: "", exampleRu: "" })));
      for (const [i, id] of ids.entries()) await repo.insertReport(user.id, id, T + i);
      expect(await adminStatsText(repo, T)).toContain("Жалобы ⚑");
      const text = await adminStatsText(repo, T);
      expect(text).toContain("<b>с10&lt;</b> — п10 · 1");
      expect(text).toContain("<b>с1&lt;</b> — п1 · 1");
      expect(text).not.toContain("с0&lt;");
    });

    it("the admin text says so when there are no reports", async () => {
      expect(await adminStatsText(new Repo(env.DB), T)).toContain("Жалобы ⚑: нет");
    });
  });
});
