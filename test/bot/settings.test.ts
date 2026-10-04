import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderSettings, renderTimeZones } from "../../src/bot/screens";
import type { User } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { TZ_OFFSETS, nextOccurrence, setSetting } from "../../src/users/service";
import { harness } from "../helpers/botHarness";
import { countingDb } from "../helpers/countingDb";
import { seedCatalog, seedLearner, seedTopics } from "../helpers/seed";

/** 06:00 UTC: 09:00 for the learner, who lives at UTC+3 and is reminded at 09:00. */
const T = Date.UTC(2026, 8, 30, 6);
const HOUR = 3_600_000;
type Markup = { inline_keyboard?: { text: string; callback_data: string }[][] };
const buttons = (m: Markup) => (m.inline_keyboard ?? []).flat().map((b) => [b.text, b.callback_data]);

const SETTINGS_RU = [
  ["🌐 Язык: Русский", "set:lang"], ["🎯 Нагрузка: Оптимальная · 90%", "set:ret"], ["🆕 Новых в день: 10", "set:new"], ["⏰ Напоминание: 09:00", "set:rem"],
  ["🕒 Часовой пояс: UTC+3", "set:tz"], ["↔️ Направление: татарский → русский", "set:dir"], ["🔊 Автоозвучка: выкл", "set:auto"], ["📚 Уровни, темы, порядок слов", "set:hub"],
];
const ZONES_RU = [
  ["08:00 · UTC+2", "tz:120"], ["✅ 09:00 · UTC+3", "tz:180"], ["10:00 · UTC+4", "tz:240"], ["11:00 · UTC+5", "tz:300"], ["12:00 · UTC+6", "tz:360"], ["13:00 · UTC+7", "tz:420"],
  ["14:00 · UTC+8", "tz:480"], ["15:00 · UTC+9", "tz:540"], ["16:00 · UTC+10", "tz:600"], ["17:00 · UTC+11", "tz:660"], ["18:00 · UTC+12", "tz:720"], ["Готово", "set:back"],
];

/** The bot of a learner (Telegram id 42) over a database that counts its calls; an update gives its Telegram calls and the number of its D1 calls, each within the budget. */
async function session() {
  const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
  const db = countingDb(env.DB);
  const h = harness(db, { now: T });
  const update = async (run: () => Promise<unknown>) => {
    const before = h.tg.calls.length;
    db.calls = 0;
    await run();
    const calls = h.tg.calls.slice(before);
    expect(db.calls, "D1 calls").toBeLessThanOrEqual(8);
    expect(calls.length, calls.map((c) => c.method).join(",")).toBeLessThanOrEqual(3);
    return { calls, methods: calls.map((c) => c.method), d1: db.calls, toast: calls.find((c) => c.method === "answerCallbackQuery")?.payload.text };
  };
  return { repo, user, h, text: (s: string) => update(() => h.text(s)), press: (data: string, messageId = 100) => update(() => h.press(data, messageId)) };
}

