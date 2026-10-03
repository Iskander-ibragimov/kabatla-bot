import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DECK_SYSTEM, LlmUnavailable, WORDS_SYSTEM, WordCardSchema, completeCards } from "../../src/content/llm";
import { isTatarText } from "../../src/content/tatar";
import { card, chat, client, fakeFetch, json, llmReturning } from "../helpers/llm";

const ANI = { input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." };
const ok = (over: Record<string, unknown>) => WordCardSchema.safeParse({ ...ANI, ...over }).success;

describe("llm client", () => {
  const Schema = z.object({ cards: z.array(WordCardSchema) });
  it("falls back to the next provider on malformed json", async () => {
    const f = fakeFetch((u) => (u.startsWith("https://one") ? chat("not json") : chat(JSON.stringify({ cards: [card("матур", "красивый")] }))));
    const r = await client(f, "https://one/v1", "https://two/v1").completeJson("sys", "user", Schema);
    expect(r.cards[0]).toMatchObject({ translation: "красивый", exampleTt: "Бу матур." });
    expect(f.urls).toEqual(["https://one/v1/chat/completions", "https://two/v1/chat/completions"]);
  });
  it("rejects a translation that is not Russian", async () => {
    const f = llmReturning([{ ...card("матур", "красивый"), translation: "beautiful" }]);
    await expect(client(f).completeJson("s", "u", Schema)).rejects.toBeInstanceOf(LlmUnavailable);
  });
  it("accepts fenced json and throws when all fail", async () => {
    const fenced = fakeFetch(() => chat("```json\n" + JSON.stringify({ cards: [card("матур", "красивый")] }) + "\n```"));
    expect((await client(fenced).completeJson("s", "u", Schema)).cards).toHaveLength(1);
    const bad = fakeFetch(() => json({ error: "rate" }, 429));
    await expect(client(bad, "https://one/v1", "https://two/v1").completeJson("s", "u", Schema)).rejects.toBeInstanceOf(LlmUnavailable);
  });
});

describe("WordCardSchema", () => {
  it("accepts a Tatar card and rejects a Russian sentence in exampleTt's place", () => {
    expect(WordCardSchema.safeParse({ input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." }).success).toBe(true);
    expect(WordCardSchema.safeParse({ input: "әни", lang: "tt", word: "әни", pos: "n", translation: "әни", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." }).success).toBe(false);
    expect(WordCardSchema.safeParse({ input: "әни", lang: "tt", word: "əни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." }).success).toBe(false);
    // The model copied the Russian sentence into the Tatar example.
    expect(WordCardSchema.safeParse({ input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Мама дома.", exampleRu: "Мама дома." }).success).toBe(false);
    expect(ok({ exampleTt: " мама дома. ", exampleRu: "Мама дома." })).toBe(false);
  });

  it("returns the card with trimmed texts and nothing but the seven fields", () => {
    const r = WordCardSchema.parse({ ...ANI, input: " эни ", word: " әни ", translation: " мама ", exampleTt: " Әни өйдә. ", exampleRu: " Мама дома. ", transcription: "x", extra: 1 });
    expect(r).toEqual({ input: "эни", lang: "tt", word: "әни", pos: "n", translation: "мама", exampleTt: "Әни өйдә.", exampleRu: "Мама дома." });
    expect(WordCardSchema.parse({ ...ANI, input: "мама", lang: "ru" }).lang).toBe("ru");
  });

  it("wants Russian in translation and exampleRu: Cyrillic, and none of the Tatar letters", () => {
    for (const letter of "әөүҗңһӘӨҮҖҢҺ") {
      expect(ok({ translation: `мама${letter}` }), `translation with ${letter}`).toBe(false);
      expect(ok({ exampleRu: `Мама дома${letter}.` }), `exampleRu with ${letter}`).toBe(false);
    }
    expect(ok({ translation: "mother" })).toBe(false);
    expect(ok({ exampleRu: "Mother is at home." })).toBe(false);
    expect(ok({ translation: "" })).toBe(false);
    expect(ok({ exampleRu: "  " })).toBe(false);
    expect(ok({ translation: "мама, мать (разг.)" })).toBe(true);
  });

  it("wants Tatar Cyrillic in word and exampleTt: no look-alikes, no stress marks, not empty", () => {
    expect(ok({ exampleTt: "əни өйдә." })).toBe(false);   // Latin schwa
    expect(ok({ exampleTt: "Әни өйдə." })).toBe(false);
    expect(ok({ word: "hава" })).toBe(false);                  // Latin h
    expect(ok({ word: "қала" })).toBe(false);             // Kazakh қ
    expect(ok({ word: "әни́" })).toBe(false);
    expect(ok({ word: "" })).toBe(false);
    expect(ok({ word: "   " })).toBe(false);
    expect(ok({ word: "123" })).toBe(false);
    expect(ok({ exampleTt: "" })).toBe(false);
    expect(ok({ exampleTt: "..." })).toBe(false);
    expect(ok({ word: "хәерле иртә", pos: "phr", exampleTt: "Хәерле иртә, әни!" })).toBe(true);
  });

  it("wants the echoed input and the language of the line", () => {
    expect(ok({ input: "" })).toBe(false);
    expect(ok({ input: undefined })).toBe(false);
    expect(ok({ lang: "en" })).toBe(false);
    expect(ok({ lang: undefined })).toBe(false);
  });

  it("empties a part of speech that is not one of the codes", () => {
    const pos = (v: unknown) => WordCardSchema.parse({ ...ANI, pos: v }).pos;
    for (const code of ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"]) expect(pos(code)).toBe(code);
    expect(pos(" N ")).toBe("n");
    for (const other of ["noun", "сущ.", "", "constructor", "toString", null, undefined, 7, {}]) expect(pos(other), String(other)).toBe("");
  });
});

describe("completeCards", () => {
  it("drops the invalid cards and keeps the valid ones", async () => {
    const f = llmReturning([card("матур", "красивый"), { ...card("сәер", "странный"), exampleRu: "Бу сәер." }, "junk", null, card("яшел", "зелёный")]);
    expect((await completeCards(client(f), "s", "u")).map((c) => c.word)).toEqual(["матур", "яшел"]);
  });
  it("is unavailable when no card is valid", async () => {
    await expect(completeCards(client(llmReturning([{ ...card("матур"), translation: "nice" }])), "s", "u")).rejects.toBeInstanceOf(LlmUnavailable);
    await expect(completeCards(client(llmReturning([])), "s", "u")).rejects.toBeInstanceOf(LlmUnavailable);
  });
});

describe("system prompts", () => {
  const FIELDS = ["input", "lang", "word", "pos", "translation", "exampleTt", "exampleRu"];
  it.each([["WORDS_SYSTEM", WORDS_SYSTEM], ["DECK_SYSTEM", DECK_SYSTEM]])("%s names every field, the pos codes and the six Tatar letters", (_name, prompt) => {
    for (const f of FIELDS) expect(prompt).toContain(`"${f}"`);
    expect(prompt).toContain("n, v, adj, adv, pron, num, post, conj, part, intj, phr");
    for (const letter of "әөүҗңһ") expect(prompt).toContain(letter);
    expect(prompt).toContain("JSON");
    expect(prompt).not.toContain("transcription\"");
  });
  it("WORDS_SYSTEM asks for the language, the restored spelling, the -у/-ү verb form and the input word for word", () => {
    expect(WORDS_SYSTEM).toMatch(/"ru"/);
    expect(WORDS_SYSTEM).toMatch(/"tt"/);
    expect(WORDS_SYSTEM).toMatch(/restor/i);
    expect(WORDS_SYSTEM).toContain("-у/-ү");
    expect(WORDS_SYSTEM).toMatch(/exactly as/i);
  });
  it("DECK_SYSTEM asks for a themed deck of Tatar words for Russian speakers", () => {
    expect(DECK_SYSTEM).toMatch(/topic/i);
    expect(DECK_SYSTEM).toMatch(/Tatar/);
    expect(DECK_SYSTEM).toMatch(/Russian speakers/);
    expect(DECK_SYSTEM).toContain("-у/-ү");
  });
  it("writes its Tatar samples with real Tatar letters", () => {
    // Every Cyrillic word of the prompts is a Tatar or Russian sample; a look-alike from another alphabet would fail here.
    for (const prompt of [WORDS_SYSTEM, DECK_SYSTEM]) for (const w of prompt.match(/[Ѐ-ӿ]+/g) ?? []) expect(isTatarText(w), w).toBe(true);
  });
});
