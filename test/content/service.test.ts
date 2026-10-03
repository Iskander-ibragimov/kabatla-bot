import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { LlmClient, LlmUnavailable, WordCardSchema } from "../../src/content/llm";
import { ContentService } from "../../src/content/service";
import { consume } from "../../src/entitlements/service";
import { z } from "zod";
import { seedUser } from "../helpers/seed";
import { countingDb } from "../helpers/countingDb";

const T = Date.UTC(2026, 8, 30, 6, 0);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chat = (content: string) => json({ choices: [{ message: { content } }] });
const P = (baseUrl: string) => ({ baseUrl, apiKey: "k", model: "m" });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(h: Handler): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => { const u = String(input instanceof Request ? input.url : input); urls.push(u); return h(u, init); }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
}
const card = (word: string, translation = "перевод") => ({ word, transcription: null, pos: "adj", translation, exampleTt: `Бу ${word}.`, exampleRu: `Это ${translation}.` });

describe("llm", () => {
  const Schema = z.object({ cards: z.array(WordCardSchema) });
  it("falls back to the next provider on malformed json", async () => {
    const f = fakeFetch((u) => (u.startsWith("https://one") ? chat("not json") : chat(JSON.stringify({ cards: [card("матур", "красивый")] }))));
    const r = await new LlmClient([P("https://one/v1"), P("https://two/v1")], f).completeJson("sys", "user", Schema);
    expect(r.cards[0]).toMatchObject({ translation: "красивый", exampleTt: "Бу матур." });
    expect(f.urls).toEqual(["https://one/v1/chat/completions", "https://two/v1/chat/completions"]);
  });
  it("rejects a translation that is not Russian", async () => {
    const f = fakeFetch(() => chat(JSON.stringify({ cards: [{ ...card("матур", "красивый"), translation: "beautiful" }] })));
    await expect(new LlmClient([P("https://one/v1")], f).completeJson("s", "u", Schema)).rejects.toBeInstanceOf(LlmUnavailable);
  });
  it("accepts fenced json and throws when all fail", async () => {
    const ok = fakeFetch(() => chat("```json\n" + JSON.stringify({ cards: [card("матур", "красивый")] }) + "\n```"));
    expect((await new LlmClient([P("https://one/v1")], ok).completeJson("s", "u", Schema)).cards).toHaveLength(1);
    const bad = fakeFetch(() => json({ error: "rate" }, 429));
    await expect(new LlmClient([P("https://one/v1"), P("https://two/v1")], bad).completeJson("s", "u", Schema)).rejects.toBeInstanceOf(LlmUnavailable);
  });
});

function service(repo: Repo, now: number, llmCards: ReturnType<typeof card>[] | "fail" = []) {
  const f = fakeFetch(() => (llmCards === "fail" ? json({}, 500) : chat(JSON.stringify({ cards: llmCards }))));
  return new ContentService(repo, { llm: new LlmClient([P("https://llm/v1")], f) }, now);
}