describe("/settings", () => {
  it("lists the settings with the time zone and the row that opens the levels; «Режим» is «Нагрузка»", async () => {
    const s = await session();
    const u = await s.text("/settings");
    expect(s.h.lastText()).toBe(ru.settingsTitle);
    expect(buttons(s.h.lastMarkup())).toEqual(SETTINGS_RU);
    expect((s.h.lastMarkup().inline_keyboard ?? []).every((row) => row.length === 1)).toBe(true);
    expect(u.methods).toEqual(["sendMessage"]);
    expect(u.d1).toBe(1);
  });

  it("is in Tatar for a tt user", () => {
    const user = { lang: "tt", retention: 0.9, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 300, direction: "ru_tt", autoplay: false } as User;
    expect(renderSettings(user).keyboard.flat().map((b) => b.text)).toEqual([
      "🌐 Тел: Татарча", "🎯 Йөкләнеш: Оптималь · 90%", "🆕 Көненә яңа сүзләр: 10", "⏰ Искә төшерү: 09:00",
      "🕒 Сәгать поясы: UTC+5", "↔️ Юнәлеш: русча → татарча", "🔊 Автомат тавыш: сүндерелгән", "📚 Дәрәҗәләр, темалар, сүзләр тәртибе",
    ]);
    expect([0.85, 0.9, 0.95].map((r) => ru.setMode(r))).toEqual(["🎯 Нагрузка: Лёгкая · 85%", "🎯 Нагрузка: Оптимальная · 90%", "🎯 Нагрузка: Интенсивная · 95%"]);
  });

  it("«Часовой пояс» opens the zones UTC+2 … UTC+12 in the same message, each with the time it is there now and the learner's own marked", async () => {
    const s = await session();
    await s.text("/settings");
    const u = await s.press("set:tz");
    expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(u.calls[0]!.payload.message_id).toBe(100);
    expect(u.d1).toBe(1);
    expect(s.h.lastText()).toBe("🕒 <b>Часовой пояс</b>\nВыберите строку с вашим текущим временем.");
    expect(buttons(s.h.lastMarkup())).toEqual(ZONES_RU);
    expect((s.h.lastMarkup().inline_keyboard ?? []).map((row) => row.length)).toEqual([2, 2, 2, 2, 2, 1, 1]);
  });

  it("a tap on a zone stores it, moves the daily and the evening reminder to the new clock and shows the settings again", async () => {
    const s = await session();
    expect(s.user).toMatchObject({ tzOffsetMin: 180, nextDailyAt: T + 24 * HOUR, nextEveningAt: T + 11 * HOUR });
    await s.text("/settings");
    await s.press("set:tz");
    const u = await s.press("tz:300");
    expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(u.d1).toBe(4);
    // At UTC+5 it is 11:00: 09:00 comes in 22 hours, 20:00 in 9.
    expect(await s.repo.getUser(s.user.id)).toEqual({ ...s.user, tzOffsetMin: 300, nextDailyAt: T + 22 * HOUR, nextEveningAt: T + 9 * HOUR });
    expect(s.h.lastText()).toBe(ru.settingsTitle);
    expect(buttons(s.h.lastMarkup())).toEqual(SETTINGS_RU.map(([text, data]) => [data === "set:tz" ? "🕒 Часовой пояс: UTC+5" : text, data]));
    await s.press("set:tz");
    expect(buttons(s.h.lastMarkup()).filter(([text]) => text!.startsWith("✅"))).toEqual([["✅ 11:00 · UTC+5", "tz:300"]]);
  });

  it("«Готово» of the zones goes back to the settings and changes nothing", async () => {
    const s = await session();
    await s.text("/settings");
    await s.press("set:tz");
    const u = await s.press("set:back");
    expect(u.methods).toEqual(["editMessageText", "answerCallbackQuery"]);
    expect(u.d1).toBe(1);
    expect(buttons(s.h.lastMarkup())).toEqual(SETTINGS_RU);
    expect(await s.repo.getUser(s.user.id)).toEqual(s.user);
  });

  it("a zone that is not among the buttons is not stored: the tap is answered like a stale button", async () => {
    const s = await session();
    for (const data of ["tz:150", "tz:060", "tz:780"]) {
      const u = await s.press(data);
      expect(u.calls.map((c) => [c.method, c.payload.text]), data).toEqual([["answerCallbackQuery", ru.staleButton]]);
    }
    expect(await s.repo.getUser(s.user.id)).toEqual(s.user);
  });

  it("a learner whose zone is not a whole hour between UTC+2 and UTC+12 sees it named in the settings and no zone marked", () => {
    const user = { lang: "ru", retention: 0.9, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 330, direction: "tt_ru", autoplay: false } as User;
    expect(renderSettings(user).keyboard.flat().map((b) => b.text)[4]).toBe("🕒 Часовой пояс: UTC+5:30");
    const zones = renderTimeZones(T + 35 * 60_000, 330, "tt");
    expect(zones.text).toBe(tt.tzText);
    expect(zones.keyboard.flat().map((b) => b.text)).toEqual([
      "08:35 · UTC+2", "09:35 · UTC+3", "10:35 · UTC+4", "11:35 · UTC+5", "12:35 · UTC+6", "13:35 · UTC+7", "14:35 · UTC+8", "15:35 · UTC+9", "16:35 · UTC+10", "17:35 · UTC+11", "18:35 · UTC+12", "Әзер",
    ]);
  });

  it("the row of the levels sends the hub as a new message and leaves the settings where they are", async () => {
    await seedTopics(env.DB);
    await seedCatalog(env.DB, [{ level: 1, word: "әни", topic: 2 }]);
    const s = await session();
    await s.text("/settings");
    const u = await s.press("set:hub");
    expect(u.methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(u.d1).toBe(2);
    expect(s.h.lastText()).toBe(["📚 <b>Уровни</b>", "☑ A1 · 0 из 1 (будет 500)", "☐ A2 · скоро", "☐ B1 · скоро", "☐ B2 · скоро", "☐ C1 · скоро", "", "🧭 Бот ведёт по темам · сейчас «Семья и близкие»: 0 из 1"].join("\n"));
    expect(buttons(s.h.lastMarkup()).map(([, data]) => data)).toEqual(["hub:lv", "hub:pos", "hub:mode", "hub:tp", "learn"]);
  });
});

describe("a change of the time zone and the streak", () => {
  /** 00:30 UTC on 30 September: 03:30 at UTC+3, before the day changes at 04:00, and 05:30 at UTC+5, after it. */
  const NIGHT = Date.UTC(2026, 8, 30, 0, 30);
  const MIN = 60_000;
  const good = (h: ReturnType<typeof harness>) => (h.lastMarkup().inline_keyboard ?? []).flat().map((b) => b.callback_data).find((c) => /^g:\d+:\d+:3$/.test(c))!;

  /** A learner (Telegram id 42) at `tzOffsetMin` with a streak of 7 days up to `lastStudyDay`, who grades one card at NIGHT. */
  async function studiedTonight(tzOffsetMin: number, lastStudyDay: string) {
    await seedCatalog(env.DB, ["китап", "вакыт", "авыл"].map((word) => ({ level: 1, word })));
    const { repo, user } = await seedLearner(env.DB, { now: NIGHT, tgId: 42, patch: { tzOffsetMin, streak: 7, lastStudyDay } });
    const h = harness(env.DB, { now: NIGHT });
    await h.text("/learn");
    await h.press(good(h), h.tg.lastMessageId());
    const streak = async () => { const u = (await repo.getUser(user.id))!; return { streak: u.streak, lastStudyDay: u.lastStudyDay }; };
    const reviews = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log WHERE user_id = ?").bind(user.id).first<{ n: number }>())!.n;
    expect(await reviews()).toBe(1);
    /** The zone is changed a minute later, and the card on the screen is graded a minute after that. Gives the streak as the change left it. */
    const moveAndGrade = async (offset: number) => {
      const card = h.tg.lastMessageId(), button = good(h);
      h.setNow(NIGHT + MIN);
      await h.press(`tz:${offset}`, 900);
      const moved = await streak();
      h.setNow(NIGHT + 2 * MIN);
      await h.press(button, card);
      expect(await reviews()).toBe(2);
      return moved;
    };
    return { streak, moveAndGrade };
  }

  it("the clock moved back across the start of the day: the day of the last study, which would lie ahead of today, becomes today, and the next grade keeps the streak", async () => {
    // At UTC+5 it is already 30 September; at UTC+3 it is still the 29th.
    const s = await studiedTonight(300, "2026-09-29");
    expect(await s.streak()).toEqual({ streak: 8, lastStudyDay: "2026-09-30" });
    expect(await s.moveAndGrade(180)).toEqual({ streak: 8, lastStudyDay: "2026-09-29" });
    expect(await s.streak()).toEqual({ streak: 8, lastStudyDay: "2026-09-29" });
  });

  it("the clock moved forward across the start of the day: the day of the last study stays and is yesterday, so the next grade goes on with the streak", async () => {
    // At UTC+3 it is still 29 September; at UTC+5 it is already the 30th.
    const s = await studiedTonight(180, "2026-09-28");
    expect(await s.streak()).toEqual({ streak: 8, lastStudyDay: "2026-09-29" });
    expect(await s.moveAndGrade(300)).toEqual({ streak: 8, lastStudyDay: "2026-09-29" });
    expect(await s.streak()).toEqual({ streak: 9, lastStudyDay: "2026-09-30" });
  });

  it("a change inside one day, and a learner who never studied: the day of the last study is left as it is", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { streak: 3, lastStudyDay: "2026-09-30" } });
    await setSetting(repo, user.id, "tzOffsetMin", 120, T);
    expect(await repo.getUser(user.id)).toMatchObject({ tzOffsetMin: 120, streak: 3, lastStudyDay: "2026-09-30" });
    await repo.updateUser(user.id, { lastStudyDay: null, streak: 0 });
    await setSetting(repo, user.id, "tzOffsetMin", 720, T);
    expect(await repo.getUser(user.id)).toMatchObject({ tzOffsetMin: 720, streak: 0, lastStudyDay: null });
    // Another setting never touches it, whatever the clock.
    await repo.updateUser(user.id, { lastStudyDay: "2026-10-05" });
    await setSetting(repo, user.id, "remindAt", "21:00", T);
    expect((await repo.getUser(user.id))!.lastStudyDay).toBe("2026-10-05");
  });
});

describe("setSetting: the time zone", () => {
  it("takes the offsets of the buttons, 120 … 720 by the hour, and nothing else", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T });
    expect(TZ_OFFSETS).toEqual([120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720]);
    for (const bad of [0, 60, 150, 780, -180, "300", null]) await expect(setSetting(repo, user.id, "tzOffsetMin", bad, T)).rejects.toThrow("invalid tzOffsetMin");
    expect(await repo.getUser(user.id)).toEqual(user);
  });

  it("moves both reminders to the learner's hour on the new clock", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { remindAt: "21:00" } });
    await setSetting(repo, user.id, "tzOffsetMin", 720, T);
    // At UTC+12 it is 18:00.
    expect(await repo.getUser(user.id)).toEqual({ ...user, tzOffsetMin: 720, nextDailyAt: T + 3 * HOUR, nextEveningAt: T + 2 * HOUR });
    expect(nextOccurrence(720, "21:00", T)).toBe(T + 3 * HOUR);
  });
});
