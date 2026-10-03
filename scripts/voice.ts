/**
 * Voice tooling (run only in GitHub Actions).
 *   tsx scripts/voice.ts sample   sends data/voice-sample.txt in 4 candidate voices to ADMIN_TG_ID
 * Env: BOT_TOKEN, ADMIN_TG_ID, PIPER_MODELS_DIR (default "models"), REPORT_FILE (default "out/voice-run.md").
 * The report never contains secrets, chat ids or Telegram file_ids.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { apiTts, sendVoice, TtsError, type Tts } from "./lib/tts-api";
import { findPiperModels, piperTts, toOgg, type PiperModel } from "./lib/tts-local";

interface Voice { label: string; tts: Tts }
interface Tally { label: string; sent: number; total: number; firstError?: string }

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
  const tallies: Tally[] = voices.map((v) => ({ label: v.label, sent: 0, total: words.length }));

  for (const word of words) {
    for (const [i, voice] of voices.entries()) {
      const tally = tallies[i]!;
      try {
        const ogg = await toOgg(await voice.tts.synth(word));
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

  report.push("| voice | sent | total | first error |", "|---|---|---|---|");
  for (const t of tallies) report.push(`| ${t.label} | ${t.sent} | ${t.total} | ${t.firstError ? t.firstError.replace(/[|\n]/g, " ") : ""} |`);
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

const cmd = process.argv[2];
if (cmd === "sample") {
  sample().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else {
  console.error("usage: tsx scripts/voice.ts sample");
  process.exit(2);
}
