import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { note } from "../helpers/seed";

const T = Date.UTC(2026, 9, 4, 6);

async function deck(repo: Repo, slug: string, levelNo: number | null, ownerId: number | null = null) {
  return repo.insertDeck({ slug, kind: ownerId ? "custom" : "catalog", titleRu: slug, titleTt: slug, levelNo, coveragePct: null, ownerId });
}

describe("CEFR schema (migration 0008)", () => {
  it("a new user has the catalog defaults", async () => {
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now: T });
    const u = (await repo.getUser(id))!;
    expect(u).toMatchObject({ levels: 1, posGroups: 255, newMode: "guided", topicNo: null, hintsSeen: 0, newCursors: null });
    const raw = await env.DB.prepare("SELECT levels, pos_groups, new_mode, topic_no IS NULL AS no_topic, hints_seen FROM users WHERE id = ?").bind(id).first();
    expect(raw).toEqual({ levels: 1, pos_groups: 255, new_mode: "guided", no_topic: 1, hints_seen: 0 });
  });

  it("rejects an unknown new_mode", async () => {
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now: T });
    await expect(env.DB.prepare("UPDATE users SET new_mode = 'x' WHERE id = ?").bind(id).run()).rejects.toThrow();
  });

  it("a word key is unique among catalog notes across decks, but own notes may repeat it", async () => {
    const repo = new Repo(env.DB);
    const a = await deck(repo, "a1", 1);
    const b = await deck(repo, "a2", 2);
    await repo.insertNotes(a, [{ ...note("китап"), level: 1, topicNo: 0, seq: 1 }]);
    await expect(repo.insertNotes(b, [{ ...note("китап"), level: 2, topicNo: 0, seq: 1 }])).rejects.toThrow();

    const userId = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now: T });
    const own1 = await deck(repo, "own1", null, userId);
    const own2 = await deck(repo, "own2", null, userId);
    await repo.insertNotes(own1, [note("су")]);
    await expect(repo.insertNotes(own2, [note("су")])).resolves.toHaveLength(1);
    const rows = await env.DB.prepare("SELECT level, topic_no, seq, tseq FROM notes WHERE word_key = 'су'").all();
    expect(rows.results).toEqual([
      { level: null, topic_no: null, seq: null, tseq: null },
      { level: null, topic_no: null, seq: null, tseq: null },
    ]);
  });

  it("insertNotes writes level, topic, seq and tseq = topic * 1_000_000 + seq", async () => {
    const repo = new Repo(env.DB);
    const a = await deck(repo, "a1", 1);
    await repo.insertNotes(a, [{ ...note("китап"), level: 1, topicNo: 3, seq: 7 }]);
    expect(await env.DB.prepare("SELECT level, topic_no, seq, tseq FROM notes").first()).toEqual({ level: 1, topic_no: 3, seq: 7, tseq: 3_000_007 });
  });

  it("meta holds the initial catalog version and hash", async () => {
    const rows = await env.DB.prepare("SELECT key, value FROM meta ORDER BY key").all();
    expect(rows.results).toEqual([{ key: "catalog_hash", value: "" }, { key: "catalog_version", value: "0" }]);
  });

  it("the new tables exist and start empty", async () => {
    for (const t of ["topics", "catalog_groups", "user_progress"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n")).toBe(0);
    }
  });
});