describe("content service", () => {
  it("previews a word with its link, then adds it to My words without queueing a voice job", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, [card("рәхмәт", "спасибо")]);
    const r = await svc.prepareAdd(user, "рәхмәт https://example.com/a", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items).toEqual([{ word: "рәхмәт", transcription: null, pos: "adj", translation: "спасибо", exampleTt: "Бу рәхмәт.", exampleRu: "Это спасибо.", sourceUrl: "https://example.com/a" }]);
    expect(await svc.confirmAdd(user, r.previewId)).toEqual({ words: ["рәхмәт"] });
    const hit = await repo.findNoteForUser(user.id, "Рәхмәт");
    expect(hit).toMatchObject({ exampleTt: "Бу рәхмәт.", sourceUrl: "https://example.com/a", audioFileId: null, deckTitleRu: "Мои слова", deckTitleTt: "Минем сүзләр" });
    await expect(svc.confirmAdd(user, r.previewId)).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n).toBe(0);
  });

  it("duplicate in a subscribed deck is not added again but gets the link", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, []);
    const r = await svc.prepareAdd(user, " Китап  https://x.com/v", []);
    expect(r).toMatchObject({ kind: "duplicates-only", duplicates: [{ word: "Китап", deckTitle: "Уровень 1", linkAdded: true }] });
    expect((await repo.findNoteForUser(user.id, "китап"))!.sourceUrl).toBe("https://x.com/v");
    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    expect(notes!.n).toBe(1);
    const inTatar = await svc.prepareAdd({ ...user, lang: "tt" }, "китап", []);
    expect(inTatar).toMatchObject({ kind: "duplicates-only", duplicates: [{ word: "китап", deckTitle: "1 нче дәрәҗә", linkAdded: false }] });
  });

  it("pending url applies to the next words within 10 minutes only", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const ask = await service(repo, T).prepareAdd(user, "https://youtu.be/q", []);
    expect(ask).toEqual({ kind: "ask-words", url: "https://youtu.be/q" });
    const u = (await repo.getUser(user.id))!;
    const r = await service(repo, T + 9 * 60_000, [card("матур", "красивый")]).prepareAdd(u, "матур", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items[0]!.sourceUrl).toBe("https://youtu.be/q");
    await service(repo, T, []).prepareAdd((await repo.getUser(user.id))!, "https://youtu.be/z", []);
    const late = await service(repo, T + 11 * 60_000, [card("матур", "красивый")]).prepareAdd((await repo.getUser(user.id))!, "матур", []);
    if (late.kind !== "preview") throw new Error(late.kind);
    expect(late.items[0]!.sourceUrl).toBeNull();
  });

  it("falls back to manual translation when AI is unavailable", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, "fail");
    const r = await svc.prepareAdd(user, "матур https://c.com", []);
    expect(r).toMatchObject({ kind: "manual", word: "матур" });
    const word = await svc.completeManual((await repo.getUser(user.id))!, "красивый");
    expect(word).toBe("матур");
    expect(await repo.findNoteForUser(user.id, "матур")).toMatchObject({ translation: "красивый", transcription: null, exampleTt: "", sourceUrl: "https://c.com" });
    expect((await repo.getUser(user.id))!.pendingEdit).toBeNull();
  });

  it("edit changes the preview translation", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, [card("матур", "красивый")]);
    const r = await svc.prepareAdd(user, "матур", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    await svc.startEdit(user, r.previewId);
    const edited = await svc.editPreviewTranslation((await repo.getUser(user.id))!, "красивый, прекрасный");
    expect(edited.previewId).toBe(r.previewId);
    expect(edited.items[0]!.translation).toBe("красивый, прекрасный");
  });

  it("gen limit is 3 per local day and resets at 04:00 local", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    for (let i = 0; i < 3; i++) expect(await consume(repo, (await repo.getUser(user.id))!, "gen", T)).toBe(true);
    expect(await consume(repo, (await repo.getUser(user.id))!, "gen", T)).toBe(false);
    const next4am = Date.UTC(2026, 9, 1, 1, 1); // 04:01 local next day
    expect(await consume(repo, (await repo.getUser(user.id))!, "gen", next4am)).toBe(true);
  });

  it("generateDeck clamps n and creates a subscribed AI deck on confirm", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const cards = Array.from({ length: 12 }, (_, i) => card(`сүз${i}`, `слово${i}`));
    let prompt = "";
    const f = fakeFetch((_u, init) => { prompt = String(init?.body); return chat(JSON.stringify({ cards })); });
    const svc = new ContentService(repo, { llm: new LlmClient([P("https://llm/v1")], f) }, T);
    const r = await svc.generateDeck(user, "собеседование в IT", 99);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(prompt).toContain("30");
    expect(r.items).toHaveLength(12);
    const d = await svc.confirmDeck(user, r.previewId);
    expect(d.count).toBe(12);
    expect(await repo.userDeckIds(user.id)).toContain(d.deckId);
    expect(await repo.getDeck(d.deckId)).toMatchObject({ kind: "ai", titleRu: "🤖 собеседование в IT", titleTt: "🤖 собеседование в IT", levelNo: null, coveragePct: null, total: 12 });
    expect(await repo.findNoteForUser(user.id, "сүз3")).toMatchObject({ translation: "слово3", exampleTt: "Бу сүз3." });
  });

  it("20 words cost one LLM request and stay within the D1 budget of a webhook", async () => {
    const { user } = await seedUser(env.DB, { now: T, words: 1 });
    const words = Array.from({ length: 20 }, (_, i) => `сүз${i}`);
    const f = fakeFetch(() => chat(JSON.stringify({ cards: words.map((w) => card(w, "слово")) })));
    const db = countingDb(env.DB);
    const svc = new ContentService(new Repo(db), { llm: new LlmClient([P("https://llm/v1")], f) }, T);
    const r = await svc.prepareAdd(user, words.join("\n"), []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items).toHaveLength(20);
    expect(f.urls).toEqual(["https://llm/v1/chat/completions"]);
    expect(db.calls).toBeLessThanOrEqual(8);
  });

  it("one invalid card does not sink the batch and untranslated words are all reported", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, [card("матур", "красивый"), card("айфон", "iPhone")]);
    const r = await svc.prepareAdd(user, "матур\nайфон\nяшәү", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items.map((i) => i.word)).toEqual(["матур"]);
    expect(r.manual).toEqual(["айфон", "яшәү"]);
  });

  it("manual fallback mentions every untranslated word", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T, "fail").prepareAdd(user, "матур\nяшәү\nсәер", []);
    expect(r).toMatchObject({ kind: "manual", word: "матур", others: ["яшәү", "сәер"] });
  });

  it("a hanging provider is cut off by the overall deadline", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const hang = fakeFetch((_u, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const svc = new ContentService(repo, { llm: new LlmClient([P("https://a/v1"), P("https://b/v1")], hang) }, T, { deadlineMs: 300 });
    const started = Date.now();
    const r = await svc.prepareAdd(user, "матур", []);
    expect(r.kind).toBe("manual");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("failed generation refunds the daily quota", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T, "fail").generateDeck(user, "космос", 10);
    expect(r.kind).toBe("failed");
    expect((await repo.getUser(user.id))!.gensCount).toBe(0);
  });
});
