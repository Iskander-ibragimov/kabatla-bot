import { LlmClient, type LlmProvider } from "../../src/content/llm";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** An OpenAI-style chat answer whose message is `content`. */
export const chat = (content: string) => json({ choices: [{ message: { content } }] });
export const provider = (baseUrl: string): LlmProvider => ({ baseUrl, apiKey: "k", model: "m" });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** A fetch that answers from `h` and remembers the URLs and request bodies it was called with. */
export type FakeFetch = typeof fetch & { urls: string[]; bodies: string[] };
export function fakeFetch(h: Handler): FakeFetch {
  const urls: string[] = [], bodies: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    urls.push(u);
    bodies.push(String(init?.body ?? ""));
    return h(u, init);
  }) as FakeFetch;
  f.urls = urls;
  f.bodies = bodies;
  return f;
}

/** What the model is asked to return for one line of the user's message. */
export interface LlmCard { input: string; lang: "tt" | "ru"; word: string; pos: string; translation: string; exampleTt: string; exampleRu: string }
/** A valid card: the model echoes `input` and answers with `word` (the input itself unless given). */
export const card = (input: string, translation = "перевод", word = input): LlmCard =>
  ({ input, lang: "tt", word, pos: "adj", translation, exampleTt: `Бу ${word}.`, exampleRu: `Это ${translation}.` });

/** A model that answers every request with these cards. */
export const llmReturning = (cards: unknown[]): FakeFetch => fakeFetch(() => chat(JSON.stringify({ cards })));
/** A model that is down: every request ends with HTTP 500. */
export const failingLlm = (): FakeFetch => fakeFetch(() => json({}, 500));
export const client = (f: typeof fetch, ...urls: string[]) => new LlmClient((urls.length ? urls : ["https://llm/v1"]).map(provider), f);
/** The user message of the request number `i`, as the model received it. */
export const userPrompt = (f: FakeFetch, i = 0): string =>
  (JSON.parse(f.bodies[i]!) as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "user")!.content;
