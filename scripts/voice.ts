/**
 * Voice tooling (run only in GitHub Actions).
 *   tsx scripts/voice.ts sample            sends data/voice-sample.txt in 4 candidate voices to ADMIN_TG_ID
 *   tsx scripts/voice.ts catalog [--level N]  voices the level files' rows without audio_file_id, writes the ids back into the CSV
 *   tsx scripts/voice.ts db                voices users' own words (notes without audio) in the production D1 database
 * Env: BOT_TOKEN, ADMIN_TG_ID, AUDIO_CHAT_ID (optional: where voice messages go, default ADMIN_TG_ID),
 *      PIPER_MODELS_DIR (default "models"), REPORT_FILE (default "out/voice-run.md").
 * Voice messages are sent silently with the word as caption. The report never contains secrets, chat ids or Telegram
 * file_ids; `db` prints note ids only, never users' words.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { levelNumbers, readLevel, writeLevel } from "./lib/files";
import { catalogText, resultSql, voiceBatch, type VoiceDeps, type VoiceResult } from "./lib/voice-queue";
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
          // Telegram flood control: wait as long as it asks, then try once more.
          const retry = /retry after (\d+)/i.exec(e instanceof Error ? e.message : "");
          if (!retry) throw e;
          await new Promise((r) => setTimeout(r, (Number(retry[1]) + 1) * 1000));
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

function parseLevelArg(argv: string[]): number | undefined {
  const at = argv.indexOf("--level");
  if (at < 0) return undefined;
  const raw = argv[at + 1] ?? "";
  if (!/^\d{1,2}$/.test(raw)) throw new Error(`--level expects a number 1..20, got "${raw}"`);
  return Number(raw);
}

async function catalog(): Promise<void> {
  const { deps, secrets } = setup();
  const only = parseLevelArg(process.argv);
  const available = levelNumbers();
  if (only !== undefined && !available.includes(only)) throw new Error(`no file for level ${only} (have: ${available.join(", ") || "none"})`);
  const levels = only === undefined ? available : [only];

  const table: string[] = ["| level | rows | already voiced | voiced now | failed | still without audio |", "|---|---|---|---|---|---|"];
  const results: VoiceResult[] = [];
  const failedWords: string[] = [];
  let voiced = 0, failed = 0, skipped = 0, remaining = 0, stopped = false;

  for (const n of levels) {
    const rows = readLevel(n);
    const pending = rows.flatMap((row, i) => (row.audio_file_id === "" ? [{ id: i, word: catalogText(row.word) }] : []));
    const already = rows.length - pending.length;
    if (stopped) {
      table.push(`| ${n} | ${rows.length} | ${already} | 0 | 0 | ${pending.length} (not attempted) |`);
      remaining += pending.length;
      skipped += already;
      continue;
    }
    const r = await voiceBatch(pending, deps);
    results.push(r);
    for (const d of r.done) rows[d.id]!.audio_file_id = d.fileId;
    if (r.done.length > 0) writeLevel(n, rows);
    for (const id of r.failed) failedWords.push(`l${String(n).padStart(2, "0")}:${rows[id]!.word}`);
    stopped = r.stopped === true;
    voiced += r.done.length;
    failed += r.failed.length;
    skipped += already;
    const left = pending.length - r.done.length;
    remaining += left;
    table.push(`| ${n} | ${rows.length} | ${already} | ${r.done.length} | ${r.failed.length} | ${left} |`);
    console.log(`level ${n}: voiced ${r.done.length}, failed ${r.failed.length}, left ${left}`);
  }

  writeReport([
    "## Catalog run", "",
    `- levels: ${levels.length === 0 ? "none found" : levels.join(", ")}`,
    `- voiced now: ${voiced}`, `- failed: ${failed}`, `- already voiced (skipped): ${skipped}`, `- still without audio: ${remaining}`,
    `- stopped early after ${STOP_AFTER_FAILURES} failures in a row: ${stopped ? "YES" : "no"}`,
    ...errorLines(results, secrets), "",
    ...table, "",
    ...(failedWords.length > 0 ? ["Failed words (first 20):", ...failedWords.slice(0, 20).map((w) => `- ${w}`), ""] : []),
  ]);
  if (stopped || failed > 0) throw new Error(`${failed} word(s) failed${stopped ? ", run stopped early" : ""}; run again to continue`);
}

const WRANGLER = ["wrangler", "d1", "execute", "kabatla", "--remote"];

function d1Rows(sql: string): { id: unknown; word: unknown }[] {
  const out = execFileSync("npx", [...WRANGLER, "--json", "--command", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out) as { results?: { id: unknown; word: unknown }[] }[];
  return parsed[0]?.results ?? [];
}

async function db(): Promise<void> {
  const { deps, secrets } = setup();
  const rows = d1Rows("SELECT id, word FROM notes WHERE audio_file_id IS NULL AND audio_tries < 3 ORDER BY id LIMIT 200");
  const items = rows.flatMap((r) => (Number.isSafeInteger(r.id) && typeof r.word === "string" ? [{ id: r.id as number, word: r.word }] : []));
  if (items.length === 0) {
    writeReport(["## Database run", "", "- selected: 0 (nothing to voice)"]);
    console.log("nothing to voice");
    return;
  }
  const r = await voiceBatch(items, deps);
  // A run cut short by the circuit breaker says nothing about the words themselves: do not burn their tries.
  const sql = resultSql(r.stopped ? { done: r.done, failed: [] } : r);
  if (sql !== "") {
    const dir = mkdtempSync(join(tmpdir(), "voice-db-"));
    try {
      const file = join(dir, "result.sql");
      writeFileSync(file, `${sql}\n`);
      execFileSync("npx", [...WRANGLER, "--file", file, "--yes"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  writeReport([
    "## Database run", "",
    `- selected: ${items.length} (rows returned: ${rows.length})`, `- voiced and saved: ${r.done.length}`, `- failed (one try counted each${r.stopped ? ", NOT counted: run stopped early" : ""}): ${r.failed.length}`,
    `- not attempted: ${items.length - r.done.length - r.failed.length}`,
    `- stopped early after ${STOP_AFTER_FAILURES} failures in a row: ${r.stopped ? "YES" : "no"}`,
    ...errorLines([r], secrets),
    ...(r.failed.length > 0 ? [`- failed note ids (first 30): ${r.failed.slice(0, 30).join(", ")}`] : []),
  ]);
  if (r.stopped) throw new Error("run stopped early: too many failures in a row");
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
} else if (cmd === "catalog") {
  catalog().catch((e: unknown) => {
    writeReportIfMissing(e);
    fail(e);
  });
} else if (cmd === "db") {
  db().catch((e: unknown) => {
    writeReportIfMissing(e);
    fail(e);
  });
} else {
  console.error("usage: tsx scripts/voice.ts sample | catalog [--level N] | db");
  process.exit(2);
}
