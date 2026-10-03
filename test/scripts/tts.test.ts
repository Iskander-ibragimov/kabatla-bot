import { describe, expect, it } from "vitest";
import { apiTts, sendVoice, speakable, TtsError } from "../../scripts/lib/tts-api";

describe("tts-api", () => {
  it("decodes wav_base64", async () => {
    const f = async () => Response.json({ wav_base64: btoa("RIFFxxxx"), sample_rate: 22050 });
    expect(new TextDecoder().decode(await apiTts("alsu", { fetch: f as never, sleep: async () => {} }).synth("сәлам"))).toBe("RIFFxxxx");
  });

  it("requests the listening endpoint with speaker and encoded text", async () => {
    let url = "";
    const f = async (u: string) => { url = u; return Response.json({ wav_base64: "", sample_rate: 22050 }); };
    await apiTts("almaz", { fetch: f as never, sleep: async () => {} }).synth("сәлам дус");
    expect(url).toBe(`https://tat-tts.api.translate.tatar/listening/?speaker=almaz&text=${encodeURIComponent("сәлам дус")}`);
  });

  it("waits at least 1000 ms between requests", async () => {
    let t = 0; const slept: number[] = [];
    const tts = apiTts("almaz", { fetch: (async () => Response.json({ wav_base64: "", sample_rate: 22050 })) as never, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await tts.synth("бер"); t += 300; await tts.synth("ике");
    expect(slept).toEqual([700]);
  });

  it("throws TtsError on HTTP 500 and on unspeakable text without calling fetch", async () => {
    let calls = 0;
    const tts = apiTts("alsu", { fetch: (async () => { calls++; return new Response("", { status: 500 }); }) as never, sleep: async () => {} });
    await expect(tts.synth("сәлам")).rejects.toBeInstanceOf(TtsError);
    await expect(tts.synth("🙂")).rejects.toBeInstanceOf(TtsError);
    await expect(tts.synth("а".repeat(81))).rejects.toBeInstanceOf(TtsError);
    expect(calls).toBe(1);
  });

  it("throws TtsError when the body has no wav_base64", async () => {
    const tts = apiTts("alsu", { fetch: (async () => Response.json({ error: "x" })) as never, sleep: async () => {} });
    await expect(tts.synth("сәлам")).rejects.toBeInstanceOf(TtsError);
  });

  it("speakable accepts 1..80 chars with a Cyrillic letter", () => {
    expect(speakable("сәлам")).toBe(true);
    expect(speakable("а".repeat(80))).toBe(true);
    expect(speakable("")).toBe(false);
    expect(speakable("hello")).toBe(false);
    expect(speakable("123")).toBe(false);
  });

  it("sendVoice returns voice.file_id", async () => {
    const f = async () => Response.json({ ok: true, result: { voice: { file_id: "AwACAg" } } });
    expect(await sendVoice({ token: "1:x", chatId: "5", ogg: new Uint8Array(1), fetch: f as never })).toBe("AwACAg");
  });

  it("sendVoice posts multipart with caption and throws TtsError on a Telegram error without leaking the token", async () => {
    let body: FormData | undefined; let url = "";
    const ok = async (u: string, init: { body: FormData }) => { url = u; body = init.body; return Response.json({ ok: true, result: { voice: { file_id: "F" } } }); };
    await sendVoice({ token: "1:secret", chatId: "5", ogg: new Uint8Array(1), caption: "сәлам · alsu", fetch: ok as never });
    expect(url).toBe("https://api.telegram.org/bot1:secret/sendVoice");
    expect(body?.get("chat_id")).toBe("5");
    expect(body?.get("caption")).toBe("сәлам · alsu");
    expect(body?.get("disable_notification")).toBe("true");
    const bad = async () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation" }, { status: 403 });
    const err = await sendVoice({ token: "1:secret", chatId: "5", ogg: new Uint8Array(1), fetch: bad as never }).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect(String(err.message)).toContain("Forbidden");
    expect(String(err.message)).not.toContain("secret");
  });
});
