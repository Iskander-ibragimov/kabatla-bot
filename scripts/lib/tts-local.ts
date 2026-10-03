/** Node-only speech helpers: Piper (local ONNX voices) and ffmpeg. Run in GitHub Actions, never in the Worker. */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TtsError, type Tts } from "./tts-api";

const PROCESS_TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], input: Uint8Array | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => { clearTimeout(timer); reject(new TtsError(`${cmd}: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new TtsError(`${cmd} exited with ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(-300)}`));
    });
    child.stdin.on("error", () => {}); // a dying child closes the pipe; the exit code reports it
    child.stdin.end(input);
  });
}

/**
 * piper-tts 1.8.0 parses -c/--config but ignores it and always loads `<model>.onnx.json`, so the discovered
 * config is copied to that name when it is missing.
 */
export function ensureModelConfig(modelPath: string, configPath?: string): void {
  const expected = `${modelPath}.json`;
  if (configPath && configPath !== expected && !existsSync(expected)) copyFileSync(configPath, expected);
}

/** Piper reads text from stdin and writes a WAV file. */
export function piperTts(modelPath: string, configPath?: string): Tts {
  ensureModelConfig(modelPath, configPath);
  return {
    async synth(text) {
      const dir = mkdtempSync(join(tmpdir(), "piper-"));
      const wav = join(dir, "out.wav");
      try {
        const args = ["-m", modelPath, ...(configPath ? ["-c", configPath] : []), "-f", wav];
        await run("piper", args, `${text}\n`);
        return new Uint8Array(readFileSync(wav));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** WAV -> OGG/Opus mono, 24 kbit/s, the format Telegram shows as a voice message. */
export async function toOgg(wav: Uint8Array): Promise<Uint8Array> {
  const ogg = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", "pipe:1"], wav);
  if (ogg.length === 0) throw new TtsError("ffmpeg produced no output");
  return new Uint8Array(ogg);
}

export interface PiperModel {
  /** File name of the .onnx file. */
  name: string;
  model: string;
  config?: string;
  size: number;
  gender?: "female" | "male";
}

function guessGender(path: string): "female" | "male" | undefined {
  const p = path.toLowerCase();
  if (/female|woman|alsu|(^|[^a-z])f($|[^a-z])/.test(p)) return "female";
  if (/(^|[^a-z])male|almaz|(^|[^a-z])man($|[^a-z])|(^|[^a-z])m($|[^a-z])/.test(p)) return "male";
  return undefined;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Finds *.onnx files under dir with their JSON configs (<model>.onnx.json, <model>.json or config.json next to it). */
export function findPiperModels(dir: string): PiperModel[] {
  let files: string[];
  try {
    files = walk(dir);
  } catch {
    return [];
  }
  const set = new Set(files);
  return files
    .filter((f) => f.endsWith(".onnx"))
    .sort()
    .map((f) => {
      const candidates = [`${f}.json`, f.replace(/\.onnx$/, ".json"), join(dirname(f), "config.json")];
      return { name: basename(f), model: f, config: candidates.find((c) => set.has(c)), size: statSync(f).size, gender: guessGender(f.slice(dir.length)) };
    });
}
