import { describe, expect, it } from "vitest";
import { TtsError } from "../../scripts/lib/tts-api";
import { resultSql, speechText, StopRun, voiceBatch, type VoiceResult } from "../../scripts/lib/voice-queue";

const ok = { toOgg: async (w: Uint8Array) => w, send: async (_o: Uint8Array, c: string) => `F_${c.length}` };

describe("voiceBatch", () => {
  it("voices what it can and reports the rest as failed", async () => {
    const tts = { synth: async (t: string) => { if (t === "сбой") throw new TtsError("500"); return new Uint8Array(1); } };
    const r = await voiceBatch(
      [{ id: 1, word: "сәлам" }, { id: 2, word: "сбой" }, { id: 3, word: "🙂" }, { id: 4, word: "x".repeat(300) }, { id: 5, word: "рәхмәт" }],
      { tts, ...ok });
    expect(r.done.map((d) => d.id)).toEqual([1, 5]);
    expect(r.failed).toEqual([2, 3, 4]);
  });

  it("sends the word as the caption and keeps going when conversion or upload fails", async () => {
    const captions: string[] = [];
    let conversions = 0;
    const r = await voiceBatch([{ id: 1, word: "бер" }, { id: 2, word: "ике" }, { id: 3, word: "өч" }, { id: 4, word: "дүрт" }], {
      tts: { synth: async () => new Uint8Array(1) },
      toOgg: async (w) => { if (++conversions === 2) throw new Error("ffmpeg died"); return w; },
      send: async (_o, c) => { captions.push(c); if (c === "өч") throw new TtsError("sendVoice failed: HTTP 429"); return `ID_${captions.length}`; },
    });
    expect(captions).toEqual(["бер", "өч", "дүрт"]);
    expect(r.done.map((d) => d.id)).toEqual([1, 4]);
    expect(r.failed).toEqual([2, 3]);
  });

  it("turns a file id that is unsafe for SQL into a failure", async () => {
    const r = await voiceBatch([{ id: 1, word: "бер" }, { id: 2, word: "ике" }], {
      tts: { synth: async () => new Uint8Array(1) }, toOgg: async (w) => w,
      send: async (_o, c) => (c === "бер" ? "a'; DROP TABLE notes;--" : "AwACAg_x-1"),
    });
    expect(r.done).toEqual([{ id: 2, fileId: "AwACAg_x-1" }]);
    expect(r.failed).toEqual([1]);
  });

  it("collects the first error message per kind without echoing the word", async () => {
    const r = await voiceBatch([{ id: 1, word: "секрет" }, { id: 2, word: "🙂 секрет" }, { id: 3, word: "!!!" }], {
      tts: { synth: async () => { throw new TtsError("tts api HTTP 500"); } }, ...ok,
    });
    expect(r.failed).toEqual([1, 2, 3]);
    expect(r.errors).toEqual({ tts: "tts api HTTP 500", unspeakable: "text is not speakable" });
    expect(JSON.stringify(r)).not.toContain("секрет");
  });
});

describe("voiceBatch circuit breaker", () => {
  const fine = { synth: async () => new Uint8Array(1) };

  it("stops after N failures in a row; the unattempted rest and the trailing failures stay unsettled", async () => {
    let calls = 0;
    const r = await voiceBatch([1, 2, 3, 4, 5, 6].map((id) => ({ id, word: "сүз" })), {
      tts: { synth: async () => { calls++; throw new TtsError("tts api HTTP 500"); } }, ...ok, stopAfterFailures: 3,
    });
    expect(calls).toBe(3);
    expect(r.stopped).toBe("failures");
    expect(r.failed).toEqual([]);
    expect(r.unsettled).toEqual([1, 2, 3]);
  });

  it("a systemic stop still returns what was done, and flushes it", async () => {
    const flushed: VoiceResult["done"][] = [];
    let n = 0;
    const r = await voiceBatch([1, 2, 3, 4, 5, 6].map((id) => ({ id, word: "сүз" })), {
      tts: { synth: async () => { if (++n > 2) throw new TtsError("500"); return new Uint8Array(1); } }, ...ok, stopAfterFailures: 2,
      persist: async (d) => { flushed.push(d.done); },
    });
    expect(r.done.map((d) => d.id)).toEqual([1, 2]);
    expect(r.stopped).toBe("failures");
    expect(flushed.flat().map((d) => d.id)).toEqual([1, 2]);
  });

  it("a success resets the streak and settles the failures before it", async () => {
    let n = 0;
    const r = await voiceBatch([1, 2, 3, 4, 5].map((id) => ({ id, word: "сүз" })), {
      tts: { synth: async () => { if (++n % 2 === 1) throw new TtsError("500"); return new Uint8Array(1); } }, ...ok, stopAfterFailures: 2,
    });
    expect(r.done.map((d) => d.id)).toEqual([2, 4]);
    expect(r.failed).toEqual([1, 3, 5]);
    expect(r.stopped).toBeUndefined();
  });

  it("unspeakable words never trip the breaker and always burn their try", async () => {
    const items = [...Array.from({ length: 10 }, (_, i) => ({ id: i + 1, word: "🙂" })), { id: 11, word: "сәлам" }];
    const r = await voiceBatch(items, { tts: fine, ...ok, stopAfterFailures: 3 });
    expect(r.done.map((d) => d.id)).toEqual([11]);
    expect(r.failed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.stopped).toBeUndefined();
  });

  it("unspeakable words do not hide a real outage and are still burned when the run stops", async () => {
    const items = [{ id: 1, word: "🙂" }, ...[2, 3, 4, 5].map((id) => ({ id, word: "сүз" }))];
    const r = await voiceBatch(items, { tts: { synth: async () => { throw new TtsError("500"); } }, ...ok, stopAfterFailures: 2 });
    expect(r.stopped).toBe("failures");
    expect(r.failed).toEqual([1]);
    expect(r.unsettled).toEqual([2, 3]);
  });

  it("a file id rejected by the format check does not count toward the breaker", async () => {
    const r = await voiceBatch([1, 2, 3, 4].map((id) => ({ id, word: "сүз" })), { tts: fine, toOgg: async (w) => w, send: async () => "bad id!", stopAfterFailures: 2 });
    expect(r.failed).toEqual([1, 2, 3, 4]);
    expect(r.stopped).toBeUndefined();
  });

  it("StopRun from send ends the run cleanly without burning the word", async () => {
    const r = await voiceBatch([1, 2, 3].map((id) => ({ id, word: "сүз" })), {
      tts: fine, toOgg: async (w) => w,
      send: async () => { throw new StopRun("Telegram asks to wait 400 s"); },
    });
    expect(r.stopped).toBe("flood");
    expect(r.failed).toEqual([]);
    expect(r.done).toEqual([]);
    expect(r.unsettled).toEqual([]);
  });
});

