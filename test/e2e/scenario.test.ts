import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { tick } from "../../src/reminders/service";
import { harness } from "../helpers/botHarness";
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
    expect(h.lastText()).toContain("Всего:");

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
    void sessionMsg;
  });
});
