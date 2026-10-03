import { z } from "zod";
import { hasTatarLetters, isTatarText } from "./tatar";

export const ProviderSchema = z.object({ baseUrl: z.string().url(), apiKey: z.string(), model: z.string().min(1) });
export type LlmProvider = z.infer<typeof ProviderSchema>;

/** Part-of-speech codes of the catalog. */
export const POS_CODES = ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"] as const;

/** A card as the model returns it: `input` echoes the user's line, `word` is the Tatar word the card is about. */
export interface WordCard { input: string; lang: "tt" | "ru"; word: string; pos: string; translation: string; exampleTt: string; exampleRu: string }

/**
 * The longest a card field may be, in characters. A card is one Telegram message of at most 4 096 characters, and a
 * preview shows up to 30 cards in one; a model caught in a repetition loop must not get into either.
 */
export const MAX = { input: 200, word: 80, translation: 200, example: 300 } as const;
/** Cap on the model's answer. By a rough estimate a deck of 30 cards needs about 3 000 tokens; a runaway answer is cut here and fails as invalid JSON. */
const MAX_TOKENS = 4000;

const RUSSIAN_LETTER = /[А-Яа-яЁё]/;
const CYRILLIC_LETTER = /[\u0400-\u04FF]/;
/** Every character that starts a new line. A card field is one line: it stands inside a line of a list. */
const LINE_BREAK = /[\n\r\u000B\u000C\u0085\u2028\u2029]/;
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !LINE_BREAK.test(s), "must be one line");
/** Russian text: has Cyrillic letters and none of ә ө ү җ ң һ. */
const russian = (max: number) => oneLine(max).refine((s) => RUSSIAN_LETTER.test(s) && !hasTatarLetters(s), "must be Russian");
/** Tatar text: letters of the Tatar Cyrillic alphabet only, so that no look-alike of another alphabet gets into a card. */
const tatar = (max: number) => oneLine(max).refine((s) => isTatarText(s) && CYRILLIC_LETTER.test(s), "must be Tatar Cyrillic");
/** A code of POS_CODES, or "" for anything else. */
const pos = z.unknown().transform((v) => {
  const code = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (POS_CODES as readonly string[]).includes(code) ? code : "";
});

export const WordCardSchema: z.ZodType<WordCard> = z.object({
  input: oneLine(MAX.input),
  lang: z.enum(["tt", "ru"]),
  word: tatar(MAX.word),
  pos,
  translation: russian(MAX.translation),
  exampleTt: tatar(MAX.example),
  exampleRu: russian(MAX.example),
}).refine((c) => c.exampleTt.toLowerCase() !== c.exampleRu.toLowerCase(), "exampleTt repeats exampleRu");

export class LlmUnavailable extends Error {}

/** OpenAI-compatible chat client that tries providers in order until one returns valid JSON. */
export class LlmClient {
  constructor(private readonly providers: LlmProvider[], private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 20_000) {}

  /** Tries providers in order; `deadline` (epoch ms) caps the whole call, not just one provider. */
  async completeJson<T extends z.ZodTypeAny>(system: string, user: string, schema: T, deadline = Date.now() + 60_000): Promise<z.infer<T>> {
    const errors: string[] = [];
    for (const p of this.providers) {
      const left = deadline - Date.now();
      if (left <= 200) { errors.push("deadline reached"); break; }
      try {
        const res = await this.fetcher(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({
            model: p.model, temperature: 0.2, max_tokens: MAX_TOKENS, response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content ?? "";
        const raw = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
        return schema.parse(JSON.parse(raw));
      } catch (e) {
        errors.push(`${p.baseUrl}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    throw new LlmUnavailable(errors.join("; ") || "no providers");
  }
}

const LooseCards = z.object({ cards: z.array(z.unknown()) }).refine((x) => x.cards.some((c) => WordCardSchema.safeParse(c).success), "no valid cards");

/** Word cards with per-card validation: invalid cards are dropped instead of failing the batch. */
export async function completeCards(llm: LlmClient, system: string, user: string, deadline?: number): Promise<WordCard[]> {
  const res = await llm.completeJson(system, user, LooseCards, deadline);
  return res.cards.flatMap((c) => { const r = WordCardSchema.safeParse(c); return r.success ? [r.data] : []; });
}

const CARDS_JSON = '{"cards":[{"input":"…","lang":"…","word":"…","pos":"…","translation":"…","exampleTt":"…","exampleRu":"…"}]}';
/** The fields both prompts describe in the same words. */
const CARD_FIELDS = [
  '"pos": one of ' + POS_CODES.join(", ") + " (phr for a phrase).",
  '"translation": a short Russian translation of "word", 1–3 variants separated by commas, in Russian only.',
  '"exampleTt": one short, natural, everyday Tatar sentence with the word, written with ә ө ү җ ң һ.',
  '"exampleRu": the Russian translation of that sentence.',
].join("\n");
const WORD_FORM =
  "Write it in standard literary Tatar spelling. A verb goes in the form ending in -у/-ү (бару, килү, эшләү), a noun in the nominative singular. " +
  "Lower case, except proper names.";
const SCRIPT_RULE =
  "Tatar text is written only in the Tatar Cyrillic alphabet: the Russian letters and ә ө ү җ ң һ. " +
  "Never use Latin letters or look-alike letters of other alphabets. Add no stress marks and no transcription.";

/** One card per line of the user's message; the message is `Lines:` and the lines. */
export const WORDS_SYSTEM = [
  "You make flashcards for Russian speakers who learn Tatar.",
  "The user message is a list of lines. Each line is one word or short phrase typed by a learner, in Tatar or in Russian. " +
    "Learners often have no Tatar keyboard and type Tatar words without the letters ә ө ү җ ң һ, with similar Russian letters in their place " +
    "(э, а or е for ә; о for ө; у for ү; ж for җ; н for ң; х for һ).",
  "",
  "Reply with JSON only, one card for each line, in the order of the lines:",
  CARDS_JSON,
  "",
  '"input": the line exactly as it was given, character for character.',
  '"lang": the language of the line, "tt" or "ru": "tt" for a Tatar word, also when it is typed without the Tatar letters; "ru" for a Russian word. ' +
    "If the line could be either, choose what a learner of Tatar more likely meant.",
  '"word": the Tatar word of the card. For "ru": the most common Tatar word for the Russian line. ' +
    'For "tt": the word of the line itself with its spelling restored, that is with ә ө ү җ ң һ put back where they belong; do not replace it with a synonym. ' +
    WORD_FORM,
  CARD_FIELDS,
  "",
  SCRIPT_RULE,
  "Skip a line only when it is not a word or phrase of either language.",
].join("\n");

/** A themed deck; the message is `Topic:` and `Number of cards:`. Same fields as WORDS_SYSTEM. */
export const DECK_SYSTEM = [
  "You make themed vocabulary decks of Tatar words for Russian speakers who learn Tatar.",
  "The user message gives a topic, in Russian or in Tatar, and the number of cards. Choose the most useful Tatar words and short phrases for the topic, " +
    "the most common first, with no repeats.",
  "",
  "Reply with JSON only:",
  CARDS_JSON,
  "",
  '"input": the same text as "word".',
  '"lang": always "tt".',
  '"word": a Tatar word or short phrase. ' + WORD_FORM,
  CARD_FIELDS,
  "",
  SCRIPT_RULE,
].join("\n");
