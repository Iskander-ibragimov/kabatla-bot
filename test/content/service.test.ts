import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderAddPreview, renderCard } from "../../src/bot/views";
import { Repo, type User } from "../../src/db/repo";
import { LlmClient } from "../../src/content/llm";
import { ContentService, MAX_TYPED, typedTranslation } from "../../src/content/service";
import { transcribe } from "../../src/content/transcribe";
import { consume } from "../../src/entitlements/service";
import { ru } from "../../src/i18n/ru";
import { ReviewService } from "../../src/review/service";
import { tt } from "../../src/i18n/tt";
import { dayWindow } from "../../src/users/service";
import { countingDb } from "../helpers/countingDb";
import { type FakeFetch, card, client, fakeFetch, failingLlm, llmReturning, provider, userPrompt } from "../helpers/llm";
import { note, seedLevels, seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6, 0);
const STRESS = "́";

const service = (repo: Repo, llm: FakeFetch, now = T) => new ContentService(repo, { llm: client(llm) }, now);
/** The user as the database has it now. */
const fresh = async (repo: Repo, user: User) => (await repo.getUser(user.id))!;
/** The notes of the user's «Мои слова» deck, oldest first. */
async function ownNotes(userId: number) {
  const { results } = await env.DB.prepare(
    `SELECT n.word, n.transcription, n.pos, n.translation, n.example_tt, n.example_ru, n.example_src, n.audio_file_id, n.source_url
     FROM notes n JOIN decks d ON d.id = n.deck_id WHERE d.owner_id = ? AND d.kind = 'custom' ORDER BY n.id`,
  ).bind(userId).all<Record<string, string | null>>();
  return results;
}
/** Every note of the catalog with its link: a catalog note is shared by all learners and never carries a user's link. */
async function catalogLinks() {
  const { results } = await env.DB.prepare(
    "SELECT n.word, n.source_url FROM notes n JOIN decks d ON d.id = n.deck_id WHERE d.owner_id IS NULL ORDER BY n.id",
  ).all<{ word: string; source_url: string | null }>();
  return results;
}
const jobsCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n;
/** The preview after a translation was typed for it; throws when the text was not applied. */
const edit = async (svc: ContentService, user: User, text: string) => {
  const r = await svc.editPreviewTranslation(user, text);
  if (r.kind !== "edited") throw new Error(`expected edited, got ${r.kind}`);
  return r;
};
const preview = async (svc: ContentService, user: User, text: string) => {
  const r = await svc.prepareAdd(user, text, []);
  if (r.kind !== "preview") throw new Error(`expected preview, got ${r.kind}`);
  return r;
};

