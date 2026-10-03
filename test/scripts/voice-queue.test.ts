import { describe, expect, it } from "vitest";
import { TtsError } from "../../scripts/lib/tts-api";
import { catalogText, resultSql, voiceBatch } from "../../scripts/lib/voice-queue";

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
  it("stops after N failures in a row and leaves the rest unattempted", async () => {
    let calls = 0;
    const r = await voiceBatch([1, 2, 3, 4, 5, 6].map((id) => ({ id, word: "сүз" })), {
      tts: { synth: async () => { calls++; throw new TtsError("tts api HTTP 500"); } }, ...ok, stopAfterFailures: 3,
    });
    expect(calls).toBe(3);
    expect(r.failed).toEqual([1, 2, 3]);
    expect(r.stopped).toBe(true);
  });

  it("a success resets the streak", async () => {
    let n = 0;
    const r = await voiceBatch([1, 2, 3, 4, 5].map((id) => ({ id, word: "сүз" })), {
      tts: { synth: async () => { if (++n % 2 === 1) throw new TtsError("500"); return new Uint8Array(1); } }, ...ok, stopAfterFailures: 2,
    });
    expect(r.done.map((d) => d.id)).toEqual([2, 4]);
    expect(r.failed).toEqual([1, 3, 5]);
    expect(r.stopped).toBe(false);
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

describe("catalogText", () => {
  it("drops a trailing ellipsis and surrounding spaces but keeps other punctuation", () => {
    expect(catalogText("Минем исемем …")).toBe("Минем исемем");
    expect(catalogText("Минем исемем...")).toBe("Минем исемем");
    expect(catalogText("  Хәлләр ничек? ")).toBe("Хәлләр ничек?");
    expect(catalogText("Исәнмесез!")).toBe("Исәнмесез!");
  });
});
