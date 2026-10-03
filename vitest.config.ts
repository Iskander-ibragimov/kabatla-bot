import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: "123:test",
            WEBHOOK_SECRET: "test-secret",
            ADMIN_TG_ID: "999",
            LLM_PROVIDERS: "[]",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: {
        provider: "istanbul" as const,
        include: ["src/**"],
        // Spec §11: the scheduler, the review session and the transcription rules at 90% of lines, the whole bot at 70%.
        thresholds: {
          lines: 70,
          "src/srs/**": { lines: 90 },
          "src/review/**": { lines: 90 },
          "src/content/transcribe.ts": { lines: 90 },
        },
      },
    },
  };
});
