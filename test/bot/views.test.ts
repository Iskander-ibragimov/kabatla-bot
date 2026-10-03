import { describe, expect, it } from "vitest";
import { renderGenPreview, renderOnboarding, renderSettings } from "../../src/bot/screens";
import { formatLong, renderAddPreview, renderCard, renderDone, type CardView, type PreviewItem } from "../../src/bot/views";
import type { User } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { newMem } from "../../src/srs/fsrs";

const T = Date.UTC(2026, 8, 30, 6);
const view = (over: Partial<CardView> = {}): CardView => ({
  cardId: 7, noteId: 3, reps: 3, direction: "tt_ru", word: "ышанычлы", transcription: "ышанычлы́", pos: "adj",
  translation: "надёжный", exampleTt: "Ул ышанычлы кеше.", exampleRu: "Он надёжный человек.", hasAudio: true, sourceUrl: null,
  mem: { ...newMem(T), state: "review", scheduledDays: 2, reps: 3, stability: 2, difficulty: 5, lastReview: T }, ...over,
});
const iv = { 1: "<10м", 2: "1д", 3: "2д", 4: "4д" } as const;
const counts = { n: 4, l: 1, r: 12 };

describe("views", () => {
  it("translation and example are inside tg-spoiler", () => {
    const { text } = renderCard(view(), counts, iv, false, "ru");
    expect(text).toContain("🔵 4 · 🔴 1 · 🟢 12");
    expect(text).toContain("<b>ышанычлы</b>\n[ышанычлы́] · <i>прил.</i>\n<tg-spoiler><b>надёжный</b></tg-spoiler>");
    expect(text).toContain("<blockquote><tg-spoiler><i>Ул ышанычлы кеше.</i>\nОн надёжный человек.</tg-spoiler></blockquote>");
  });

  it("keyboard is 2x2 with styles and short callbacks", () => {
    const { keyboard } = renderCard(view(), counts, iv, true, "ru");
    const grades = keyboard.slice(0, 2);
    expect(grades.map((r) => r.length)).toEqual([2, 2]);
    const flat = grades.flat();
    expect(flat.map((b) => b.style)).toEqual(["danger", undefined, "success", "primary"]);
    expect(flat.map((b) => b.callback_data)).toEqual(["g:7:3:1", "g:7:3:2", "g:7:3:3", "g:7:3:4"]);
    expect(flat.map((b) => b.text)).toEqual(["Снова <10м", "Трудно 1д", "Хорошо 2д", "Легко 4д"]);
    for (const b of flat) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    expect(keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "u", "r:3"]);
  });

  it("voice button only when audio exists; undo only when allowed", () => {
    expect(renderCard(view({ hasAudio: false }), counts, iv, false, "ru").keyboard[2]!.map((b) => b.callback_data)).toEqual(["r:3"]);
    expect(renderCard(view({ hasAudio: true }), counts, iv, true, "ru").keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "u", "r:3"]);
    expect(renderCard(view({ hasAudio: true }), counts, iv, false, "ru").keyboard[2]!.map((b) => b.text)).toEqual(["🔊", "⚑"]);
  });

  it("shows transcription in brackets and the part of speech in the interface language", () => {
    const r = renderCard(view({ word: "вакыт", transcription: "wакъы́т", pos: "n" }), counts, iv, false, "ru");
    expect(r.text).toContain("<b>вакыт</b>\n[wакъы́т] · <i>сущ.</i>");
    expect(renderCard(view({ pos: "n" }), counts, iv, false, "tt").text).toContain("<i>исем</i>");
  });

  it("leaves out the second line when there is neither transcription nor part of speech, and joins no dangling dot", () => {
    const none = renderCard(view({ transcription: null, pos: "" }), counts, iv, false, "ru").text;
    expect(none).toContain("<b>ышанычлы</b>\n<tg-spoiler>");
    expect(renderCard(view({ transcription: "ышанычлы́", pos: "" }), counts, iv, false, "ru").text).toContain("<b>ышанычлы</b>\n[ышанычлы́]\n<tg-spoiler>");
    const posOnly = renderCard(view({ transcription: null, pos: "v" }), counts, iv, false, "ru").text;
    expect(posOnly).toContain("<b>ышанычлы</b>\n<i>гл.</i>\n<tg-spoiler>");
    expect(posOnly).not.toContain("·  ");
    expect(renderCard(view({ transcription: null, pos: "Моя пометка" }), counts, iv, false, "ru").text).toContain("<i>Моя пометка</i>");
  });

  it("hides the word and transcription under the spoiler in ru→tt", () => {
    const r = renderCard(view({ direction: "ru_tt", word: "вакыт", transcription: "wакъы́т", translation: "время" }), counts, iv, false, "ru");
    expect(r.text).toContain("<b>время</b>\n<tg-spoiler><b>вакыт</b> [wакъы́т]</tg-spoiler>");
  });

  it("html in word is escaped", () => {
    const { text } = renderCard(view({ word: "<b>x&y" }), counts, iv, false, "tt");
    expect(text).toContain("&lt;b&gt;x&amp;y");
  });

  it("source link shows hostname", () => {
    const { text } = renderCard(view({ sourceUrl: "https://www.youtube.com/watch?v=1&t=2" }), counts, iv, false, "ru");
    expect(text).toContain('🔗 <a href="https://www.youtube.com/watch?v=1&amp;t=2">youtube.com</a>');
  });

  it("progress line shows stage, memory and review number", () => {
    const { text } = renderCard(view(), counts, iv, false, "ru");
    expect(text).toContain("🌿 Учу · память ~2 дн. · повтор №4");
  });

  it("card shows only the current word, nothing about the previous one", () => {
    const { text } = renderCard(view(), counts, iv, true, "ru");
    expect(text.split("\n")[1]).toBe("<b>ышанычлы</b>");
    expect(text).not.toContain("→");
  });

  it("ru to tt direction hides the Tatar word and its transcription", () => {
    const { text } = renderCard(view({ direction: "ru_tt" }), counts, iv, false, "ru");
    expect(text).toContain("<b>надёжный</b>\n<tg-spoiler><b>ышанычлы</b> [ышанычлы́]</tg-spoiler>");
  });

  it("done screen shows day and cumulative totals", () => {
    const { text, keyboard } = renderDone({ reviewsToday: 24, learnedToday: 3, totals: { learned: 37, known: 20, learning: 14, new: 429 }, nextLearningInMs: 480_000, streak: 5 }, "ru");
    expect(text.startsWith("✅")).toBe(true);
    expect(text).toContain("Сегодня: 24 повт. · +3 выучено");
    expect(text).toContain("Всего: 🏆 37 · 🌳 20 · 🌿 14 · 🌱 429");
    expect(text).toContain("через 8 мин");
    expect(text).toContain("🔥 Серия: 5 дн.");
    expect(keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([["➕ Добавить слова", "help:add"], ["📚 Уровни", "levels"]]);
  });

  const draft = (over: Partial<PreviewItem> = {}): PreviewItem =>
    ({ word: "чыдам", transcription: "чыда́м", pos: "adj", translation: "стойкий", exampleTt: "Балалар чыдам.", exampleRu: "Дети стойкие.", sourceUrl: null, ai: false, ...over });

  it("add preview shows the transcription in brackets, the part of speech by name, the link host and the actions", () => {
    const one = renderAddPreview([draft({ sourceUrl: "https://example.com/a" })], 5, "ru");
    expect(one.text).toBe("<b>чыдам</b>\n[чыда́м] · <i>прил.</i>\n\n<b>стойкий</b><blockquote><i>Балалар чыдам.</i>\nДети стойкие.</blockquote>\n🔗 example.com");
    expect(one.keyboard.flat().map((b) => b.callback_data)).toEqual(["add:ok:5", "add:edit:5", "add:no:5"]);
    expect(renderAddPreview([draft()], 5, "tt").text).toContain("[чыда́м] · <i>сыйфат</i>");
    expect(renderAddPreview([draft({ transcription: null })], 5, "ru").text).toContain("<b>чыдам</b>\n<i>прил.</i>\n\n");
    expect(renderAddPreview([draft({ pos: "" })], 5, "ru").text).toContain("<b>чыдам</b>\n[чыда́м]\n\n");
    expect(renderAddPreview([draft({ pos: "", transcription: null, exampleTt: "", exampleRu: "" })], 5, "ru").text).toBe("<b>чыдам</b>\n\n<b>стойкий</b>");
    const many = renderAddPreview([
      draft({ word: "су", transcription: null, pos: "", translation: "вода" }),
      draft({ word: "юл", transcription: "йул", pos: "n", translation: "дорога", sourceUrl: "https://x.org" }),
    ], 6, "tt");
    expect(many.text).toBe(`${tt.foundN(2)}\n• <b>су</b> — вода\n• <b>юл</b> [йул] · <i>исем</i> — дорога 🔗`);
    expect(many.keyboard.flat().map((b) => b.callback_data)).toEqual(["add:ok:6", "add:no:6"]);
  });

  it("add preview ends with the AI note when a card is from the AI", () => {
    expect(ru.aiNote).toContain("перевод сделан AI, проверьте");
    const one = renderAddPreview([draft({ ai: true, sourceUrl: "https://example.com/a" })], 5, "ru");
    expect(one.text.endsWith(`</blockquote>\n🔗 example.com\n${ru.aiNote}`)).toBe(true);
    expect(renderAddPreview([draft({ ai: true, exampleTt: "", exampleRu: "" })], 5, "ru").text.endsWith(`<b>стойкий</b>\n${ru.aiNote}`)).toBe(true);
    const many = renderAddPreview([draft(), draft({ word: "юл", ai: true })], 6, "ru");
    expect(many.text.endsWith(`— стойкий\n\n${ru.aiNote}`)).toBe(true);
    expect(renderAddPreview([draft(), draft({ word: "юл" })], 6, "ru").text).not.toContain(ru.aiNote);
    expect(renderAddPreview([draft()], 5, "ru").text).not.toContain(ru.aiNote);
    expect(renderAddPreview([draft({ ai: true })], 5, "tt").text.endsWith(`\n${tt.aiNote}`)).toBe(true);
  });

  it("add preview escapes what the user and the AI wrote", () => {
    const evil = draft({ word: "<b>x&y", transcription: "<i>t", pos: "<u>", translation: "a<i>b", exampleTt: "<u>q", exampleRu: "r&s", sourceUrl: "https://e.com/?a=<b>", ai: true });
    for (const text of [renderAddPreview([evil], 1, "ru").text, renderAddPreview([evil, evil], 1, "ru").text]) {
      expect(text).toContain("<b>&lt;b&gt;x&amp;y</b>");
      expect(text).toContain("[&lt;i&gt;t] · <i>&lt;u&gt;</i>");
      expect(text).toContain("a&lt;i&gt;b");
      expect(text).not.toMatch(/<u>|<i>t|<b>x/);
    }
    expect(renderAddPreview([evil], 1, "ru").text).toContain("<blockquote><i>&lt;u&gt;q</i>\nr&amp;s</blockquote>");
  });

  it("gen preview lists the words with transcription and part of speech and ends with the AI note", () => {
    const items = [
      draft({ word: "сәяхәт", transcription: "сәйәхә́т", pos: "n", translation: "путешествие", ai: true }),
      draft({ word: "бару", transcription: null, pos: "", translation: "идти", ai: true }),
    ];
    const r = renderGenPreview("в <гостях>", items, 2, 9, "ru");
    expect(r.text).toBe([
      ru.genTitle("в &lt;гостях&gt;", 2), "",
      "• <b>сәяхәт</b> [сәйәхә́т] · <i>сущ.</i> — путешествие",
      "• <b>бару</b> — идти",
      "", ru.genLeft(2), ru.aiNote,
    ].join("\n"));
    expect(r.keyboard.flat().map((b) => b.callback_data)).toEqual(["gen:ok:9", "gen:no:9"]);
    const inTatar = renderGenPreview("сәяхәт", items, 2, 9, "tt").text;
    expect(inTatar).toContain("[сәйәхә́т] · <i>исем</i>");
    expect(inTatar.endsWith(`\n${tt.aiNote}`)).toBe(true);
    const evil = renderGenPreview("x", [draft({ word: "<b>x", transcription: "<i>t", pos: "<u>", translation: "a&b", ai: true })], 1, 9, "ru").text;
    expect(evil).toContain("• <b>&lt;b&gt;x</b> [&lt;i&gt;t] · <i>&lt;u&gt;</i> — a&amp;b");
  });

  it("ru and tt have the same keys, of the same kind", () => {
    expect(tt).not.toBe(ru);
    expect(Object.keys(tt).sort()).toEqual(Object.keys(ru).sort());
    const kind = (d: Record<string, unknown>) => Object.entries(d).map(([k, v]) => `${k}:${typeof v === "function" ? `fn/${v.length}` : typeof v}`).sort();
    expect(kind(tt)).toEqual(kind(ru));
  });

  it("card buttons, progress line and done screen are in Tatar for a tt user", () => {
    const card = renderCard(view(), counts, { 1: "<10мин", 2: "1көн", 3: "2көн", 4: "4көн" }, true, "tt");
    expect(card.keyboard.slice(0, 2).flat().map((b) => b.text)).toEqual(["Яңадан <10мин", "Авыр 1көн", "Яхшы 2көн", "Җиңел 4көн"]);
    expect(card.keyboard[2]!.map((b) => b.text)).toEqual(["🔊", "↩️ Кире алу", "⚑"]);
    expect(card.text).toContain("🌿 Өйрәнәм · хәтердә ~2 көн · кабатлау №4");
    const done = renderDone({ reviewsToday: 24, learnedToday: 3, totals: { learned: 37, known: 20, learning: 14, new: 429 }, nextLearningInMs: 480_000, streak: 5 }, "tt");
    expect(done.text).toContain("Бүген: 24 кабатлау · +3 өйрәнелде");
    expect(done.text).toContain("Барлыгы: 🏆 37 · 🌳 20 · 🌿 14 · 🌱 429");
    expect(done.text).toContain("8 минут");
    expect(done.text).toContain("🔥 Рәттән 5 көн");
    expect(done.text).not.toMatch(/Сегодня|Всего|Серия/);
  });

  it("long intervals use Tatar units for a tt user", () => {
    expect([8 * 60_000, 3 * 3_600_000, 11 * 86_400_000, 36 * 86_400_000].map((ms) => formatLong(ms, "tt"))).toEqual(["8 минут", "3 сәгать", "11 көн", "1,2 ай"]);
    expect(formatLong(36 * 86_400_000, "ru")).toBe("1,2 мес.");
  });

  it("settings and the language choice name both languages in their own words", () => {
    const user = { lang: "ru", retention: 0.9, newPerDay: 10, remindAt: "09:00", direction: "tt_ru", autoplay: false } as User;
    const labels = (u: User) => renderSettings(u).keyboard.flat().map((b) => b.text);
    expect(labels(user)).toEqual(["🌐 Язык: Русский", "🎯 Режим: Оптимальный · 90%", "🆕 Новых в день: 10", "⏰ Напоминание: 09:00", "↔️ Направление: татарский → русский", "🔊 Автоозвучка: выкл"]);
    expect(labels({ ...user, lang: "tt", direction: "ru_tt" })).toEqual(["🌐 Тел: Татарча", "🎯 Режим: Оптималь · 90%", "🆕 Көненә яңа сүзләр: 10", "⏰ Искә төшерү: 09:00", "↔️ Юнәлеш: русча → татарча", "🔊 Автомат тавыш: сүндерелгән"]);
    expect(renderSettings({ ...user, lang: "tt" }).text).toContain("Көйләүләр");
    for (const lang of ["ru", "tt"] as const) {
      expect(renderOnboarding({ kind: "lang" }, lang).keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([["Русский", "ob:ru"], ["Татарча", "ob:tt"]]);
    }
  });
});