describe("voiceBatch persistence", () => {
  it("calls persist every 20 items and once at the end with the rest", async () => {
    const calls: { done: number; failed: number }[] = [];
    const items = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, word: i === 3 ? "🙂" : "сүз" }));
    const r = await voiceBatch(items, {
      tts: { synth: async () => new Uint8Array(1) }, ...ok,
      persist: async (d) => { calls.push({ done: d.done.length, failed: d.failed.length }); },
    });
    expect(calls).toEqual([{ done: 19, failed: 1 }, { done: 20, failed: 0 }, { done: 5, failed: 0 }]);
    expect(r.done).toHaveLength(44);
  });

  it("does not call persist for an empty queue", async () => {
    let called = 0;
    await voiceBatch([], { tts: { synth: async () => new Uint8Array(1) }, ...ok, persist: async () => { called++; } });
    expect(called).toBe(0);
  });
});

describe("resultSql", () => {
  it("builds SQL only from numeric ids and safe file ids", () => {
    const sql = resultSql({ done: [{ id: 1, fileId: "AwACAg_x-1" }, { id: 2, fileId: "a'; DROP TABLE notes;--" }], failed: [3] });
    expect(sql).toContain("UPDATE notes SET audio_file_id = 'AwACAg_x-1' WHERE id = 1 AND audio_file_id IS NULL;");
    expect(sql).not.toContain("DROP");
    expect(sql).toContain("audio_tries = audio_tries + 1 WHERE id = 2;");
    expect(sql).toContain("audio_tries = audio_tries + 1 WHERE id = 3;");
  });

  it("refuses ids that are not integers and is empty for an empty result", () => {
    expect(resultSql({ done: [], failed: [] })).toBe("");
    const sql = resultSql({ done: [{ id: 1.5, fileId: "AB" }, { id: Number.NaN, fileId: "AB" }], failed: [2, -1, 7.2] });
    expect(sql).not.toMatch(/1\.5|NaN|-1|7\.2/);
    expect(sql).toContain("WHERE id = 2;");
  });
});

describe("speechText", () => {
  it("drops a trailing ellipsis and surrounding spaces but keeps other punctuation", () => {
    expect(speechText("Минем исемем …")).toBe("Минем исемем");
    expect(speechText("Минем исемем...")).toBe("Минем исемем");
    expect(speechText("  Хәлләр ничек? ")).toBe("Хәлләр ничек?");
    expect(speechText("Исәнмесез!")).toBe("Исәнмесез!");
    expect(speechText("бер … ике")).toBe("бер … ике");
  });

  it("is what the speech API receives and what the caption says", async () => {
    const seen: string[] = []; const captions: string[] = [];
    await voiceBatch([{ id: 1, word: "Минем исемем …" }], {
      tts: { synth: async (t) => { seen.push(t); return new Uint8Array(1); } }, toOgg: async (w) => w,
      send: async (_o, c) => { captions.push(c); return "OK"; },
    });
    expect(seen).toEqual(["Минем исемем"]);
    expect(captions).toEqual(["Минем исемем"]);
  });
});
