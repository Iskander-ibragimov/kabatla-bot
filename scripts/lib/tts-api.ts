/** Text-to-speech helpers shared by the voice scripts. No Node modules here: this file is tested in the Workers runtime. */

export interface Tts {
  /** Returns a WAV file. */
  synth(text: string): Promise<Uint8Array>;
}

export class TtsError extends Error {}

const API = "https://tat-tts.api.translate.tatar/listening/";
const MIN_GAP_MS = 1000;
const MAX_CHARS = 80;

/** 1..80 characters with at least one Cyrillic letter. */
export function speakable(text: string): boolean {
  return text.length >= 1 && text.length <= MAX_CHARS && /\p{Script=Cyrillic}/u.test(text);
}

export interface ApiTtsDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function apiTts(speaker: "alsu" | "almaz", deps: ApiTtsDeps = {}): Tts {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let lastRequestAt: number | undefined;

  return {
    async synth(text) {
      if (!speakable(text)) throw new TtsError(`text is not speakable: ${JSON.stringify(text.slice(0, 40))}`);
      if (lastRequestAt !== undefined) {
        const wait = MIN_GAP_MS - (now() - lastRequestAt);
        if (wait > 0) await sleep(wait);
      }
      lastRequestAt = now();
      let res: Response;
      try {
        res = await doFetch(`${API}?speaker=${speaker}&text=${encodeURIComponent(text)}`);
      } catch (e) {
        throw new TtsError(`tts api request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new TtsError(`tts api HTTP ${res.status}`);
      let body: { wav_base64?: unknown };
      try {
        body = (await res.json()) as { wav_base64?: unknown };
      } catch {
        throw new TtsError("tts api returned a non-JSON body");
      }
      if (typeof body.wav_base64 !== "string") throw new TtsError("tts api response has no wav_base64");
      const bin = atob(body.wav_base64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
  };
}

export interface SendVoiceOptions {
  token: string;
  chatId: string;
  ogg: Uint8Array;
  caption?: string;
  fetch?: typeof fetch;
}

/** Uploads an OGG/Opus voice message to Telegram silently and returns its file_id. The token never appears in errors. */
export async function sendVoice(o: SendVoiceOptions): Promise<string> {
  const form = new FormData();
  form.set("chat_id", o.chatId);
  form.set("disable_notification", "true");
  if (o.caption !== undefined) form.set("caption", o.caption);
  form.set("voice", new Blob([o.ogg as Uint8Array<ArrayBuffer>], { type: "audio/ogg" }), "voice.ogg");
  const res = await (o.fetch ?? fetch)(`https://api.telegram.org/bot${o.token}/sendVoice`, { method: "POST", body: form });
  let body: { ok?: boolean; description?: string; result?: { voice?: { file_id?: string } } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // fall through to the generic error below
  }
  const fileId = body.result?.voice?.file_id;
  if (!res.ok || !body.ok || !fileId) throw new TtsError(`sendVoice failed: HTTP ${res.status} ${body.description ?? "no file_id in response"}`);
  return fileId;
}