describe("content service: own words", () => {
  it("previews a word with its link, then adds it to My words without queueing a voice job", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, llmReturning([card("рәхмәт", "спасибо")]));
    const r = await preview(svc, user, "рәхмәт https://example.com/a");
    expect(r.items).toEqual([{
      word: "рәхмәт", transcription: transcribe("рәхмәт"), pos: "adj", translation: "спасибо", exampleTt: "Бу рәхмәт.", exampleRu: "Это спасибо.",
      exampleSrc: "ai", audioFileId: null, sourceUrl: "https://example.com/a", ai: true,
    }]);
    expect(await svc.confirmAdd(user, r.previewId)).toEqual({ words: ["рәхмәт"] });
    const hit = await repo.findNoteForUser(user.id, "Рәхмәт");
    expect(hit).toMatchObject({
      transcription: transcribe("рәхмәт"), exampleTt: "Бу рәхмәт.", exampleSrc: "ai", sourceUrl: "https://example.com/a", audioFileId: null,
      deckTitleRu: "Мои слова", deckTitleTt: "Минем сүзләр",
    });
    await expect(svc.confirmAdd(user, r.previewId)).rejects.toThrow();
    expect(await jobsCount()).toBe(0);
  });

  it("a duplicate in an open level is not added again, and the shared catalog note gets no link", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const llm = failingLlm();
    const svc = service(repo, llm);
    const r = await svc.prepareAdd(user, " Китап  https://x.com/v", []);
    // The reply does not claim a link it has not stored.
    expect(r).toEqual({ kind: "duplicates-only", duplicates: [{ word: "Китап", deckTitle: "Уровень 1", linkAdded: false }] });
    expect(await catalogLinks()).toEqual([{ word: "китап", source_url: null }]);
    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    expect(notes!.n).toBe(1);
    const inTatar = await svc.prepareAdd({ ...user, lang: "tt" }, "китап", []);
    expect(inTatar).toMatchObject({ kind: "duplicates-only", duplicates: [{ word: "китап", deckTitle: "1 нче дәрәҗә", linkAdded: false }] });
    expect(llm.urls).toEqual([]);
  });

  it("a link sent by one learner for a level word is not shown on another learner's card", async () => {
    const a = await seedUser(env.DB, { now: T, words: 1, tgId: 1 }); // l01: китап
    const b = await seedUser(env.DB, { now: T, words: 1, tgId: 2 });
    const r = await service(a.repo, failingLlm()).prepareAdd(a.user, "китап https://private.example/a", [{ type: "url", offset: 6, length: 25 }]);
    expect(r).toEqual({ kind: "duplicates-only", duplicates: [{ word: "китап", deckTitle: "Уровень 1", linkAdded: false }] });
    for (const { repo, user } of [b, a]) {
      const screen = await new ReviewService(repo, T).nextScreen(user);
      if (screen.kind !== "card") throw new Error(screen.kind);
      expect(screen.view).toMatchObject({ word: "китап", sourceUrl: null });
      const text = renderCard(screen.view, screen.counts, screen.intervals, false, "ru").text;
      expect(text).not.toContain("🔗");
      expect(text).not.toContain("private.example");
    }
    expect(await catalogLinks()).toEqual([{ word: "китап", source_url: null }]);
  });

  it("a link that was left on a catalog note is shown to nobody and is not copied", async () => {
    const STRAY = "https://stray.example/left-by-someone";
    const a = await seedUser(env.DB, { now: T, level: 1, words: 1, tgId: 1 }); // l01: китап
    // One new word a day: once «китап» is graded the limit is spent, so level 5 (the next level the catalog has) stays closed for b.
    const b = await seedUser(env.DB, { now: T, level: 1, words: 1, tgId: 2, patch: { newPerDay: 1 } });
    await seedLevels(env.DB, { 5: ["бәхет", "шатлык"] });
    await env.DB.prepare("UPDATE notes SET source_url = ? WHERE deck_id IN (SELECT id FROM decks WHERE owner_id IS NULL)").bind(STRAY).run();
    const svc = service(b.repo, failingLlm());

    // (a) the card of the level word, before and after it is started
    const review = new ReviewService(b.repo, T);
    let screen = await review.nextScreen(b.user);
    if (screen.kind !== "card") throw new Error(screen.kind);
    expect(screen.view).toMatchObject({ word: "китап", sourceUrl: null });
    expect(renderCard(screen.view, screen.counts, screen.intervals, false, "ru").text).not.toMatch(/🔗|stray/);
    screen = await review.grade(b.user, screen.view.cardId, screen.view.reps, 1);
    if (screen.kind !== "card") throw new Error(screen.kind);
    expect(screen.view).toMatchObject({ word: "китап", sourceUrl: null });
    expect(renderCard(screen.view, screen.counts, screen.intervals, true, "ru").text).not.toMatch(/🔗|stray/);

    // (b) the duplicate line, with and without a link of the user's own
    expect(await svc.prepareAdd(b.user, "китап", [])).toEqual({ kind: "duplicates-only", duplicates: [{ word: "китап", deckTitle: "Уровень 1", linkAdded: false }] });
    expect(await svc.prepareAdd(b.user, "китап https://b.example/x", [])).toEqual({ kind: "duplicates-only", duplicates: [{ word: "китап", deckTitle: "Уровень 1", linkAdded: false }] });

    // (c) a copy into My words takes only the link typed with the word
    const mine = service(a.repo, failingLlm());
    const r = await preview(mine, a.user, "бәхет\nшатлык https://a.example/song");
    expect(r.items.map((i) => [i.word, i.sourceUrl])).toEqual([["бәхет", null], ["шатлык", "https://a.example/song"]]);
    expect(renderAddPreview(r.items, r.previewId, "ru").text).not.toContain("stray");
    await mine.confirmAdd(a.user, r.previewId);
    expect((await ownNotes(a.user.id)).map((n) => [n.word, n.source_url])).toEqual([["бәхет", null], ["шатлык", "https://a.example/song"]]);

    // (d) the link of an own note is shown to its owner: own words come first in the queue
    const first = await new ReviewService(a.repo, T).nextScreen(a.user);
    if (first.kind !== "card") throw new Error(first.kind);
    expect(first.view).toMatchObject({ word: "бәхет", sourceUrl: null });
    const second = await new ReviewService(a.repo, T).grade(a.user, first.view.cardId, first.view.reps, 4);
    if (second.kind !== "card") throw new Error(second.kind);
    expect(second.view).toMatchObject({ word: "шатлык", sourceUrl: "https://a.example/song" });
    expect(renderCard(second.view, second.counts, second.intervals, true, "ru").text).toContain('🔗 <a href="https://a.example/song">a.example</a>');
  });

  it("a duplicate in a deck the learner owns gets the link: My words and an AI deck", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("рәхмәт"), { ...note("сәлам"), sourceUrl: "https://old.example/s" }]);
    const ai = await repo.insertDeck({ slug: null, kind: "ai", titleRu: "🤖 юл", titleTt: "🤖 юл", levelNo: null, coveragePct: null, ownerId: user.id });
    await repo.insertNotes(ai, [note("билет")]);
    await repo.subscribe(user.id, ai, T);
    const r = await service(repo, failingLlm()).prepareAdd(user, "рәхмәт\nсәлам\nбилет\nhttps://example.com/new", []);
    expect(r).toEqual({ kind: "duplicates-only", duplicates: [
      { word: "рәхмәт", deckTitle: "Мои слова", linkAdded: true },
      { word: "сәлам", deckTitle: "Мои слова", linkAdded: false }, // it has a link already
      { word: "билет", deckTitle: "🤖 юл", linkAdded: true },
    ] });
    const { results } = await env.DB.prepare("SELECT word, source_url FROM notes WHERE deck_id IN (SELECT id FROM decks WHERE owner_id = ?) ORDER BY id").bind(user.id).all();
    expect(results).toEqual([
      { word: "рәхмәт", source_url: "https://example.com/new" }, { word: "сәлам", source_url: "https://old.example/s" }, { word: "билет", source_url: "https://example.com/new" },
    ]);
  });

  it("pending url applies to the next words within 10 minutes only", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const ask = await service(repo, llmReturning([])).prepareAdd(user, "https://youtu.be/q", []);
    expect(ask).toEqual({ kind: "ask-words", url: "https://youtu.be/q" });
    const r = await preview(service(repo, llmReturning([card("матур", "красивый")]), T + 9 * 60_000), await fresh(repo, user), "матур");
    expect(r.items[0]!.sourceUrl).toBe("https://youtu.be/q");
    await service(repo, llmReturning([])).prepareAdd(await fresh(repo, user), "https://youtu.be/z", []);
    const late = await preview(service(repo, llmReturning([card("матур", "красивый")]), T + 11 * 60_000), await fresh(repo, user), "матур");
    expect(late.items[0]!.sourceUrl).toBeNull();
  });

  it("takes a ready card from a level that is not open yet, without calling the AI", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1 });
    await seedLevels(env.DB, { 5: ["бәхет"] });
    await env.DB.prepare("UPDATE notes SET audio_file_id = 'voice-5', transcription = 'бәхе́т' WHERE word_key = 'бәхет'").run();
    const llm = failingLlm();
    const r = await service(repo, llm).prepareAdd(user, "бәхет", []);
    expect(r.kind === "preview" && r.items[0]).toMatchObject({ word: "бәхет", translation: "бәхет-ru", ai: false });
    expect(r.kind === "preview" && r.items).toEqual([{
      word: "бәхет", transcription: "бәхе́т", pos: "n", translation: "бәхет-ru", exampleTt: "бәхет.", exampleRu: "бәхет-ru.",
      exampleSrc: "own", audioFileId: "voice-5", sourceUrl: null, ai: false,
    }]);
    expect(r.kind === "preview" && r.duplicates).toEqual([]);
    expect(llm.urls).toEqual([]);
  });

  it("finds a catalog phrase that is stored with punctuation when it is typed without", async () => {
    // Level 1 (open) and level 5 (not open yet) keep their phrases the way they are shown: «Рәхмәт!», «Хәлләр ничек?».
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1 });
    await seedLevels(env.DB, { 1: ["Рәхмәт!"], 5: ["Хәлләр ничек?"] });
    const llm = failingLlm();
    const svc = service(repo, llm);
    expect(await svc.prepareAdd(user, "рәхмәт", [])).toEqual({ kind: "duplicates-only", duplicates: [{ word: "рәхмәт", deckTitle: "Уровень 1", linkAdded: false }] });
    const r = await preview(svc, user, "хәлләр ничек");
    expect(r.items).toEqual([{
      word: "Хәлләр ничек?", transcription: null, pos: "n", translation: "Хәлләр ничек?-ru", exampleTt: "Хәлләр ничек?.", exampleRu: "Хәлләр ничек?-ru.",
      exampleSrc: "own", audioFileId: null, sourceUrl: null, ai: false,
    }]);
    expect(llm.urls).toEqual([]);
    // The copy keeps the catalog spelling, and the level word is not shown again when level 5 opens.
    await svc.confirmAdd(user, r.previewId);
    expect((await ownNotes(user.id)).map((n) => n.word)).toEqual(["Хәлләр ничек?"]);
    await repo.subscribe(user.id, (await repo.getDeckBySlug("l05"))!.id, T);
    const c = await repo.candidateCards(user.id, T, { ...dayWindow(180, T), directions: ["tt_ru"] });
    expect(c.newNotes.filter((n) => n.word === "Хәлләр ничек?")).toHaveLength(1);
  });

  it("copies the catalog card with its voice into My words under the user's link, in the catalog spelling", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1 });
    await seedLevels(env.DB, { 5: ["бәхет"] });
    await env.DB.prepare("UPDATE notes SET audio_file_id = 'voice-5' WHERE word_key = 'бәхет'").run();
    const svc = service(repo, failingLlm());
    const r = await preview(svc, user, "Бәхет https://example.com/song");
    expect(await svc.confirmAdd(user, r.previewId)).toEqual({ words: ["бәхет"] });
    expect(await ownNotes(user.id)).toEqual([{
      word: "бәхет", transcription: null, pos: "n", translation: "бәхет-ru", example_tt: "бәхет.", example_ru: "бәхет-ru.",
      example_src: "own", audio_file_id: "voice-5", source_url: "https://example.com/song",
    }]);
    // The catalog note itself is left as it was.
    expect(await env.DB.prepare("SELECT n.source_url FROM notes n JOIN decks d ON d.id = n.deck_id WHERE d.level_no = 5").first()).toEqual({ source_url: null });
    expect(await jobsCount()).toBe(0);
  });

  it("does not show the word twice when its level opens later", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 1 }); // l01: китап
    const l5 = (await seedLevels(env.DB, { 5: ["бәхет", "шатлык"] }))[5]!;
    const svc = service(repo, failingLlm());
    const r = await preview(svc, user, "бәхет");
    await svc.confirmAdd(user, r.previewId);
    await repo.subscribe(user.id, l5, T);
    const c = await repo.candidateCards(user.id, T, { ...dayWindow(180, T), directions: ["tt_ru"] });
    expect(c.newNotes.filter((n) => n.word === "бәхет").length).toBe(1);
    // The own copy comes first, and the level gives only its other word.
    expect(c.newNotes.map((n) => n.word)).toEqual(["бәхет", "китап", "шатлык"]);
    expect(c.counts.newAvailable).toBe(3);
    // Typed again, it is a word the user already learns: the own copy, which is the one that is shown, gets the link.
    expect(await svc.prepareAdd(user, "бәхет https://example.com/x", [])).toEqual(
      { kind: "duplicates-only", duplicates: [{ word: "бәхет", deckTitle: "Мои слова", linkAdded: true }] });
    expect((await ownNotes(user.id)).map((n) => n.source_url)).toEqual(["https://example.com/x"]);
    expect(await env.DB.prepare("SELECT source_url FROM notes WHERE deck_id = ? AND word_key = 'бәхет'").bind(l5).first()).toEqual({ source_url: null });
  });

  it("finds the catalog card after the AI restores Tatar letters", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1 });
    await seedLevels(env.DB, { 5: ["әни"] });
    const llm = llmReturning([{ input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мать", exampleTt: "Әни килде.", exampleRu: "Мама пришла." }]);
    const r = await service(repo, llm).prepareAdd(user, "эни", []);
    expect(r.kind === "preview" && r.items[0]).toMatchObject({ word: "әни", translation: "әни-ru", ai: false });
    expect(r.kind === "preview" && r.items[0]).toMatchObject({ exampleTt: "әни.", exampleRu: "әни-ru.", exampleSrc: "own", pos: "n", transcription: null });
    expect(r.kind === "preview" && r.items).toHaveLength(1);
    expect(llm.urls).toHaveLength(1);
  });

  it("reports a duplicate when the restored word is already being learned", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 7 }); // l01 has «өй»
    const llm = llmReturning([{ input: "ой", lang: "tt", word: "өй", pos: "n", translation: "дом", exampleTt: "Өй зур.", exampleRu: "Дом большой." }]);
    const r = await service(repo, llm).prepareAdd(user, "ой https://example.com/h", []);
    // «өй» is a word of the open level: a shared note, so the link is not stored and the reply does not claim it.
    expect(r).toEqual({ kind: "duplicates-only", duplicates: [{ word: "өй", deckTitle: "Уровень 1", linkAdded: false }] });
    expect((await catalogLinks()).filter((n) => n.source_url !== null)).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM previews").first()).toEqual({ n: 0 });
  });

  it("keeps the user's spelling only when the model returned the word without Tatar letters", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const llm = llmReturning([
      // The model lost the letters the user typed: the user's spelling stays.
      { input: "күңел", lang: "tt", word: "кунел", pos: "n", translation: "душа, настроение", exampleTt: "Күңел күтәренке.", exampleRu: "Настроение приподнятое." },
      // The model finished a half-restored phrase and a half-restored word: its spelling is taken.
      { input: "бәхетле коннәр", lang: "tt", word: "бәхетле көннәр", pos: "phr", translation: "счастливые дни", exampleTt: "Бәхетле көннәр килер.", exampleRu: "Счастливые дни придут." },
      { input: "үзгареш", lang: "tt", word: "үзгәреш", pos: "n", translation: "изменение", exampleTt: "Зур үзгәреш булды.", exampleRu: "Произошло большое изменение." },
      // Typed right, returned as typed.
      { input: "тәрәзә", lang: "tt", word: "тәрәзә", pos: "n", translation: "окно", exampleTt: "Тәрәзә ачык.", exampleRu: "Окно открыто." },
    ]);
    const r = await preview(service(repo, llm), user, "күңел\nбәхетле коннәр\nүзгареш\nтәрәзә");
    expect(r.items.map((i) => i.word)).toEqual(["күңел", "бәхетле көннәр", "үзгәреш", "тәрәзә"]);
    expect(r.items[0]).toMatchObject({ transcription: transcribe("күңел"), translation: "душа, настроение", ai: true, exampleSrc: "ai" });
    expect(r.items[2]).toMatchObject({ transcription: transcribe("үзгәреш"), translation: "изменение", ai: true });
  });

  it("takes the model's spelling of a half-restored word and looks it up in the catalog", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 7 }); // l01 has «көн»
    await seedLevels(env.DB, { 5: ["күңел"] });
    const llm = llmReturning([
      { input: "күнел", lang: "tt", word: "күңел", pos: "n", translation: "душа", exampleTt: "Күңел тыныч.", exampleRu: "На душе спокойно." },
      { input: "сәгат", lang: "tt", word: "сәгать", pos: "n", translation: "час, часы", exampleTt: "Сәгать ничә?", exampleRu: "Который час?" },
      { input: "көнн", lang: "tt", word: "көн", pos: "n", translation: "день", exampleTt: "Көн матур.", exampleRu: "День красивый." },
    ]);
    const r = await preview(service(repo, llm), user, "күнел\nсәгат\nкөнн");
    // «күңел» stands in a level: the reviewed catalog card is used, not the model's.
    expect(r.items[0]).toEqual({
      word: "күңел", transcription: null, pos: "n", translation: "күңел-ru", exampleTt: "күңел.", exampleRu: "күңел-ru.", exampleSrc: "own", audioFileId: null, sourceUrl: null, ai: false,
    });
    // «сәгать» is in no level: the model's card under the restored spelling.
    expect(r.items[1]).toEqual({
      word: "сәгать", transcription: transcribe("сәгать"), pos: "n", translation: "час, часы", exampleTt: "Сәгать ничә?", exampleRu: "Который час?",
      exampleSrc: "ai", audioFileId: null, sourceUrl: null, ai: true,
    });
    expect(r.items).toHaveLength(2);
    // «көн» is a word of the open level: a duplicate, found only by the restored spelling.
    expect(r.duplicates).toEqual([{ word: "көн", deckTitle: "Уровень 1", linkAdded: false }]);
    expect(r.manual).toEqual([]);
  });

  it("puts a typed verb form on the card of its dictionary form", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 1 });
    const llm = llmReturning([{ input: "киләм", lang: "tt", word: "килү", pos: "v", translation: "приходить", exampleTt: "Мин иртәгә киләм.", exampleRu: "Я приду завтра." }]);
    const svc = service(repo, llm);
    const r = await preview(svc, user, "киләм");
    expect(r.items).toEqual([{
      word: "килү", transcription: transcribe("килү"), pos: "v", translation: "приходить", exampleTt: "Мин иртәгә киләм.", exampleRu: "Я приду завтра.",
      exampleSrc: "ai", audioFileId: null, sourceUrl: null, ai: true,
    }]);
    // When «килү» is in the catalog, the typed form leads to its reviewed card, so the word is not shown twice when the level opens.
    await seedLevels(env.DB, { 3: ["килү"] });
    const again = await preview(svc, user, "киләм");
    expect(again.items.map((i) => [i.word, i.translation, i.ai])).toEqual([["килү", "килү-ru", false]]);
  });

  it("gives a Tatar word for Russian input and transcribes it by the rules", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const llm = llmReturning([{ input: "спасибо", lang: "ru", word: "рәхмәт", pos: "intj", translation: "спасибо", exampleTt: "Зур рәхмәт!", exampleRu: "Большое спасибо!" }]);
    const svc = service(repo, llm);
    const r = await preview(svc, user, "спасибо");
    const item = r.items[0]!;
    expect(item).toMatchObject({ word: "рәхмәт", transcription: transcribe("рәхмәт"), ai: true, exampleSrc: "ai" });
    expect(item).toEqual({
      word: "рәхмәт", transcription: "рәхмә́т", pos: "intj", translation: "спасибо", exampleTt: "Зур рәхмәт!", exampleRu: "Большое спасибо!",
      exampleSrc: "ai", audioFileId: null, sourceUrl: null, ai: true,
    });
    expect(await svc.confirmAdd(user, r.previewId)).toEqual({ words: ["рәхмәт"] });
    expect(await ownNotes(user.id)).toEqual([{
      word: "рәхмәт", transcription: "рәхмә́т", pos: "intj", translation: "спасибо", example_tt: "Зур рәхмәт!", example_ru: "Большое спасибо!",
      example_src: "ai", audio_file_id: null, source_url: null,
    }]);
  });

  it("matches the AI cards to the lines by the echoed input, whatever their order and case", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const llm = llmReturning([
      { input: " РАХМАТ ", lang: "tt", word: "рәхмәт", pos: "intj", translation: "спасибо", exampleTt: "Зур рәхмәт!", exampleRu: "Большое спасибо!" },
      // Echoes the answer instead of the line: this card belongs to no line.
      { input: "әни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." },
      { input: "мама", lang: "ru", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни килде.", exampleRu: "Мама пришла." },
      // A card for a line the model was not asked about: «китап» is a word of the open level.
      { input: "китап", lang: "tt", word: "китаб", pos: "n", translation: "книга", exampleTt: "Бу китаб.", exampleRu: "Это книга." },
    ]);
    const r = await preview(service(repo, llm), user, "мама\nэни\nкитап\nрахмат");
    expect(r.items.map((i) => [i.word, i.exampleTt])).toEqual([["әни", "Әни килде."], ["рәхмәт", "Зур рәхмәт!"]]);
    expect(r.manual).toEqual(["эни"]);
    expect(r.duplicates).toEqual([{ word: "китап", deckTitle: "Уровень 1", linkAdded: false }]);
    expect(userPrompt(llm)).toBe("Lines:\nмама\nэни\nрахмат");
  });

  it("shows a word once when two lines lead to it", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 7 }); // l01 has «өй»
    await seedLevels(env.DB, { 5: ["әни"] });
    const llm = llmReturning([
      { input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." },
      { input: "мама", lang: "ru", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни килде.", exampleRu: "Мама пришла." },
      { input: "ой", lang: "tt", word: "өй", pos: "n", translation: "дом", exampleTt: "Өй зур.", exampleRu: "Дом большой." },
      { input: "рахмат", lang: "tt", word: "рәхмәт", pos: "intj", translation: "спасибо", exampleTt: "Зур рәхмәт!", exampleRu: "Большое спасибо!" },
      { input: "спасибо", lang: "ru", word: "Рәхмәт", pos: "intj", translation: "спасибо", exampleTt: "Рәхмәт сиңа!", exampleRu: "Спасибо тебе!" },
    ]);
    const r = await preview(service(repo, llm), user, "әни\nэни\nмама\nөй\nой\nрахмат\nспасибо");
    expect(r.items.map((i) => [i.word, i.ai])).toEqual([["әни", false], ["рәхмәт", true]]);
    expect(r.duplicates).toEqual([{ word: "өй", deckTitle: "Уровень 1", linkAdded: false }]);
    expect(r.manual).toEqual([]);
    // Only the lines that neither the user's decks nor the catalog know go to the model.
    expect(userPrompt(llm)).toBe("Lines:\nэни\nмама\nой\nрахмат\nспасибо");
  });

  it("strips a typed stress mark before the lookup, the AI request, the transcription and the storage", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 1 }); // l01: китап
    await seedLevels(env.DB, { 5: ["бәхет"] });
    const llm = llmReturning([card("рәхмәт", "спасибо")]);
    const svc = service(repo, llm);
    const r = await preview(svc, user, `кита${STRESS}п\nбәхе${STRESS}т\nрәхмә${STRESS}т\nрәхмә̀т`);
    expect(r.duplicates).toEqual([{ word: "китап", deckTitle: "Уровень 1", linkAdded: false }]);
    expect(r.items.map((i) => [i.word, i.ai, i.transcription])).toEqual([["бәхет", false, null], ["рәхмәт", true, "рәхмә́т"]]);
    expect(userPrompt(llm)).toBe("Lines:\nрәхмәт");
    await svc.confirmAdd(user, r.previewId);
    expect((await ownNotes(user.id)).map((n) => [n.word, n.transcription])).toEqual([["бәхет", null], ["рәхмәт", "рәхмә́т"]]);
    expect(await service(repo, llm).prepareAdd(user, STRESS, [])).toEqual({ kind: "empty" });
  });

  it("marks an AI preview and leaves a catalog-only preview unmarked", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 1 });
    await seedLevels(env.DB, { 5: ["бәхет", "шатлык"] });
    const NOTE = "перевод сделан AI, проверьте";
    expect(ru.aiNote).toContain(NOTE);

    const catalogOnly = await preview(service(repo, failingLlm()), user, "бәхет");
    const one = renderAddPreview(catalogOnly.items, catalogOnly.previewId, "ru");
    expect(one.text).not.toContain(NOTE);
    expect(one.text).toContain("<b>бәхет</b>\n<i>сущ.</i>\n\n<b>бәхет-ru</b>");
    const catalogList = await preview(service(repo, failingLlm()), user, "бәхет\nшатлык");
    expect(renderAddPreview(catalogList.items, catalogList.previewId, "ru").text).not.toContain(NOTE);

    const ai = await preview(service(repo, llmReturning([card("рәхмәт", "спасибо")])), user, "рәхмәт");
    const aiOne = renderAddPreview(ai.items, ai.previewId, "ru");
    expect(aiOne.text.endsWith(`\n${ru.aiNote}`)).toBe(true);
    expect(aiOne.text).toContain("<b>рәхмәт</b>\n[рәхмә́т] · <i>прил.</i>\n\n<b>спасибо</b>");

    const mixed = await preview(service(repo, llmReturning([card("рәхмәт", "спасибо")])), user, "бәхет\nрәхмәт");
    expect(mixed.items.map((i) => i.ai)).toEqual([false, true]);
    const list = renderAddPreview(mixed.items, mixed.previewId, "ru");
    expect(list.text.endsWith(`\n\n${ru.aiNote}`)).toBe(true);
    expect(list.text.split(NOTE)).toHaveLength(2);
    const inTatar = renderAddPreview(mixed.items, mixed.previewId, "tt");
    expect(inTatar.text.endsWith(`\n\n${tt.aiNote}`)).toBe(true);
    expect(inTatar.text).not.toContain(NOTE);
  });

  it("asks for a manual translation when the AI is down and still transcribes the word", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, failingLlm());
    const r = await svc.prepareAdd(user, `мату${STRESS}р https://c.com`, []);
    expect(r).toEqual({ kind: "manual", word: "матур", others: [], duplicates: [] });
    const word = await svc.completeManual(await fresh(repo, user), " красивый ");
    expect(word).toBe("матур");
    expect(transcribe("матур")).toBe("мату́р");
    expect(await ownNotes(user.id)).toEqual([{
      word: "матур", transcription: transcribe("матур"), pos: "", translation: "красивый", example_tt: "", example_ru: "",
      example_src: "", audio_file_id: null, source_url: "https://c.com",
    }]);
    expect((await fresh(repo, user)).pendingEdit).toBeNull();
    expect(await svc.completeManual(await fresh(repo, user), "ещё")).toBeNull();
    expect(await jobsCount()).toBe(0);
  });

  it("keeps the catalog cards in the preview when the AI is down and lists the rest as untranslated", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 1 });
    await seedLevels(env.DB, { 5: ["бәхет"] });
    const r = await preview(service(repo, failingLlm()), user, "китап\nматур\nбәхет\nсәер");
    expect(r.items.map((i) => i.word)).toEqual(["бәхет"]);
    expect(r.manual).toEqual(["матур", "сәер"]);
    expect(r.duplicates.map((d) => d.word)).toEqual(["китап"]);
    expect((await fresh(repo, user)).pendingEdit).toBeNull();
  });

  it("edit changes the preview translation, and the card is no longer marked as AI-translated", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, llmReturning([card("матур", "красивый")]));
    const r = await preview(svc, user, "матур");
    expect(r.items[0]!.ai).toBe(true);
    await svc.startEdit(user, r.previewId);
    const edited = await edit(svc, await fresh(repo, user), "красивый, прекрасный");
    expect(edited.previewId).toBe(r.previewId);
    expect(edited.items[0]).toMatchObject({ word: "матур", translation: "красивый, прекрасный", ai: false, exampleSrc: "ai" });
    expect(renderAddPreview(edited.items, edited.previewId, "ru").text).not.toContain(ru.aiNote);
    await svc.confirmAdd(user, r.previewId);
    expect((await ownNotes(user.id)).map((n) => [n.word, n.translation])).toEqual([["матур", "красивый, прекрасный"]]);
  });

  it("adding or cancelling the preview that is being edited ends the edit; another preview does not", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, llmReturning([card("матур", "красивый"), card("зур", "большой"), card("яшел", "зелёный")]));
    const [a, b, c] = [await preview(svc, user, "матур"), await preview(svc, user, "зур"), await preview(svc, user, "яшел")];

    await svc.startEdit(user, a.previewId);
    await svc.confirmAdd(await fresh(repo, user), b.previewId);
    expect(svc.pendingKind(await fresh(repo, user))).toBe("preview");
    await svc.confirmAdd(await fresh(repo, user), a.previewId);
    expect((await fresh(repo, user)).pendingEdit).toBeNull();

    await svc.startEdit(user, c.previewId);
    expect(svc.pendingKind(await fresh(repo, user))).toBe("preview");
    await svc.cancel(await fresh(repo, user), c.previewId);
    expect((await fresh(repo, user)).pendingEdit).toBeNull();
    expect((await ownNotes(user.id)).map((n) => n.word)).toEqual(["зур", "матур"]);
  });

  it("a typed text for a preview that is gone or expired changes nothing and ends the edit", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, llmReturning([card("матур", "красивый")]));
    const r = await preview(svc, user, "матур");
    await svc.startEdit(user, r.previewId);
    const editing = await fresh(repo, user);
    const later = service(repo, failingLlm(), T + 24 * 3_600_000 + 1);
    expect(await later.editPreviewTranslation(editing, "красивый")).toEqual({ kind: "gone" });
    expect((await fresh(repo, user)).pendingEdit).toBeNull();
    expect((await repo.getPreview<{ translation: string }[]>(user.id, r.previewId, "add", 0))![0]!.translation).toBe("красивый");
    // Without a preview in edit there is nothing to apply the text to.
    expect(await svc.editPreviewTranslation(await fresh(repo, user), "красивый")).toEqual({ kind: "gone" });

    await svc.startEdit(user, r.previewId);
    await env.DB.prepare("DELETE FROM previews").run();
    // The length of the text does not matter once the preview is gone.
    expect(await svc.editPreviewTranslation(await fresh(repo, user), "я".repeat(500))).toEqual({ kind: "gone" });
    expect((await fresh(repo, user)).pendingEdit).toBeNull();
  });

  it("answers a line longer than 80 characters with too-long and touches nothing", async () => {
    const { user } = await seedUser(env.DB, { now: T, words: 1, patch: { pendingUrl: "https://youtu.be/q", pendingUrlAt: T } });
    const llm = llmReturning([card("матур", "красивый")]);
    const db = countingDb(env.DB);
    const svc = new ContentService(new Repo(db), { llm: client(llm) }, T);
    const long = "сүз ".repeat(20) + "я"; // 81 characters
    expect(long).toHaveLength(81);
    expect(await svc.prepareAdd(user, long, [])).toEqual({ kind: "too-long", max: 80 });
    expect(await svc.prepareAdd(user, `матур\n${long}\nзур`, [])).toEqual({ kind: "too-long", max: 80 });
    expect(llm.urls).toEqual([]);
    expect(db.calls).toBe(0); // the remembered link is still waiting for the words
    // A stress mark is not a character of the line: 80 letters with one pass.
    const fits = "сүз ".repeat(19) + `суз${STRESS}а`;
    expect(fits.replace(STRESS, "")).toHaveLength(80);
    expect((await svc.prepareAdd(user, fits, [])).kind).toBe("manual");
    expect(userPrompt(llm)).toBe(`Lines:\n${fits.replace(STRESS, "")}`);
  });

  it("takes a typed translation of at most 200 characters, on one line", async () => {
    expect(typedTranslation("  красивый,\n прекрасный  ")).toBe("красивый, прекрасный");
    expect(typedTranslation("я".repeat(200))).toBe("я".repeat(200));
    expect(typedTranslation("я".repeat(201))).toBeNull();
    expect(MAX_TYPED).toEqual({ line: 80, translation: 200 });

    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, failingLlm());
    await svc.prepareAdd(user, "матур", []);
    const waiting = await fresh(repo, user);
    await expect(svc.completeManual(waiting, "я".repeat(201))).rejects.toThrow(/too long/);
    // Nothing is saved and the bot still waits for the translation.
    expect(await ownNotes(user.id)).toEqual([]);
    expect((await fresh(repo, user)).pendingEdit).toBe(waiting.pendingEdit);
    expect(await svc.completeManual(waiting, "красивый,\nпрекрасный")).toBe("матур");
    expect((await ownNotes(user.id)).map((n) => n.translation)).toEqual(["красивый, прекрасный"]);

    const ai = service(repo, llmReturning([card("зур", "большой")]));
    const r = await preview(ai, await fresh(repo, user), "зур");
    await ai.startEdit(user, r.previewId);
    const editing = await fresh(repo, user);
    expect(await ai.editPreviewTranslation(editing, "я".repeat(201))).toEqual({ kind: "too-long" });
    expect((await fresh(repo, user)).pendingEdit).toBe(editing.pendingEdit);
    expect((await repo.getPreview<{ translation: string; ai: boolean }[]>(user.id, r.previewId, "add", 0))![0]).toMatchObject({ translation: "большой", ai: true });
    const edited = await edit(ai, editing, " большой,\r\nкрупный ");
    expect(edited.items[0]).toMatchObject({ translation: "большой, крупный", ai: false });
  });

  it("20 lines cost one LLM request and at most 7 D1 calls", async () => {
    // The longest path: a remembered link, duplicates in own decks that get it, catalog words, restored words found in both lookups, AI cards.
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 7, patch: { pendingUrl: "https://youtu.be/q", pendingUrlAt: T } });
    await seedLevels(env.DB, { 5: ["бәхет", "шатлык", "әни"] });
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("дус"), note("күңел")]);
    const own = Array.from({ length: 12 }, (_, i) => `сүз${"абвгдежзиклм"[i]}`);
    const lines = ["китап", "ой", "бәхет", "шатлык", "эни", "дус", "кунел", "күбәләк", ...own];
    expect(lines).toHaveLength(20);
    const llm = llmReturning([card("эни", "мама", "әни"), card("ой", "дом", "өй"), card("кунел", "душа", "күңел"), card("күбәләк", "бабочка"), ...own.map((w) => card(w, "слово"))]);
    const db = countingDb(env.DB);
    const r = await preview(new ContentService(new Repo(db), { llm: new LlmClient([provider("https://llm/v1")], llm) }, T), user, lines.join("\n"));
    expect(r.items).toHaveLength(16);
    expect(r.items.filter((i) => !i.ai).map((i) => i.word)).toEqual(["бәхет", "шатлык", "әни"]);
    expect(r.items.every((i) => i.sourceUrl === "https://youtu.be/q")).toBe(true);
    expect(r.duplicates).toEqual([
      { word: "китап", deckTitle: "Уровень 1", linkAdded: false }, { word: "өй", deckTitle: "Уровень 1", linkAdded: false },
      { word: "дус", deckTitle: "Мои слова", linkAdded: true }, { word: "күңел", deckTitle: "Мои слова", linkAdded: true },
    ]);
    expect(llm.urls).toEqual(["https://llm/v1/chat/completions"]);
    // pending link cleared, two lookups by the typed words, two by the restored ones, the links of the duplicates in one batch, the preview.
    expect(db.calls).toBe(7);
    expect((await ownNotes(user.id)).map((n) => [n.word, n.source_url])).toEqual([["дус", "https://youtu.be/q"], ["күңел", "https://youtu.be/q"]]);
    expect((await catalogLinks()).filter((n) => n.source_url !== null)).toEqual([]);
  });

  it("words with Tatar letters that the AI returns as typed need no second lookup", async () => {
    const { user } = await seedUser(env.DB, { now: T, words: 1 });
    const words = Array.from({ length: 20 }, (_, i) => `сүз${i}`);
    const llm = llmReturning(words.map((w) => card(w, "слово")));
    const db = countingDb(env.DB);
    const r = await preview(new ContentService(new Repo(db), { llm: new LlmClient([provider("https://llm/v1")], llm) }, T), user, words.join("\n"));
    expect(r.items).toHaveLength(20);
    expect(llm.urls).toEqual(["https://llm/v1/chat/completions"]);
    expect(db.calls).toBe(3);
  });

  it("one invalid card does not sink the batch and untranslated words are all reported", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, llmReturning([card("матур", "красивый"), card("айфон", "iPhone")]));
    const r = await preview(svc, user, "матур\nайфон\nяшәү");
    expect(r.items.map((i) => i.word)).toEqual(["матур"]);
    expect(r.manual).toEqual(["айфон", "яшәү"]);
  });

  it("manual fallback mentions every untranslated word", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, failingLlm()).prepareAdd(user, "матур\nяшәү\nсәер", []);
    expect(r).toMatchObject({ kind: "manual", word: "матур", others: ["яшәү", "сәер"] });
  });

  it("a hanging provider is cut off by the overall deadline", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const hang = fakeFetch((_u, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const svc = new ContentService(repo, { llm: client(hang, "https://a/v1", "https://b/v1") }, T, { deadlineMs: 300 });
    const started = Date.now();
    const r = await svc.prepareAdd(user, "матур", []);
    expect(r.kind).toBe("manual");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("content service: AI decks", () => {
  it("gen limit is 3 per local day and resets at 04:00 local", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    for (let i = 0; i < 3; i++) expect(await consume(repo, await fresh(repo, user), "gen", T)).toBe(true);
    expect(await consume(repo, await fresh(repo, user), "gen", T)).toBe(false);
    const next4am = Date.UTC(2026, 9, 1, 1, 1); // 04:01 local next day
    expect(await consume(repo, await fresh(repo, user), "gen", next4am)).toBe(true);
  });

  it("builds an AI deck with transcriptions and no audio jobs", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const letters = "абвгдежзиклм";
    const cards = [...Array.from({ length: 12 }, (_, i) => card(`сүз${letters[i]}`, `слово ${i}`)), card("СҮЗА", "повтор"), { ...card("сүзя", "мусор"), translation: "junk" }];
    const llm = llmReturning(cards);
    const svc = service(repo, llm);
    const r = await svc.generateDeck(user, "собеседование в IT", 99);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(userPrompt(llm)).toBe("Topic: собеседование в IT\nNumber of cards: 30");
    expect(r.items).toHaveLength(12);
    expect(r.items[3]).toEqual({
      word: "сүзг", transcription: transcribe("сүзг"), pos: "adj", translation: "слово 3", exampleTt: "Бу сүзг.", exampleRu: "Это слово 3.",
      exampleSrc: "ai", audioFileId: null, sourceUrl: null, ai: true,
    });
    expect(r.items.map((i) => i.transcription)).toEqual(r.items.map((i) => transcribe(i.word)));
    const d = await svc.confirmDeck(user, r.previewId);
    expect(d.count).toBe(12);
    expect(await repo.userDeckIds(user.id)).toContain(d.deckId);
    expect(await repo.getDeck(d.deckId)).toMatchObject({ kind: "ai", titleRu: "🤖 собеседование в IT", titleTt: "🤖 собеседование в IT", levelNo: null, coveragePct: null, total: 12 });
    const { results } = await env.DB.prepare("SELECT word, transcription, example_src, audio_file_id FROM notes WHERE deck_id = ? ORDER BY id").bind(d.deckId).all<Record<string, string | null>>();
    expect(results).toHaveLength(12);
    expect(results[0]).toEqual({ word: "сүза", transcription: "сүза́", example_src: "ai", audio_file_id: null });
    for (const n of results) expect(n).toEqual({ word: n.word, transcription: transcribe(n.word!), example_src: "ai", audio_file_id: null });
    expect(await repo.findNoteForUser(user.id, "сүзг")).toMatchObject({ translation: "слово 3", exampleTt: "Бу сүзг." });
    expect(await jobsCount()).toBe(0);
    await expect(svc.confirmDeck(user, r.previewId)).rejects.toThrow();
  });

  it("failed generation refunds the daily quota", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, failingLlm()).generateDeck(user, "космос", 10);
    expect(r.kind).toBe("failed");
    expect((await fresh(repo, user)).gensCount).toBe(0);
    // Exactly one unit comes back: two decks made earlier today stay counted.
    for (let i = 0; i < 2; i++) expect(await consume(repo, await fresh(repo, user), "gen", T)).toBe(true);
    expect((await service(repo, llmReturning([{ ...card("сүз"), translation: "junk" }])).generateDeck(await fresh(repo, user), "космос", 10)).kind).toBe("failed");
    expect((await fresh(repo, user)).gensCount).toBe(2);
  });
});

