/**
 * Voice tooling (run only in GitHub Actions).
 *   tsx scripts/voice.ts sample            sends data/voice-sample.txt in 4 candidate voices to ADMIN_TG_ID
 *   tsx scripts/voice.ts db [--limit N]    voices every note without audio (catalog and own words) in the production D1 database,
 *                                          saving file_ids to D1 every 20 notes (N: 1..1000, default 200)
 * Env: BOT_TOKEN, ADMIN_TG_ID, AUDIO_CHAT_ID (optional: where voice messages go, default ADMIN_TG_ID),
 *      PIPER_MODELS_DIR (default "models"), REPORT_FILE (default "out/voice-run.md").
 * Voice messages are sent silently with the word as caption. The report never contains secrets, chat ids or Telegram
 * file_ids; `db` prints note ids only, never users' words (the words are private).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resultSql, StopRun, voiceBatch, type VoiceDeps, type VoiceResult } from "./lib/voice-queue";
import { apiTts, sendVoice, TtsError, type Tts } from "./lib/tts-api";
import { findPiperModels, piperTts, toOgg, type PiperModel } from "./lib/tts-local";

interface Voice { label: string; tts: Tts }
interface Tally { label: string; synthesized: number; sent: number; total: number; firstError?: string }

const REPORT_FILE = process.env.REPORT_FILE ?? "out/voice-run.md";
const MODELS_DIR = process.env.PIPER_MODELS_DIR ?? "models";

function pickPiper(models: PiperModel[]): { label: string; model: PiperModel }[] {
  const female = models.find((m) => m.gender === "female");
  const male = models.find((m) => m.gender === "male");
  if (female && male) return [{ label: "piper:female", model: female }, { label: "piper:male", model: male }];
  return models.slice(0, 2).map((m) => ({ label: `piper:${m.name.replace(/\.onnx$/, "")}`, model: m }));
}

function scrub(text: string, secrets: string[]): string {
  return secrets.filter((s) => s.length > 0).reduce((t, s) => t.split(s).join("***"), text);
}

function writeReport(lines: string[]): void {
  mkdirSync(dirname(REPORT_FILE), { recursive: true });
  writeFileSync(REPORT_FILE, `${lines.join("\n")}\n`);
}

async function telegramText(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new TtsError(`sendMessage failed: HTTP ${res.status}`);
}

async function sample(): Promise<void> {
  const token = process.env.BOT_TOKEN ?? "";
  const chatId = process.env.ADMIN_TG_ID ?? "";
  const missing = [token ? "" : "BOT_TOKEN", chatId ? "" : "ADMIN_TG_ID"].filter(Boolean);
  if (missing.length > 0) {
    writeReport(["## Sample run", "", `FAILED before sending: repository secret(s) empty or missing: ${missing.join(", ")}`]);
    throw new Error(`empty secret(s): ${missing.join(", ")}`);
  }
  const secrets = [token, chatId];
  const words = readFileSync("data/voice-sample.txt", "utf8").split("\n").map((w) => w.trim()).filter(Boolean);

  const voices: Voice[] = [
    { label: "api:alsu", tts: apiTts("alsu") },
    { label: "api:almaz", tts: apiTts("almaz") },
  ];
  const models = findPiperModels(MODELS_DIR);
  const picked = pickPiper(models);
  for (const p of picked) voices.push({ label: p.label, tts: piperTts(p.model.model, p.model.config) });

  const report: string[] = ["## Sample run", "", `Piper voices selected: ${picked.length === 0 ? "none" : picked.map((p) => `${p.label} <- ${p.model.name}${p.model.config ? "" : " (no config found)"}`).join("; ")}`, ""];
  const tallies: Tally[] = voices.map((v) => ({ label: v.label, synthesized: 0, sent: 0, total: words.length }));

  for (const word of words) {
    for (const [i, voice] of voices.entries()) {
      const tally = tallies[i]!;
      try {
        const ogg = await toOgg(await voice.tts.synth(word));
        tally.synthesized++;
        await sendVoice({ token, chatId, ogg, caption: `${word} · ${voice.label}` });
        tally.sent++;
      } catch (e) {
        tally.firstError ??= scrub(e instanceof Error ? e.message : String(e), secrets).slice(0, 400);
      }
    }
  }

  const delivered = tallies.filter((t) => t.sent > 0);
  const piperSilent = picked.length === 0 || tallies.some((t) => t.label.startsWith("piper:") && t.sent === 0);
  const summary = [
    `Проба голосов: ${delivered.length} из 4 голосов прислали записи (слов: ${words.length}).`,
    ...tallies.map((t) => `${t.label}: ${t.sent}/${t.total}`),
    ...(piperSilent ? [`Голоса Piper не дошли: пришли только ${delivered.length === 2 ? "два голоса" : `голосов: ${delivered.length}`} (${delivered.map((t) => t.label).join(", ") || "нет"}).`] : []),
  ].join("\n");

  report.push("| voice | synthesized | sent | total | first error |", "|---|---|---|---|---|");
  for (const t of tallies) report.push(`| ${t.label} | ${t.synthesized} | ${t.sent} | ${t.total} | ${t.firstError ? t.firstError.replace(/[|\n]/g, " ") : ""} |`);
  report.push("");
  try {
    await telegramText(token, chatId, summary);
    report.push("Summary message: sent.");
  } catch (e) {
    report.push(`Summary message: FAILED: ${scrub(e instanceof Error ? e.message : String(e), secrets)}`);
  }
  writeReport(report);
  if (delivered.length === 0) throw new Error("no voice delivered anything");
}

/** Consecutive failures after which a run gives up: the token, the chat or the speech API is broken, more tries only burn minutes. */
const STOP_AFTER_FAILURES = 10;
const MAX_FLOOD_WAIT_S = 60;

