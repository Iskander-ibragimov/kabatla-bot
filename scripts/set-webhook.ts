/** Registers the webhook, the bot commands and the bot description. Env: BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL. */
import { ru, type Dict } from "../src/i18n/ru";
import { tt } from "../src/i18n/tt";

const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) throw new Error("BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL are required");

type TgResult = { ok: boolean; description?: string; result?: unknown; parameters?: { retry_after?: number } };

/** One Telegram call; a 429 is retried once after the advised pause (at most 30 s). Errors carry Telegram's own text. */
async function call(method: string, body: unknown): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const json = (await res.json()) as TgResult;
    if (json.ok) return json.result;
    if (res.status === 429 && attempt === 1) {
      const wait = Math.min(json.parameters?.retry_after ?? 5, 30);
      console.log(`${method}: HTTP 429, retry in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000 + 500));
      continue;
    }
    throw new Error(`${method}: HTTP ${res.status} ${json.description}`);
  }
}

/** The webhook must be registered: a failure here fails the deploy. */
async function must(method: string, body: unknown) {
  await call(method, body);
  console.log(`${method}: ok`);
}

/**
 * Cosmetic settings (commands, description, menu button): read the current value and write only when it differs.
 * A failure is a WARNING, not a failed deploy: the bot works without them.
 */
async function cosmetic(label: string, read: () => Promise<unknown>, want: unknown, write: () => Promise<unknown>) {
  try {
    if (JSON.stringify(await read()) === JSON.stringify(want)) { console.log(`${label}: unchanged`); return; }
    await write();
    console.log(`${label}: ok`);
  } catch (e) { console.log(`WARNING ${label}: ${(e as Error).message}`); }
}

/** Commands that exist today, in menu order; the texts live in the interface dictionaries. */
const commands = (t: Dict) =>
  ([["start", t.cmdStart], ["learn", t.cmdLearn], ["levels", t.cmdLevels], ["gen", t.cmdGen], ["stats", t.cmdStats], ["settings", t.cmdSettings], ["undo", t.cmdUndo], ["help", t.cmdHelp]] as const)
    .map(([command, description]) => ({ command, description }));

await must("setWebhook", {
  url: `${WORKER_URL.replace(/\/$/, "")}/tg`, secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"], drop_pending_updates: false, max_connections: 40,
});

const scopes: { label: string; dict: Dict; lang?: string }[] = [
  { label: "default", dict: ru }, { label: "ru", dict: ru, lang: "ru" }, { label: "tt", dict: tt, lang: "tt" },
];
// Default scope = Russian, "ru" = Russian explicitly, "tt" = Tatar for users whose app language is Tatar.
for (const { label, dict, lang } of scopes) {
  const extra = lang ? { language_code: lang } : {};
  const want = commands(dict);
  await cosmetic(`commands ${label}`, async () => await call("getMyCommands", extra), want, () => call("setMyCommands", { commands: want, ...extra }));
  await cosmetic(`description ${label}`, async () => ((await call("getMyDescription", extra)) as { description?: string }).description, dict.botAbout,
    () => call("setMyDescription", { description: dict.botAbout, ...extra }));
}
await cosmetic("menu button", async () => ((await call("getChatMenuButton", {})) as { type?: string }).type, "commands",
  () => call("setChatMenuButton", { menu_button: { type: "commands" } }));
