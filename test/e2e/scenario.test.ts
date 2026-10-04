import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { HINT } from "../../src/tutorial/hints";
import { tick } from "../../src/reminders/service";
import { easyButton, harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { levelWords, seedCatalog } from "../helpers/seed";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 Moscow
/** The words of A1 in this scenario: enough for two days of ten new cards. */
const A1 = [
  "бала", "ана", "ата", "кул", "күз", "баш", "ел", "ай", "кич", "төн", "иртә", "шәһәр", "урам", "мәктәп", "дус",
  "тел", "акча", "ипи", "сөт", "ит", "алма", "чәй", "агач", "елга", "тау", "кояш", "яңгыр", "кар", "җил", "күл",
];
const gradeButtons = (m: { inline_keyboard?: { callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data).filter((c) => c.startsWith("g:"));

describe("first day and next day", () => {
  it("onboarding, a session, a reminder next morning and grown memory", async () => {
    await seedCatalog(env.DB, A1.map((word) => ({ level: 1, word })));
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    for (const answer of ["ob:ru", "ob:n1", "ob:n2", "ob:go"]) await h.press(answer, 100);
    // «Начать» gives the first card at once, with the hint of the first card; «▶ Учить» shows the same card.
    expect(h.lastText().startsWith(`${ru.hintFront}\n\n🔵 10 · 🔴 0 · 🟢 0\n<b>бала</b>\n`)).toBe(true);
    await h.press("learn");
    expect(h.lastText().startsWith(`${ru.hintFront}\n\n🔵 10 · 🔴 0 · 🟢 0\n<b>бала</b>\n`)).toBe(true);
    let t = T;
    let sessionMsg = 100;
    /** What stands before the counters of the card on screen: a hint, or nothing. */
    const leads: string[] = [];
    for (let i = 0; i < 10; i++) {
      const g = gradeButtons(h.lastMarkup());
      expect(g).toHaveLength(4);
      t += 20_000;
      h.setNow(t);
      await h.press(i % 4 === 0 ? g[0]! : g[2]!, sessionMsg);
      leads.push(h.lastText().split("🔵")[0]!);
    }
    // The first card was graded «Снова», the second «Хорошо»: each button explains itself once, the first with the order of a session; up to the fifth card and beyond nothing else is said.
    expect(leads).toEqual([`${ru.hintAgain("&lt;1м")}\n${ru.hintOrder}\n\n`, `${ru.hintGood("&lt;10м")}\n\n`, "", "", "", "", "", "", "", ""]);
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
    expect(u).toMatchObject({ levels: 1, direction: "tt_ru", onboardingStep: null, hintsSeen: HINT.update | HINT.front | HINT.again | HINT.good | HINT.order });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_decks").first()).toEqual({ n: 0 });
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

  it("Tatar interface: the introduction → 100 words of A1 → the session ends; A2 is not checked by the bot", async () => {
    const words100 = Array.from({ length: 100 }, (_, i) => `сүз${i + 1}`);
    await seedCatalog(env.DB, [...levelWords(1, words100), ...levelWords(2, ["авыл"])]);
    await env.DB.prepare("UPDATE decks SET coverage_pct = 31 WHERE level_no = 1").run();
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
    expect(h.lastText()).toBe(tt.intro1);
    await press("ob:n1");
    expect(h.lastText()).toBe(tt.intro2);
    await press("ob:n2");
    expect(h.lastText()).toBe(tt.obLevels);
    expect((h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.text)).toEqual(["☑ A1 · 100 сүз · текстның ≈31 %", "☐ A2 · 1 сүз", "☐ B1 · тиздән", "☐ B2 · тиздән", "☐ C1 · тиздән", "Башлау"]);
    await press("ob:go");
    // The message of the introduction keeps its last text and loses its buttons; nothing else is sent but the card.
    expect(h.tg.of("editMessageText").at(-1)!.payload.text).toBe(tt.obLevels);
    expect(h.tg.calls.slice(-3).map((c) => c.method)).toEqual(["editMessageReplyMarkup", "sendMessage", "answerCallbackQuery"]);
    expect(h.lastText().startsWith(`${tt.hintFront}\n\n🔵 10 · 🔴 0 · 🟢 0\n<b>${words100[0]}</b>\n`)).toBe(true);

    /** The interval on the «Җиңел» button of the first card, like «8көн»: the hint above the second card names it. */
    let firstEasy = "";
    for (let i = 0; i < 100; i++) {
      expect(h.lastText()).toContain(`<b>${words100[i]}</b>`);
      // «Җиңел» explains itself above the second card, with the order of a session, and never again.
      if (i === 1) expect(h.lastText().startsWith(`„Җиңел“: сүз шунда ук озакка китте — кайтканчы ${firstEasy} бар. Ул көнлек яңа сүзләр санына керми.\n${tt.hintOrder}\n\n🔵 10 · 🔴 0 · 🟢 0\n`)).toBe(true);
      if (i > 1) expect(h.lastText().startsWith("🔵 10 · 🔴 0 · 🟢 0\n")).toBe(true);
      const easy = (h.lastMarkup().inline_keyboard ?? []).flat().find((b) => b.callback_data === easyButton(h))!;
      expect(easy.text.startsWith(`${tt.easy} `)).toBe(true);
      if (i === 0) firstEasy = easy.text.slice(tt.easy.length + 1);
      await press(easy.callback_data);
    }
    // Every word of the checked level is in work: the session ends, in Tatar; the bot opens nothing by itself and offers the next level.
    expect(h.lastText()).toBe([tt.doneTitle, tt.doneToday(100, 0), tt.streak(1), "", tt.emptyLevels].join("\n"));
    expect((h.lastMarkup().inline_keyboard ?? [])[0]!.map((b) => [b.text, b.callback_data])).toEqual([["A2 дәрәҗәсен өстәү", "fix:lv:2"]]);
    expect(h.lastText()).not.toContain("авыл");
    expect(maxTelegramCallsPerUpdate).toBeLessThanOrEqual(3);
    expect(maxD1CallsPerUpdate).toBeLessThanOrEqual(8);

    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u).toMatchObject({ lang: "tt", levels: 1, newPerDay: 10, onboardingStep: null, hintsSeen: HINT.update | HINT.front | HINT.easy | HINT.order });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_decks").first()).toEqual({ n: 0 });
    const log = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(was_new) AS fresh, MIN(rating) AS lo FROM review_log WHERE user_id = ?").bind(u.id).first<{ n: number; fresh: number; lo: number }>();
    expect(log).toEqual({ n: 100, fresh: 100, lo: 4 });
  });
});