interface Setup { deps: VoiceDeps; secrets: string[] }

/** Provider and voice from data/voice.json, the bot token and the target chat; fails before doing any work. */
function setup(): Setup {
  const cfg = JSON.parse(readFileSync("data/voice.json", "utf8")) as { provider?: string; voice?: string };
  if (cfg.provider !== "api") {
    throw new Error(`voice provider "${cfg.provider}" is not supported: only "api" works (the Piper models do not). Set data/voice.json to {"provider":"api","voice":"alsu"}`);
  }
  if (cfg.voice !== "alsu" && cfg.voice !== "almaz") throw new Error(`data/voice.json: unknown api voice "${cfg.voice}" (alsu or almaz)`);
  const token = process.env.BOT_TOKEN ?? "";
  const chatId = process.env.AUDIO_CHAT_ID || process.env.ADMIN_TG_ID || "";
  const missing = [token ? "" : "BOT_TOKEN", chatId ? "" : "AUDIO_CHAT_ID or ADMIN_TG_ID"].filter(Boolean);
  if (missing.length > 0) throw new Error(`empty secret(s): ${missing.join(", ")}`);
  const tts = apiTts(cfg.voice);
  return {
    secrets: [token, chatId],
    deps: {
      tts,
      toOgg,
      stopAfterFailures: STOP_AFTER_FAILURES,
      send: async (ogg, caption) => {
        try {
          return await sendVoice({ token, chatId, ogg, caption });
        } catch (e) {
          // Telegram flood control: wait as long as it asks (up to MAX_FLOOD_WAIT_S), then try once more; a longer wait ends the run.
          const retry = /retry after (\d+)/i.exec(e instanceof Error ? e.message : "");
          if (!retry) throw e;
          const wait = Number(retry[1]);
          if (wait > MAX_FLOOD_WAIT_S) throw new StopRun(`Telegram asks to wait ${wait} s (limit ${MAX_FLOOD_WAIT_S} s)`);
          await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
          return sendVoice({ token, chatId, ogg, caption });
        }
      },
    },
  };
}

const errorLines = (r: VoiceResult[], secrets: string[]): string[] => {
  const first = new Map<string, string>();
  for (const x of r) for (const [kind, msg] of Object.entries(x.errors ?? {})) if (!first.has(kind)) first.set(kind, msg);
  return [...first].map(([kind, msg]) => `- first ${kind} error: ${scrub(msg, secrets).replace(/\n/g, " ")}`);
};

