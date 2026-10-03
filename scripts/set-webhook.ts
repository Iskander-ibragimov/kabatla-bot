/** Registers the webhook, the bot commands and the bot description. Env: BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL. */
import { ru, type Dict } from "../src/i18n/ru";
import { tt } from "../src/i18n/tt";

const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) throw new Error("BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL are required");

async function api(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  console.log(`${method}: ok`);
}

/** Commands that exist today, in menu order; the texts live in the interface dictionaries. */
const commands = (t: Dict) =>
  ([["start", t.cmdStart], ["learn", t.cmdLearn], ["levels", t.cmdLevels], ["gen", t.cmdGen], ["stats", t.cmdStats], ["settings", t.cmdSettings], ["undo", t.cmdUndo], ["help", t.cmdHelp]] as const)
    .map(([command, description]) => ({ command, description }));

await api("setWebhook", {
  url: `${WORKER_URL.replace(/\/$/, "")}/tg`, secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"], drop_pending_updates: false, max_connections: 40,
});
// Russian is the default; Telegram shows the Tatar texts to users whose app language is Tatar.
await api("setMyCommands", { commands: commands(ru) });
await api("setMyCommands", { commands: commands(tt), language_code: "tt" });
await api("setMyDescription", { description: ru.botAbout });
await api("setMyDescription", { description: tt.botAbout, language_code: "tt" });