describe("repo.findCatalogNotes", () => {
  it("finds catalog notes of any level by word key in one D1 call, and nothing else", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, level: 1, words: 2 }); // l01: китап, вакыт
    await seedLevels(env.DB, { 5: ["бәхет"], 7: ["Әни"] });
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("рәхмәт"), note("бәхет", "своё")]);
    const db = countingDb(env.DB);
    const found = await new Repo(db).findCatalogNotes([" Бәхет ", "ӘНИ", "китап", "рәхмәт", "юк", "китап"]);
    expect(db.calls).toBe(1);
    expect([...found.keys()].sort()).toEqual(["бәхет", "китап", "әни"].sort());
    expect(found.get("бәхет")).toMatchObject({ word: "бәхет", translation: "бәхет-ru", levelNo: 5, exampleSrc: "own", audioFileId: null });
    expect(found.get("әни")).toMatchObject({ word: "Әни", levelNo: 7 });
    expect(found.get("китап")).toMatchObject({ translation: "книга", levelNo: 1 });
    expect(found.get("бәхет")!.id).toBeGreaterThan(0);
    expect(found.get("бәхет")!.deckId).toBe((await repo.getDeckBySlug("l05"))!.id);
  });
  it("asks nothing for an empty list", async () => {
    const db = countingDb(env.DB);
    expect((await new Repo(db).findCatalogNotes([])).size).toBe(0);
    expect(db.calls).toBe(0);
  });
});
