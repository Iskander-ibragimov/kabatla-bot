import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminStatsText } from "../../src/admin/service";
import { Repo } from "../../src/db/repo";
import { recordTickFailure, tick } from "../../src/reminders/service";
import { countingDb } from "../helpers/countingDb";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { seedCatalog, seedLearner } from "../helpers/seed";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ADMIN = 777;
const local = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m) - 180 * MIN; // +03:00
const run = (tg: ReturnType<typeof fakeTelegram>, now: number, db: D1Database = env.DB) => tick({ repo: new Repo(db), tg, now, adminTgId: ADMIN });
const rows = async () => (await env.DB.prepare("SELECT * FROM tick_log ORDER BY at, id").all<Record<string, unknown>>()).results;
/** A learner with three A1 words to learn, the daily reminder due at 09:00 (UTC+3) on the 30th. */
const learner = async (tgId = 1) => seedLearner(env.DB, { now: local(30, 8, 0), tgId });
const adminMessages = (tg: ReturnType<typeof fakeTelegram>) => tg.of("sendMessage").filter((c) => c.payload.chat_id === ADMIN);

describe("the tick log", () => {
  it("a tick that sends writes one row; an idle tick writes none", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сүз1" }, { level: 1, word: "сүз2" }]);
    await learner();
    const tg = fakeTelegram();
    await run(tg, local(30, 8, 59));
    expect(await rows()).toEqual([]);
    await run(tg, local(30, 9, 1));
    expect(await rows()).toEqual([{
      id: expect.any(Number), at: local(30, 9, 1), daily_selected: 1, daily_planned: 1, evening_planned: 0, step_planned: 0,
      sent: 1, failed: 0, first_error: null, alerted: 0,
    }]);
    expect(adminMessages(tg)).toEqual([]);
  });

  it("a daily row with nothing to say is logged as selected and not planned", async () => {
    await seedCatalog(env.DB, [{ level: 2, word: "сүз1" }]); // A1 is checked, and has no word
    await learner();
    await run(fakeTelegram(), local(30, 9, 1));
    expect(await rows()).toMatchObject([{ daily_selected: 1, daily_planned: 0, sent: 0, failed: 0 }]);
  });

  it("a refused send that is neither 429 nor 403 is counted with Telegram's description, and the admin is told at most once an hour", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сүз1" }]);
    const { repo, user } = await learner();
    const failing = (tg: ReturnType<typeof fakeTelegram>) => ({
      call: async <T>(method: string, payload: Record<string, unknown>) => {
        if (payload.chat_id !== ADMIN) throw Object.assign(new Error("Bad Request: can't parse entities"), { error_code: 400 });
        return tg.call<T>(method, payload);
      },
    });
    const tg = fakeTelegram();
    await tick({ repo, tg: failing(tg), now: local(30, 9, 1), adminTgId: ADMIN });
    expect(await rows()).toMatchObject([{ daily_planned: 1, sent: 0, failed: 1, first_error: "Bad Request: can't parse entities", alerted: 1 }]);
    const alerts = adminMessages(tg);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]!.payload.text)).toContain("Bad Request: can't parse entities");
    // Half an hour later another push fails: logged, the admin is not told again.
    await repo.updateUser(user.id, { nextDailyAt: local(30, 9, 30) });
    await tick({ repo, tg: failing(tg), now: local(30, 9, 31), adminTgId: ADMIN });
    expect(adminMessages(tg)).toHaveLength(1);
    expect((await rows()).map((r) => [r.failed, r.alerted])).toEqual([[1, 1], [1, 0]]);
    // More than an hour after the alert: told again.
    await repo.updateUser(user.id, { nextDailyAt: local(30, 10, 2) });
    await tick({ repo, tg: failing(tg), now: local(30, 10, 3), adminTgId: ADMIN });
    expect(adminMessages(tg)).toHaveLength(2);
  });

  it("an error that is no Telegram error is counted too, cut to 300 characters, with no long number in it", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сүз1" }]);
    const { repo } = await learner(123456789);
    const tg = fakeTelegram();
    const crashing = { call: async <T>(method: string, payload: Record<string, unknown>) => {
      if (payload.chat_id === ADMIN) return tg.call<T>(method, payload);
      throw new Error(`fetch to chat 123456789 failed: ${"x".repeat(400)}`);
    } };
    await tick({ repo, tg: crashing, now: local(30, 9, 1), adminTgId: ADMIN });
    const [row] = await rows();
    const err = String(row!.first_error);
    expect(err.length).toBeLessThanOrEqual(300);
    expect(err).toMatch(/^fetch to chat … failed: x+/);
    expect(err).not.toContain("123456789");
    expect(String(adminMessages(tg)[0]!.payload.text)).not.toContain("123456789");
  });

  it("403 and 429 are no failures: the user is deactivated or the push queued, and the admin is not told", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сүз1" }]);
    await learner(1);
    await learner(2);
    const tg = fakeTelegram();
    let n = 0;
    const flaky = { call: async <T>(method: string, payload: Record<string, unknown>) => {
      n++;
      if (n === 1) throw Object.assign(new Error("Forbidden: bot was blocked by the user"), { error_code: 403 });
      if (n === 2) throw Object.assign(new Error("Too Many Requests"), { error_code: 429, parameters: { retry_after: 5 } });
      return tg.call<T>(method, payload);
    } };
    await tick({ repo: new Repo(env.DB), tg: flaky, now: local(30, 9, 1), adminTgId: ADMIN });
    expect(await rows()).toMatchObject([{ daily_selected: 2, daily_planned: 2, sent: 0, failed: 0, first_error: null }]);
    expect(adminMessages(tg)).toEqual([]);
  });

  it("a tick that throws is logged with its message and the admin told, at most once an hour", async () => {
    const repo = new Repo(env.DB);
    const tg = fakeTelegram();
    const now = local(30, 9, 1);
    await recordTickFailure(repo, tg, ADMIN, now, new Error("D1_ERROR: no such column: u.foo"));
    await recordTickFailure(repo, tg, ADMIN, now + MIN, "boom");
    expect((await rows()).map((r) => [r.at, r.first_error, r.alerted])).toEqual([[now, "D1_ERROR: no such column: u.foo", 1], [now + MIN, "boom", 0]]);
    expect(adminMessages(tg)).toHaveLength(1);
    expect(String(adminMessages(tg)[0]!.payload.text)).toContain("D1_ERROR: no such column: u.foo");
  });

  it("rows older than 7 days go with the tick's housekeeping", async () => {
    const now = local(30, 9, 1);
    for (const at of [now - 7 * DAY - 1, now - 8 * DAY, now - 7 * DAY, now - HOUR]) {
      await env.DB.prepare("INSERT INTO tick_log (at, sent) VALUES (?, 1)").bind(at).run();
    }
    await run(fakeTelegram(), now);
    expect((await rows()).map((r) => r.at)).toEqual([now - 7 * DAY, now - HOUR]);
  });

  it("a failing tick stays within 10 D1 calls", async () => {
    await seedCatalog(env.DB, [{ level: 1, word: "сүз1" }]);
    for (let i = 0; i < 5; i++) await learner(100 + i);
    const tg = fakeTelegram();
    const failing = { call: async <T>(method: string, payload: Record<string, unknown>) => {
      if (payload.chat_id !== ADMIN) throw Object.assign(new Error("Bad Request: chat not found"), { error_code: 400 });
      return tg.call<T>(method, payload);
    } };
    const db = countingDb(env.DB);
    await tick({ repo: new Repo(db), tg: failing, now: local(30, 9, 1), adminTgId: ADMIN });
    expect(db.calls).toBeLessThanOrEqual(10);
    expect(await rows()).toMatchObject([{ daily_planned: 5, failed: 5, first_error: "Bad Request: chat not found" }]);
  });

  it("/admin shows the last 5 ticks that did something, in UTC, with the first error escaped", async () => {
    const T = Date.UTC(2026, 9, 28, 16, 0);
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare("INSERT INTO tick_log (at, daily_selected, daily_planned, evening_planned, step_planned, sent, failed, first_error) VALUES (?, 1, 1, 1, 0, ?, ?, ?)")
        .bind(T - i * DAY, i === 0 ? 0 : 2, i === 0 ? 2 : 0, i === 0 ? "Bad Request: <b>" : null).run();
    }
    const text = await adminStatsText(new Repo(env.DB), T);
    expect(text).toContain("Напоминания (последние 5 тиков с делом)");
    expect(text).toContain("• 28.10 16:00 — 1/2/0/2 · Bad Request: &lt;b&gt;");
    expect(text).toContain("• 24.10 16:00 — 1/2/2/0");
    expect(text).not.toContain("23.10");
  });

  it("/admin says so when no tick did anything", async () => {
    expect(await adminStatsText(new Repo(env.DB), Date.UTC(2026, 9, 28))).toContain("Напоминания (последние 5 тиков с делом): нет");
  });
});