const WRANGLER = ["wrangler", "d1", "execute", "kabatla", "--remote"];

/** Runs wrangler; its stderr is dropped and failures carry only the exit code (a failing statement could echo a file_id or a word). */
function wrangler(extra: string[]): string {
  try {
    return execFileSync("npx", [...WRANGLER, ...extra], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    const code = (e as { status?: number | null }).status;
    throw new Error(`wrangler d1 execute failed (exit code ${code ?? "unknown"}); details are withheld`);
  }
}

function parseLimit(argv: string[]): number {
  const at = argv.indexOf("--limit");
  if (at < 0) return 200;
  const raw = argv[at + 1] ?? "";
  const n = Number(raw);
  if (!/^\d{1,4}$/.test(raw) || n < 1 || n > 1000) throw new Error(`--limit expects an integer 1..1000, got "${raw.slice(0, 20)}"`);
  return n;
}

function applySql(sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), "voice-db-"));
  try {
    const file = join(dir, "result.sql");
    writeFileSync(file, `${sql}\n`);
    wrangler(["--file", file, "--yes"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function db(): Promise<void> {
  const { deps, secrets } = setup();
  const limit = parseLimit(process.argv);
  const out = wrangler(["--json", "--command", `SELECT id, word FROM notes WHERE audio_file_id IS NULL AND audio_tries < 3 ORDER BY id LIMIT ${limit}`]);
  const rows = (JSON.parse(out) as { results?: { id: unknown; word: unknown }[] }[])[0]?.results ?? [];
  const items = rows.flatMap((r) => (Number.isSafeInteger(r.id) && typeof r.word === "string" ? [{ id: r.id as number, word: r.word }] : []));
  if (items.length === 0) {
    writeReport(["## Database run", "", "- selected: 0 (nothing to voice)"]);
    console.log("nothing to voice");
    return;
  }
  // Outcomes reach D1 every 20 notes, so a cancelled or timed-out run loses at most the last chunk.
  let saved = 0;
  const r = await voiceBatch(items, {
    ...deps,
    persist: async (settled) => {
      const sql = resultSql(settled);
      if (sql !== "") applySql(sql);
      saved += settled.done.length;
    },
  });
  const untouched = items.length - r.done.length - r.failed.length;
  writeReport([
    "## Database run", "",
    `- limit: ${limit}`, `- selected: ${items.length}`, `- voiced and saved: ${saved}`, `- failed (one try burned each): ${r.failed.length}`,
    `- not attempted or left for the next run: ${untouched}`,
    `- stopped early: ${r.stopped === "failures" ? `YES, ${STOP_AFTER_FAILURES} tts/ogg/send failures in a row (their tries were not burned)` : r.stopped === "flood" ? "YES, Telegram asked for a long wait" : "no"}`,
    ...errorLines([r], secrets),
    ...(r.failed.length > 0 ? [`- failed note ids (first 30): ${r.failed.slice(0, 30).join(", ")}`] : []),
  ]);
  // A long Telegram wait is an ordinary pause (the schedule continues); a dead API or token is not.
  if (r.stopped === "failures") throw new Error("run stopped early: too many failures in a row");
}

/** A run that died before writing its own report still leaves a line explaining why (scrubbed of secrets). */
function writeReportIfMissing(e: unknown): void {
  const secrets = [process.env.BOT_TOKEN ?? "", process.env.ADMIN_TG_ID ?? "", process.env.AUDIO_CHAT_ID ?? ""];
  try {
    readFileSync(REPORT_FILE);
  } catch {
    writeReport(["## Run", "", `FAILED: ${scrub(e instanceof Error ? e.message : String(e), secrets).replace(/\n/g, " ").slice(0, 600)}`]);
  }
}

const fail = (e: unknown): never => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
};

const cmd = process.argv[2];
if (cmd === "sample") {
  sample().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === "db") {
  db().catch((e: unknown) => {
    writeReportIfMissing(e);
    fail(e);
  });
} else {
  console.error("usage: tsx scripts/voice.ts sample | db [--limit N]");
  process.exit(2);
}
