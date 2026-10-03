/** Voicing a queue of words: synthesize, convert, upload, and the SQL that records the outcome. Pure: no Node modules (tested in the Workers runtime). */
import { speakable, type Tts } from "./tts-api";

export interface VoiceItem { id: number; word: string }
/** What one flush hands to `persist`: outcomes settled since the previous flush. */
export interface Settled { done: { id: number; fileId: string }[]; failed: number[] }
export interface VoiceDeps {
  tts: Tts;
  toOgg(wav: Uint8Array): Promise<Uint8Array>;
  /** Uploads the voice message and returns its Telegram file_id. May throw `StopRun` to end the run cleanly. */
  send(ogg: Uint8Array, caption: string): Promise<string>;
  /** Give up on the rest of the queue after this many tts/ogg/send failures in a row (a broken token or chat, a dead API). */
  stopAfterFailures?: number;
  /** Saves settled outcomes: every `FLUSH_EVERY` items, when the run stops, and at the end. */
  persist?(settled: Settled): Promise<void>;
}
export interface VoiceResult extends Settled {
  /** First error message per failure kind (unspeakable, tts, ogg, send, file_id). Never contains the word. */
  errors?: Record<string, string>;
  /** "failures": the breaker tripped; "flood": `send` asked to stop (Telegram wants a long wait). Unattempted items are in no list. */
  stopped?: "failures" | "flood";
  /** Failed in a trailing streak of a run that stopped: no verdict on the word itself, so no try is burned. */
  unsettled?: number[];
}

/** Thrown by `send` to end the run cleanly: the item is not counted as failed. */
export class StopRun extends Error {}

export const FLUSH_EVERY = 20;
const FILE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_ERROR = 300;

/** What the speech API is given and what the caption says: no trailing ellipsis (a template gap), no outer spaces; other punctuation stays. */
export function speechText(word: string): string {
  return word.replace(/\s*(…|\.{3})\s*$/u, "").trim();
}

/**
 * One word failing never stops the rest.
 * - Words that can never be voiced (not speakable, a malformed file_id) fail at once and never count toward the breaker.
 * - tts/ogg/send failures are held back until a later success proves they were isolated; a trailing streak of them
 *   in a stopped run stays `unsettled` (an outage says nothing about those words).
 */
export async function voiceBatch(items: VoiceItem[], deps: VoiceDeps): Promise<VoiceResult> {
  const done: VoiceResult["done"] = [];
  const failed: number[] = [];
  const errors: Record<string, string> = {};
  let held: number[] = [];
  let stopped: VoiceResult["stopped"];
  let streak = 0;
  let doneFlushed = 0, failedFlushed = 0, since = 0;
  const note = (kind: string, message: string): void => {
    errors[kind] ??= message.slice(0, MAX_ERROR);
  };
  const flush = async (): Promise<void> => {
    since = 0;
    const delta = { done: done.slice(doneFlushed), failed: failed.slice(failedFlushed) };
    doneFlushed = done.length;
    failedFlushed = failed.length;
    if (deps.persist && (delta.done.length > 0 || delta.failed.length > 0)) await deps.persist(delta);
  };

  for (const { id, word } of items) {
    if (deps.stopAfterFailures !== undefined && streak >= deps.stopAfterFailures) {
      stopped = "failures";
      break;
    }
    const text = speechText(word);
    if (!speakable(text)) {
      failed.push(id);
      note("unspeakable", "text is not speakable");
    } else {
      let stage = "tts";
      try {
        const wav = await deps.tts.synth(text);
        stage = "ogg";
        const ogg = await deps.toOgg(wav);
        stage = "send";
        const fileId = await deps.send(ogg, text);
        if (FILE_ID.test(fileId)) {
          done.push({ id, fileId });
          streak = 0;
          failed.push(...held);
          held = [];
        } else {
          failed.push(id);
          note("file_id", "Telegram returned a file_id with unexpected characters");
        }
      } catch (e) {
        if (e instanceof StopRun) {
          stopped = "flood";
          note("flood", e.message);
          break;
        }
        held.push(id);
        streak++;
        note(stage, e instanceof Error ? e.message : String(e));
      }
    }
    if (++since >= FLUSH_EVERY) await flush();
  }

  let unsettled: number[] = [];
  if (stopped) unsettled = held;
  else failed.push(...held);
  await flush();
  return { done, failed: [...failed].sort((a, b) => a - b), errors, stopped, unsettled };
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
