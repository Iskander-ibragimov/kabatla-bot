/** Voicing a queue of words: synthesize, convert, upload, and the SQL that records the outcome. Pure: no Node modules (tested in the Workers runtime). */
import { speakable, type Tts } from "./tts-api";

export interface VoiceItem { id: number; word: string }
export interface VoiceDeps {
  tts: Tts;
  toOgg(wav: Uint8Array): Promise<Uint8Array>;
  /** Uploads the voice message and returns its Telegram file_id. */
  send(ogg: Uint8Array, caption: string): Promise<string>;
  /** Give up on the rest of the queue after this many failures in a row (a broken token or chat, a dead API). The rest stays untouched. */
  stopAfterFailures?: number;
}
export interface VoiceResult {
  done: { id: number; fileId: string }[];
  failed: number[];
  /** First error message per failure kind (unspeakable, tts, ogg, send, file_id). Never contains the word. */
  errors?: Record<string, string>;
  /** True when the queue was cut short by `stopAfterFailures`; the unattempted items are in neither list. */
  stopped?: boolean;
}

const FILE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ERROR = 300;

/** What the speech API is given for a catalog word: no trailing ellipsis (a template gap), no outer spaces; other punctuation stays. */
export function catalogText(word: string): string {
  return word.replace(/\s*(…|\.{3})\s*$/u, "").trim();
}

/** One word failing never stops the rest. */
export async function voiceBatch(items: VoiceItem[], deps: VoiceDeps): Promise<VoiceResult> {
  const done: VoiceResult["done"] = [];
  const failed: number[] = [];
  const errors: Record<string, string> = {};
  let streak = 0;
  let stopped = false;
  const fail = (id: number, kind: string, message: string): void => {
    failed.push(id);
    streak++;
    errors[kind] ??= message.slice(0, MAX_ERROR);
  };
  for (const { id, word } of items) {
    if (deps.stopAfterFailures !== undefined && streak >= deps.stopAfterFailures) {
      stopped = true;
      break;
    }
    if (!speakable(word)) {
      fail(id, "unspeakable", "text is not speakable");
      continue;
    }
    let stage = "tts";
    try {
      const wav = await deps.tts.synth(word);
      stage = "ogg";
      const ogg = await deps.toOgg(wav);
      stage = "send";
      const fileId = await deps.send(ogg, word);
      if (!FILE_ID.test(fileId)) {
        fail(id, "file_id", "Telegram returned a file_id with unexpected characters");
        continue;
      }
      done.push({ id, fileId });
      streak = 0;
    } catch (e) {
      fail(id, stage, e instanceof Error ? e.message : String(e));
    }
  }
  return { done, failed, errors, stopped };
}

/** SQL recording a result. Built only from integer ids and file ids matching /^[A-Za-z0-9_-]+$/; anything else counts as a failed try. */
export function resultSql(r: Pick<VoiceResult, "done" | "failed">): string {
  const lines: string[] = [];
  const tries = (id: number): void => {
    if (Number.isSafeInteger(id) && id >= 0) lines.push(`UPDATE notes SET audio_tries = audio_tries + 1 WHERE id = ${id};`);
  };
  for (const { id, fileId } of r.done) {
    if (Number.isSafeInteger(id) && id >= 0 && FILE_ID.test(fileId)) lines.push(`UPDATE notes SET audio_file_id = '${fileId}' WHERE id = ${id} AND audio_file_id IS NULL;`);
    else tries(id);
  }
  for (const id of r.failed) tries(id);
  return lines.join("\n");
}
