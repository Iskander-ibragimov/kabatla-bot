import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ["reports", "review_log", "cards", "user_decks", "notes", "decks", "sessions", "previews", "jobs", "usage_daily", "users", "user_progress", "catalog_groups", "topics", "tick_log"];
beforeEach(async () => {
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare("DELETE FROM meta"),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('catalog_version', '0'), ('catalog_hash', '')"),
  ]);
});
