import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { tt } from "../../src/i18n/tt";
import { tick } from "../../src/reminders/service";
import { easyButton, harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { WORDS, seedLevels } from "../helpers/seed";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 Moscow
/** Level 2 is the deck this scenario studies: enough words for two days of ten new cards. */
const LEVEL_2 = [
  "бала", "ана", "ата", "кул", "күз", "баш", "ел", "ай", "кич", "төн", "иртә", "шәһәр", "урам", "мәктәп", "дус",
  "тел", "акча", "ипи", "сөт", "ит", "алма", "чәй", "агач", "елга", "тау", "кояш", "яңгыр", "кар", "җил", "күл",
];
const gradeButtons = (m: { inline_keyboard?: { callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data).filter((c) => c.startsWith("g:"));

describe("first day and next day", () => {
  it("onboarding, a session, a reminder next morning and grown memory", async () => {
    await seedLevels(env.DB, { 1: WORDS.map(([word]) => word), 2: LEVEL_2 });
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    await h.press("ob:ru");
    for (let i = 0; i < 10; i++) await h.press(i < 4 ? "ob:1" : "ob:0");
    await h.press("ob:10");
    await h.press("ob:09:00");
    await h.press("ob:180");
    await h.press("ob:l02");
    await h.press("learn");
    expect(h.lastText()).toContain("<b>бала</b>");
    let t = T;
    let sessionMsg = 100;
    for (let i = 0; i < 10; i++) {
      const g = gradeButtons(h.lastMarkup());
      expect(g).toHaveLength(4);
      t += 20_000;
      h.setNow(t);
      await h.press(i % 4 === 0 ? g[0]! : g[2]!, sessionMsg);
    }
    // finish learning steps
    for (let i = 0; i < 30 && gradeButtons(h.lastMarkup()).length; i++) {
      t += 11 * MIN;
      h.setNow(t);
      await h.press("learn", 700 + i);
      const g = gradeButtons(h.lastMarkup());
      if (!g.length) break;
      await h.press(g[2]!, sessionMsg);
    }
    expect(h.lastText()).toMatch(/Сегодня: \d+ повт\./);
    expect(h.lastText()).not.toContain("Всего:");

    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u.streak).toBe(1);
    expect(u).toMatchObject({ level: 2, direction: "tt_ru" });
    expect(await repo.userDeckIds(u.id)).toEqual([(await repo.getDeckBySlug("l02"))!.id]);
    const tg = fakeTelegram();
    const nextMorning = T + DAY + MIN;
    await tick({ repo, tg, now: nextMorning });
    await tick({ repo, tg, now: nextMorning + MIN });
    const pushes = tg.of("sendMessage").filter((c) => String(c.payload.text).includes("Пора повторить"));
    expect(pushes).toHaveLength(1);

    h.setNow(nextMorning + 5 * MIN);
    await h.press("learn", 900);
    const maxDays = async () => (await env.DB.prepare("SELECT MAX(scheduled_days) AS d FROM cards").first<{ d: number }>())!.d;
    const before = await maxDays();
    for (let i = 0; i < 25; i++) {
      const g = gradeButtons(h.lastMarkup());
      if (!g.length) break;
      expect(h.lastText()).not.toContain("→");
      await h.press(g[2]!, 900);
    }
    expect(await maxDays()).toBeGreaterThan(before);
  });

  it("Tatar interface: onboarding → 100 words of the level → the session ends; level 2 is not opened", async () => {
    const words100 = Array.from({ length: 100 }, (_, i) => `сүз${i + 1}`);
    await seedLevels(env.DB, { 1: words100, 2: ["авыл"] }, { 1: 31 });
    const db = countingDb(env.DB);
    const h = harness(db, { now: T });
    let maxTelegramCallsPerUpdate = 0, maxD1CallsPerUpdate = 0;
    /** Runs one update and keeps the largest number of Telegram and D1 calls a single update made. */
    const update = async (run: () => Promise<unknown>) => {
      const telegramBefore = h.tg.calls.length;
      db.calls = 0;
      await run();
      maxTelegramCallsPerUpdate = Math.max(maxTelegramCallsPerUpdate, h.tg.calls.length - telegramBefore);
      maxD1CallsPerUpdate = Math.max(maxD1CallsPerUpdate, db.calls);
    };
    const press = (data: string) => update(() => h.press(data, h.tg.lastMessageId()));

    await update(() => h.text("/start"));
    await press("ob:tt");
    expect(h.lastText()).toBe(tt.placementQ(1, "бар"));
    for (let i = 0; i < 10; i++) {
      expect((h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.text)).toEqual([tt.knowBtn, "Белмим"]);
      await press("ob:0");
    }
    expect(h.lastText()).toBe(tt.goalQ(1));
    await press("ob:20");
    await press("ob:09:00");
    await press("ob:180");
    expect(h.tg.of("editMessageText").at(-1)!.payload.text).toBe(`${tt.finished("09:00", "UTC+3")}\n\n${tt.easyHint}`);
    expect(h.lastText()).toContain(`<b>${words100[0]}</b>`);
    expect(h.lastText().startsWith("🔵 20 · 🔴 0 · 🟢 0\n")).toBe(true);

    for (let i = 0; i < 100; i++) {
      expect(h.lastText()).toContain(`<b>${words100[i]}</b>`);
      expect(h.lastText()).not.toContain(tt.levelUp(1, 2, 31, 100));
      const easy = (h.lastMarkup().inline_keyboard ?? []).flat().find((b) => b.callback_data === easyButton(h))!;
      expect(easy.text.startsWith(`${tt.easy} `)).toBe(true);
      await press(easy.callback_data);
    }
    // Every word of the checked level is in work: the session ends, in Tatar, and the bot opens nothing by itself.
    expect(h.lastText()).toBe([tt.doneTitle, tt.doneToday(100, 0), tt.streak(1)].join("\n"));
    expect(h.lastText()).not.toContain("авыл");
    expect(maxTelegramCallsPerUpdate).toBeLessThanOrEqual(3);
    expect(maxD1CallsPerUpdate).toBeLessThanOrEqual(8);

    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u).toMatchObject({ lang: "tt", level: 1, levels: 1, newPerDay: 20, onboardingStep: null });
    expect(await repo.userDeckIds(u.id)).toEqual([(await repo.getDeckBySlug("l01"))!.id]);
    const log = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(was_new) AS fresh, MIN(rating) AS lo FROM review_log WHERE user_id = ?").bind(u.id).first<{ n: number; fresh: number; lo: number }>();
    expect(log).toEqual({ n: 100, fresh: 100, lo: 4 });
  });
});
