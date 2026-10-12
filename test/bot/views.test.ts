import { describe, expect, it } from "vitest";
import { renderGenPreview, renderOnboarding, renderSettings } from "../../src/bot/screens";
import { addReplyText, clip, gradeRows, progressLine, renderAddPreview, renderCard, renderDone, shownWords, type CardView, type PreviewItem } from "../../src/bot/views";
import type { User } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { tt } from "../../src/i18n/tt";
import { newMem } from "../../src/srs/ladder";
import { TELEGRAM_TEXT_LIMIT, visibleLength } from "../helpers/visible";

const T = Date.UTC(2026, 8, 30, 6);
const view = (over: Partial<CardView> = {}): CardView => ({
  cardId: 7, noteId: 3, reps: 3, direction: "tt_ru", word: "ышанычлы", transcription: "ышанычлы́", pos: "adj",
  translation: "надёжный", exampleTt: "Ул ышанычлы кеше.", exampleRu: "Он надёжный человек.", hasAudio: true, sourceUrl: null, gloss: null,
  mem: { ...newMem(T), state: "review", scheduledDays: 3, reps: 3, lastReview: T }, ...over,
});
/** What the buttons of a card on the 3-day rung say. */
const iv = { 1: "1 минута", 2: "3 дня", 3: "7 дней", 4: "14 дней" } as const;
const counts = { n: 4, l: 1, r: 12 };

describe("views", () => {
  describe("«🔎 Разбор» (spec B4)", () => {
    const GLOSS: CardView["gloss"] = [["Мин", "мин", "я", "A1"], ["китабымны", "китап", "мою книгу", "A1"], ["укыйм", "уку", "(я) читаю", null], ["кичен", "кич", "вечером", null]];
    const glossed = (over: Partial<CardView> = {}) => view({ word: "уку", exampleTt: "Мин китабымны кичен укыйм.", exampleRu: "Я читаю свою книгу вечером.", gloss: GLOSS, ...over });

    it("a card with a breakdown has «🔎 Разбор» in the row of 🔊 ↩ ⚑, before ⚑; a card without one has no such button", () => {
      expect(renderCard(glossed(), counts, iv, true, "ru").keyboard[2]!.map((b) => [b.text, b.callback_data])).toEqual([
        ["🔊", "v:3"], [ru.undo, "u"], [ru.glossBtn, "gl:7:3:1:1"], ["⚑", "r:3"],
      ]);
      expect(renderCard(glossed({ hasAudio: false }), counts, iv, false, "tt").keyboard[2]!.map((b) => [b.text, b.callback_data])).toEqual([
        [tt.glossBtn, "gl:7:3:1:0"], ["⚑", "r:3"],
      ]);
      expect(renderCard(view(), counts, iv, true, "ru").keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "u", "r:3"]);
      expect(renderCard(glossed(), counts, iv, true, "ru").text).not.toContain("→");
    });

    it("open: the breakdown stands under the example, all of it in a spoiler; the card's word is bold, a catalog lemma has its level", () => {
      const r = renderCard(glossed(), counts, iv, false, "ru", "", true);
      expect(r.text).toContain(
        "<i>Мин китабымны кичен укыйм.</i>\nЯ читаю свою книгу вечером.</tg-spoiler></blockquote>" +
          "<blockquote><tg-spoiler>Мин → мин (A1) — я\nкитабымны → китап (A1) — мою книгу\n<b>укыйм → уку</b> — (я) читаю\nкичен → кич — вечером</tg-spoiler></blockquote>",
      );
      expect(r.keyboard[2]!.map((b) => [b.text, b.callback_data])).toEqual([["🔊", "v:3"], [ru.glossHideBtn, "gl:7:3:0:0"], ["⚑", "r:3"]]);
      // Open without a breakdown: as closed.
      expect(renderCard(view(), counts, iv, false, "ru", "", true)).toEqual(renderCard(view(), counts, iv, false, "ru"));
    });

    it("a breakdown too long for one message loses its last lines first, then ends with «…»; the example and the word stay whole", () => {
      const many: CardView["gloss"] = Array.from({ length: 200 }, (_, i) => [`сүз${i}`, `сүз${i}`, "я".repeat(40), i % 2 ? "B1" : null]);
      const example = "Мин китабымны кичен укыйм. ".repeat(20).trim();
      const text = renderCard(glossed({ gloss: many, exampleTt: example }), counts, iv, true, "ru", "", true).text;
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(text).toContain(`<i>${example}</i>`);
      expect(text).toContain("<b>уку</b>");
      const block = text.match(/<blockquote><tg-spoiler>(сүз0[^]*?)<\/tg-spoiler><\/blockquote>/)![1]!.split("\n");
      expect(block.at(-1)).toBe("…");
      expect(block.length).toBeGreaterThan(20);
      expect(block.at(-2)).toMatch(new RegExp(`^сүз${block.length - 2} → `));
    });

    it("a breakdown that cannot fit at all is left out, and the card is shortened as before", () => {
      const text = renderCard(glossed({ gloss: [["сүз", "сүз", "я".repeat(40), null]], exampleTt: "ә".repeat(5000), exampleRu: "я".repeat(5000) }), counts, iv, true, "ru", "", true).text;
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(text).not.toContain("→");
      expect(text).toMatch(/<i>ә+…<\/i>/);
    });

    it("text in the breakdown is escaped", () => {
      const text = renderCard(glossed({ gloss: [["a<b", "c&d", "<i>x</i> & y", null]] }), counts, iv, false, "ru", "", true).text;
      expect(text).toContain("a&lt;b → c&amp;d — &lt;i&gt;x&lt;/i&gt; &amp; y");
    });
  });

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
    expect(flat.map((b) => b.text)).toEqual(["Снова · 1 минута", "Трудно · 3 дня", "Хорошо · 7 дней", "Легко · 14 дней"]);
    for (const b of flat) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    expect(keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "u", "r:3"]);
  });

  it("the grade rows of a card are what `gradeRows` builds with no button tried, byte for byte; a tried button has «✅» in place of the dot and is no longer", () => {
    const data = (r: number) => `g:7:3:${r}`;
    const real = renderCard(view(), counts, iv, true, "ru").keyboard.slice(0, 2);
    expect(JSON.stringify(gradeRows(iv, data, "ru"))).toBe(JSON.stringify(real));
    expect(JSON.stringify(gradeRows(iv, data, "ru", () => false))).toBe(JSON.stringify(real));
    expect(JSON.stringify(real)).toBe(JSON.stringify([
      [{ text: "Снова · 1 минута", callback_data: "g:7:3:1", style: "danger" }, { text: "Трудно · 3 дня", callback_data: "g:7:3:2" }],
      [{ text: "Хорошо · 7 дней", callback_data: "g:7:3:3", style: "success" }, { text: "Легко · 14 дней", callback_data: "g:7:3:4", style: "primary" }],
    ]));
    // The practice card marks the buttons the learner has tried.
    const marked = gradeRows(iv, data, "ru", (r) => r === 1 || r === 3).flat();
    expect(marked.map((b) => b.text)).toEqual(["Снова ✅ 1 минута", "Трудно · 3 дня", "Хорошо ✅ 7 дней", "Легко · 14 дней"]);
    expect(marked.map((b) => b.text.length)).toEqual(real.flat().map((b) => b.text.length));
    expect(marked.map((b) => [b.callback_data, b.style])).toEqual(real.flat().map((b) => [b.callback_data, b.style]));
    expect(gradeRows({ 1: "1 минут", 2: "5 минут", 3: "10 минут", 4: "1 көн" }, data, "tt", () => true).flat().map((b) => b.text)).toEqual(["Яңадан ✅ 1 минут", "Авыр ✅ 5 минут", "Яхшы ✅ 10 минут", "Җиңел ✅ 1 көн"]);
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

  it("progress line shows stage, rung and review number; a new word has its stage alone", () => {
    const { text } = renderCard(view(), counts, iv, false, "ru");
    expect(text.split("</blockquote>")[1]).toBe("🌿 Учу · ступень 4 из 10 · повтор №4");
    const line = (mem: Partial<CardView["mem"]>, lang: "ru" | "tt" = "ru") => progressLine({ ...newMem(T), ...mem }, lang);
    expect(line({})).toBe("🌱 Новое");
    expect(line({}, "tt")).toBe("🌱 Яңа");
    // The minute rungs, also of a word that fell from a day rung; then the day rungs with their stages.
    expect(line({ state: "learning", step: 0, reps: 1 })).toBe("🌿 Учу · ступень 1 из 10 · повтор №2");
    expect(line({ state: "relearning", step: 1, reps: 7, lapses: 1 })).toBe("🌿 Учу · ступень 2 из 10 · повтор №8");
    expect(line({ state: "review", scheduledDays: 1, reps: 2 })).toBe("🌿 Учу · ступень 3 из 10 · повтор №3");
    expect(line({ state: "review", scheduledDays: 7, reps: 4 })).toBe("🌳 Знаю · ступень 5 из 10 · повтор №5");
    expect(line({ state: "review", scheduledDays: 30, reps: 6 })).toBe("🏆 Выучено · ступень 7 из 10 · повтор №7");
    expect(line({ state: "review", scheduledDays: 180, reps: 9 }, "tt")).toBe("🏆 Өйрәндем · баскыч 10/10 · кабатлау №10");
    // A card of the old scheduler: 46 days is the 30-day rung.
    expect(line({ state: "review", scheduledDays: 46, stability: 46.3, difficulty: 5.1, reps: 5 })).toBe("🏆 Выучено · ступень 7 из 10 · повтор №6");
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

  it("done screen shows the day, the next learning card and the streak; the totals for all time are not on it", () => {
    const { text, keyboard } = renderDone({ reviewsToday: 24, learnedToday: 3, postponedToday: 0, nextLearningInMs: 480_000, streak: 5 }, "ru", null);
    expect(text.startsWith("✅")).toBe(true);
    expect(text).toContain("Сегодня: 24 повт. · +3 выучено");
    expect(text).not.toContain("Всего:");
    expect(text.split("\n")).toHaveLength(5);
    expect(text.split("\n")[3]).toBe("Карточки на закреплении вернутся через 8 минут. Я напомню.");
    expect(text).toContain("🔥 Серия: 5 дн.");
    expect(keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([["➕ Добавить слова", "help:add"], ["📚 Уровни", "levels"]]);
  });

  it("done screen says how many hard words went to tomorrow, and nothing when none did", () => {
    const s = { reviewsToday: 24, learnedToday: 3, nextLearningInMs: null, streak: 5 };
    const two = renderDone({ ...s, postponedToday: 2 }, "ru", null).text;
    expect(two).toContain(`\n\n${ru.donePostponed(2)}`);
    expect(two).toContain("Трудные слова отложены на завтра: 2 — после сна они запоминаются лучше.");
    expect(renderDone({ ...s, postponedToday: 2 }, "tt", null).text).toContain(tt.donePostponed(2));
    expect(renderDone({ ...s, postponedToday: 0 }, "ru", null).text).not.toContain("отложены");
  });

  describe("done screen when no new word came although the day allows more", () => {
    const summary = { reviewsToday: 24, learnedToday: 3, postponedToday: 0, nextLearningInMs: 480_000, streak: 5 };
    const plain = renderDone(summary, "ru", null);
    const done = (empty: Parameters<typeof renderDone>[2], lang: "ru" | "tt" = "ru") => {
      const r = renderDone(summary, lang, empty);
      return { last: r.text.split("\n").slice(-2), rows: r.keyboard.map((row) => row.map((b) => [b.text, b.callback_data])), text: r.text };
    };
    const BELOW = [["➕ Добавить слова", "help:add"], ["📚 Уровни", "levels"]];

    it("says why in its last line, after an empty one, and puts the button that mends it above the other two", () => {
      expect(done({ kind: "pickTopic", chosen: true })).toEqual({
        text: `${plain.text}\n\nНовых слов по вашим настройкам нет: тема закончилась.`,
        last: ["", "Новых слов по вашим настройкам нет: тема закончилась."], rows: [[["Выбрать тему", "fix:topic"]], BELOW],
      });
      // With no topic chosen the line says that; the button is the same.
      expect(done({ kind: "pickTopic", chosen: false })).toMatchObject({
        last: ["", "Новых слов по вашим настройкам нет: тема не выбрана."], rows: [[["Выбрать тему", "fix:topic"]], BELOW],
      });
      expect(done({ kind: "allPos" })).toMatchObject({
        last: ["", "Новых слов по вашим настройкам нет: в отмеченных частях речи слова кончились."], rows: [[["Включить все части речи", "fix:pos"]], BELOW],
      });
      expect(done({ kind: "addLevel", level: 2 })).toMatchObject({
        last: ["", "Новых слов по вашим настройкам нет: отмеченные уровни пройдены."], rows: [[["Добавить уровень A2", "fix:lv:2"]], BELOW],
      });
      expect(done({ kind: "addLevel", level: 5 }).rows[0]).toEqual([["Добавить уровень C1", "fix:lv:5"]]);
    });

    it("says that every word of the catalog is in work, with no button to add", () => {
      expect(done({ kind: "allDone" })).toMatchObject({ last: ["", "Все слова каталога в работе 🎉"], rows: [BELOW] });
    });

    it("is in Tatar for a tt user", () => {
      expect(done({ kind: "pickTopic", chosen: false }, "tt")).toMatchObject({ last: ["", "Көйләүләрегез буенча яңа сүзләр юк: тема сайланмаган."] });
      expect(done({ kind: "pickTopic", chosen: true }, "tt")).toMatchObject({ last: ["", "Көйләүләрегез буенча яңа сүзләр юк: тема бетте."], rows: [[["Тема сайлау", "fix:topic"]], [["➕ Сүз өстәү", "help:add"], ["📚 Дәрәҗәләр", "levels"]]] });
      expect(done({ kind: "allPos" }, "tt")).toMatchObject({ last: ["", "Көйләүләрегез буенча яңа сүзләр юк: билгеләнгән сүз төркемнәрендә сүзләр бетте."] });
      expect(done({ kind: "allPos" }, "tt").rows[0]).toEqual([["Барлык сүз төркемнәрен кабызу", "fix:pos"]]);
      expect(done({ kind: "addLevel", level: 3 }, "tt")).toMatchObject({ last: ["", "Көйләүләрегез буенча яңа сүзләр юк: билгеләнгән дәрәҗәләр үтелде."] });
      expect(done({ kind: "addLevel", level: 3 }, "tt").rows[0]).toEqual([["B1 дәрәҗәсен өстәү", "fix:lv:3"]]);
      expect(done({ kind: "allDone" }, "tt").last).toEqual(["", "Каталогтагы барлык сүзләр дә өйрәнелә 🎉"]);
    });
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

  it("clip cuts a text to the length with an ellipsis and leaves a shorter one alone", () => {
    expect(clip("рәхмәт", 6)).toBe("рәхмәт");
    expect(clip("рәхмәт", 5)).toBe("рәхм…");
    expect(clip("зур рәхмәт", 5)).toBe("зур…");
    expect(clip("", 5)).toBe("");
    // Half of an emoji is not left at the cut.
    expect(clip("аб😀вг", 4)).toBe("аб…");
    for (const s of ["ә".repeat(500), "😀".repeat(50), "a b ".repeat(50)]) for (const max of [2, 7, 30]) expect(clip(s, max).length).toBeLessThanOrEqual(max);
  });

  it("a list preview is shown whole when the message fits: long phrases, transcriptions and translations are not cut", () => {
    // Two phrases of 80 characters that begin alike, each with a long transcription and a three-variant translation.
    const common = "мин бүген иртән бик иртә тордым һәм эшкә киттем, ә аннары "; // 58 characters
    const a = draft({ word: `${common}өйгә кайттым һәм яттым`, transcription: `${"ә".repeat(90)} а`, translation: "я сегодня встал очень рано, пошёл на работу, потом домой", pos: "phr", ai: true });
    const b = draft({ word: `${common}паркта бераз йөрдем дә`, transcription: `${"ә".repeat(90)} б`, translation: "я сегодня встал очень рано, пошёл на работу, потом в магазин", pos: "phr", ai: true });
    expect([a.word.length, b.word.length]).toEqual([80, 80]);
    const text = renderAddPreview([a, b], 1, "ru").text;
    expect(text).toBe([
      ru.foundN(2),
      `• <b>${a.word}</b> [${a.transcription}] · <i>фраза</i> — ${a.translation}`,
      `• <b>${b.word}</b> [${b.transcription}] · <i>фраза</i> — ${b.translation}`,
      "", ru.aiNote,
    ].join("\n"));
    expect(text).not.toContain("…");
    expect(renderGenPreview("тема", [a, b], 1, 1, "ru").text.split("\n").slice(2, 4)).toEqual(text.split("\n").slice(1, 3));
  });

  it("a list of 20 ordinary phrases is shown whole", () => {
    const items = Array.from({ length: 20 }, (_, i) => draft({
      word: `бүген һава бик яхшы булыр кебек ${i}`, transcription: `бүге́н һаwа́ бик йахшы́ булы́р кебе́к ${i}`, translation: `похоже, сегодня будет очень хорошая погода ${i}`, pos: "phr", ai: true,
      sourceUrl: "https://example.com/a",
    }));
    const text = renderAddPreview(items, 1, "ru").text;
    expect(visibleLength(text)).toBeGreaterThan(2500);
    expect(text).not.toContain("…");
    for (const i of items) expect(text).toContain(`• <b>${i.word}</b> [${i.transcription}] · <i>фраза</i> — ${i.translation} 🔗`);
  });

  describe("a list that does not fit one message is shortened step by step", () => {
    const words = (text: string) => [...text.matchAll(/• <b>(.*?)<\/b>/g)].map((m) => m[1]!);
    const translations = (text: string) => text.split("\n").filter((l) => l.startsWith("• ")).map((l) => l.slice(l.lastIndexOf(" — ") + 3));
    const item = (i: number, wordLength: number, translationLength: number): PreviewItem => {
      const no = String(i).padStart(2, "0");
      return draft({ word: `${"ә".repeat(wordLength - 3)} ${no}`, transcription: `${"ө".repeat(47)} ${no}`, translation: `${"я".repeat(translationLength - 3)} ${no}`, pos: "post", ai: true });
    };

    it("first the transcriptions go; words and translations stay whole", () => {
      const items = Array.from({ length: 30 }, (_, i) => item(i, 40, 40));
      const text = renderGenPreview("тема", items, 2, 1, "ru").text;
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(text).not.toContain("[");
      expect(text).not.toContain("…");
      expect(words(text)).toEqual(items.map((i) => i.word));
      expect(translations(text)).toEqual(items.map((i) => i.translation));
      // A shorter list of the same items fits as it is, and nothing is taken away.
      expect(renderGenPreview("тема", items.slice(0, 26), 2, 1, "ru").text.split("\n")[2]).toBe(`• <b>${items[0]!.word}</b> [${items[0]!.transcription}] · <i>послелог</i> — ${items[0]!.translation}`);
    });

    it("then the translations are cut, the longest first; the words stay whole", () => {
      const items = Array.from({ length: 30 }, (_, i) => item(i, 40, i < 10 ? 200 : 30));
      const text = renderGenPreview("тема", items, 2, 1, "ru").text;
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(text).not.toContain("[");
      expect(words(text)).toEqual(items.map((i) => i.word));
      const shown = translations(text);
      expect(shown.slice(10)).toEqual(items.slice(10).map((i) => i.translation));
      for (const t of shown.slice(0, 10)) expect(t).toMatch(/^я+…$/);
      expect(new Set(shown.slice(0, 10).map((t) => t.length)).size).toBe(1);
      expect(shown[0]!.length).toBeGreaterThan(100);
      // As little is cut as the limit asks for: one character more for each of the ten would not fit.
      expect(visibleLength(text)).toBeGreaterThan(TELEGRAM_TEXT_LIMIT - 10);
    });

    it("the words are cut last, and no two different words look alike", () => {
      const items = Array.from({ length: 30 }, (_, i) => item(i, 80, 200));
      const text = renderGenPreview("т".repeat(100), items, 2, 1, "tt").text;
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(text).not.toContain("[");
      // The translations are already at their shortest.
      for (const t of translations(text)) expect(t).toHaveLength(40);
      const shown = words(text);
      // The phrases differ only in their last word: the cut is in the middle, so the end that tells them apart stays.
      expect(new Set(shown).size).toBe(30);
      shown.forEach((w, i) => { expect(w).toMatch(new RegExp(`^ә+…ә+ ${String(i).padStart(2, "0")}$`)); expect(w.length).toBeGreaterThanOrEqual(30); });
      expect(visibleLength(text)).toBeGreaterThan(TELEGRAM_TEXT_LIMIT - 30);
    });

    it("words that differ only in the middle get their number in the list", () => {
      const twin = (mid: string) => `${"ә".repeat(38)} ${mid} ${"ә".repeat(38)}`;
      expect(shownWords([twin("ак"), "китап", twin("ал"), twin("ак")], 30)).toEqual([
        `${"ә".repeat(13)}…${"ә".repeat(13)} №1`, "китап", `${"ә".repeat(13)}…${"ә".repeat(13)} №3`, `${"ә".repeat(13)}…${"ә".repeat(13)} №4`,
      ]);
      expect(shownWords([twin("ак"), twin("ал")], 80)).toEqual([twin("ак"), twin("ал")]);
      for (const max of [30, 31, 45, 79]) for (const w of shownWords([twin("ак"), twin("ал"), "ә".repeat(80)], max)) expect(w.length).toBeLessThanOrEqual(max);
      const items = Array.from({ length: 30 }, (_, i) => draft({ word: twin(String(i).padStart(2, "0")), translation: "я".repeat(200), pos: "post", ai: true }));
      const shown = words(renderGenPreview("т".repeat(100), items, 2, 1, "tt").text);
      expect(new Set(shown).size).toBe(30);
    });

    it("the lines about duplicates and untranslated words are whole when the message fits", () => {
      const long = "мин бүген иртән бик иртә тордым һәм эшкә киттем, ә аннары өйгә кайттым һәм яттым";
      const deck = `🤖 ${"т".repeat(100)}`;
      const text = addReplyText({
        kind: "preview", items: [draft({ ai: true }), draft({ word: "юл", ai: true })],
        duplicates: [{ word: long, deckTitle: deck, linkAdded: true }], manual: [`${long} тагын`],
      }, "ru");
      expect(text).toBe(`${ru.dupLine(long, deck, true)}\n\n${renderAddPreview([draft({ ai: true }), draft({ word: "юл", ai: true })], 1, "ru").text}\n\n${ru.notTranslated(`${long} тагын`)}`);
      expect(addReplyText({ kind: "duplicates-only", duplicates: [{ word: long, deckTitle: deck, linkAdded: false }] }, "tt")).toBe(tt.dupLine(long, deck, false));
      expect(addReplyText({ kind: "manual", word: long, others: [long + " ике"], duplicates: [] }, "ru")).toBe(`${ru.manualAsk(long)}\n\n${ru.notTranslated(long + " ике")}`);
    });
  });

  describe("previews at the field maxima fit one Telegram message", () => {
    // Every field as long as the schema and the input limits allow; «я» doubles in the transcription.
    // «post» and «pron» have the longest names of a part of speech in Russian and in Tatar.
    const worst = (i: number, pos = "post"): PreviewItem => ({
      word: `${"яя ".repeat(26)}${String(i).padStart(2, "0")}`, transcription: `${"йайа́ ".repeat(26)}${String(i).padStart(2, "0")}`, pos,
      translation: "я".repeat(200), exampleTt: "ә".repeat(300), exampleRu: "я".repeat(300), sourceUrl: `https://${"a".repeat(480)}.example/x`, ai: true,
    });
    const items = (n: number, lang: "ru" | "tt" = "ru") => Array.from({ length: n }, (_, i) => worst(i, lang === "ru" ? "post" : "pron"));
    const unclipped = (n: number) => items(n).reduce((sum, i) => sum + i.word.length + i.transcription!.length + i.translation.length, 0);

    it("uses the longest names of a part of speech", () => {
      const codes = ["n", "v", "adj", "adv", "pron", "num", "post", "conj", "part", "intj", "phr"];
      expect(Math.max(...codes.map((c) => ru.posName(c).length))).toBe(ru.posName("post").length);
      expect(Math.max(...codes.map((c) => tt.posName(c).length))).toBe(tt.posName("pron").length);
    });

    it.each(["ru", "tt"] as const)("add preview of 20 words, %s", (lang) => {
      expect(worst(0).word).toHaveLength(80);
      expect(unclipped(20)).toBeGreaterThan(TELEGRAM_TEXT_LIMIT);
      const text = renderAddPreview(items(20, lang), 1, lang).text;
      expect(text.split("\n")).toHaveLength(23);
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      // The 80-character phrases differ only in their last word and are still told apart; here the words fit whole.
      expect(new Set(text.split("\n").slice(1, 21)).size).toBe(20);
      for (const i of items(20, lang)) expect(text).toContain(`<b>${i.word}</b>`);
    });
    it.each(["ru", "tt"] as const)("deck preview of 30 words under a topic of 100 characters, %s", (lang) => {
      const text = renderGenPreview("т".repeat(100), items(30, lang), 3, 1, lang).text;
      expect(text.split("\n")).toHaveLength(35);
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      // The 80-character phrases differ only in their last word: every line still shows which one it is.
      const shown = [...text.matchAll(/• <b>(.*?)<\/b>/g)].map((m) => m[1]!);
      expect(new Set(shown).size).toBe(30);
      shown.forEach((w, i) => expect(w.endsWith(String(i).padStart(2, "0"))).toBe(true));
    });
    it.each(["ru", "tt"] as const)("a single card is never cut: at the field maxima it fits whole, %s", (lang) => {
      const [i] = items(1, lang) as [PreviewItem];
      const text = renderAddPreview([i], 1, lang).text;
      const t = lang === "ru" ? ru : tt;
      expect(text).toBe(
        `<b>${i.word}</b>\n[${i.transcription}] · <i>${t.posName(i.pos)}</i>\n\n<b>${i.translation}</b>` +
        `<blockquote><i>${i.exampleTt}</i>\n${i.exampleRu}</blockquote>\n🔗 ${"a".repeat(480)}.example\n${t.aiNote}`);
      expect(text).not.toContain("…");
      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    });
    it.each(["ru", "tt"] as const)("the card itself, %s", (lang) => {
      const w = worst(0);
      for (const direction of ["tt_ru", "ru_tt"] as const) {
        const text = renderCard(view({ ...w, direction, sourceUrl: `https://${"a".repeat(500)}.ex` }), counts, iv, true, lang).text;
        expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      }
    });
  });

  describe("a card whose fields are longer than a message (a note stored before the limits, an import)", () => {
    const fits = (text: string) => expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    const card = (over: Partial<CardView>, lead?: string, lang: "ru" | "tt" = "ru") => renderCard(view(over), counts, iv, true, lang, lead).text;
    const WORD = `${"ышанычлы ".repeat(30)}кеше`;
    // A line that stands before a card: its text is of no matter here, its length is.
    const LEAD = "Бот обновился: уровни A1–C1, темы и порядок слов — в /levels";

    it("an ordinary card is shown whole, and the lead line stands before it", () => {
      const plain = card({});
      expect(plain).not.toContain("…");
      expect(card({}, LEAD)).toBe(`${LEAD}\n\n${plain}`);
      expect(renderCard(view(), counts, iv, true, "ru").keyboard).toEqual(renderCard(view(), counts, iv, true, "ru", LEAD).keyboard);
    });

    it("shortens the example first: the word and the translation stay whole", () => {
      const translation = "надёжный ".repeat(40).trim();
      for (const direction of ["tt_ru", "ru_tt"] as const) {
        const text = card({ direction, word: WORD, translation, exampleTt: "ә".repeat(5000), exampleRu: "я".repeat(5000) }, LEAD);
        fits(text);
        expect(text).toContain(`<b>${WORD}</b>`);
        expect(text).toContain(`<b>${translation}</b>`);
        const [, tatar, russian] = text.match(/<blockquote><tg-spoiler><i>(ә+…)<\/i>\n(я+…)<\/tg-spoiler><\/blockquote>/)!;
        expect(tatar!.length).toBe(russian!.length);
        // As much of the example as the message has room for: one character more in each half would not fit.
        expect(visibleLength(text)).toBeGreaterThan(TELEGRAM_TEXT_LIMIT - 2);
      }
    });

    it("drops the example when even a short one would not fit, and only then shortens the translation", () => {
      const text = card({ word: WORD, translation: "я".repeat(9000), exampleTt: "ә".repeat(9000), exampleRu: "я".repeat(9000) }, LEAD);
      fits(text);
      expect(text).toContain(`<b>${WORD}</b>`);
      expect(text).not.toContain("<blockquote>");
      expect(text).not.toContain("ә");
      expect(text).toMatch(/<tg-spoiler><b>я+…<\/b><\/tg-spoiler>/);
      expect(visibleLength(text)).toBe(TELEGRAM_TEXT_LIMIT);
      // A long translation that fits once the example is shortened is not touched.
      const whole = card({ word: WORD, translation: "я".repeat(3000), exampleTt: "ә".repeat(9000), exampleRu: "я".repeat(9000) });
      fits(whole);
      expect(whole).toContain(`<b>${"я".repeat(3000)}</b>`);
      expect(whole).toMatch(/<blockquote><tg-spoiler><i>ә+…<\/i>\nя+…<\/tg-spoiler><\/blockquote>/);
    });

    it.each(["ru", "tt"] as const)("never shortens the word while anything else can go, both directions, %s", (lang) => {
      const word = "ә".repeat(3000);
      for (const direction of ["tt_ru", "ru_tt"] as const) {
        const text = card({ direction, word, transcription: "ә".repeat(3000), pos: "post", translation: "я".repeat(3000), exampleTt: "ә".repeat(3000), exampleRu: "я".repeat(3000), sourceUrl: `https://${"a".repeat(480)}.example/x` },
          LEAD, lang);
        fits(text);
        expect(text).toContain(`<b>${word}</b>`);
        expect(text).not.toContain("<blockquote>");
        // The transcription of such a word has no room; the translation is cut to what is left, never below 40 characters.
        expect(text).not.toContain("[");
        expect(text).not.toContain("<i>");
        const shown = text.match(/<b>(я+…)<\/b>/)![1]!;
        expect(shown.length).toBeGreaterThanOrEqual(40);
        expect(visibleLength(text)).toBe(TELEGRAM_TEXT_LIMIT);
        expect(text).toContain(`🔗 <a href="https://${"a".repeat(480)}.example/x">${"a".repeat(39)}…</a>`);
      }
    });

    it.each(["ru", "tt"] as const)("with the longest line under a card — the top rung and a six-digit review number — every way of shortening still ends within one message, %s", (lang) => {
      const line = lang === "ru" ? "🏆 Выучено · ступень 10 из 10 · повтор №100000" : "🏆 Өйрәндем · баскыч 10/10 · кабатлау №100000";
      const mem = { ...newMem(T), state: "review" as const, scheduledDays: 180, reps: 99_999, lastReview: T };
      const long = (over: Partial<CardView>) => card({ mem, reps: 99_999, transcription: "ә".repeat(300), pos: "post", ...over }, LEAD, lang);
      for (const direction of ["tt_ru", "ru_tt"] as const) {
        // The example is shortened; the example is dropped and the translation shortened; the word itself is cut.
        const shortened = long({ direction, word: WORD, translation: "надёжный", exampleTt: "ә".repeat(5000), exampleRu: "я".repeat(5000) });
        const dropped = long({ direction, word: WORD, translation: "я".repeat(9000), exampleTt: "ә".repeat(9000), exampleRu: "я".repeat(9000) });
        const cut = long({ direction, word: `башы${"ә".repeat(6000)}ахыры`, translation: "я".repeat(6000), exampleTt: "ә".repeat(6000), exampleRu: "я".repeat(6000) });
        expect(shortened).toMatch(/<i>ә+…<\/i>/);
        expect(dropped).not.toContain("<blockquote>");
        expect(dropped).toMatch(/<b>я+…<\/b>/);
        expect(cut).toMatch(/<b>башы[^<]*…[^<]*ахыры<\/b>/);
        for (const text of [shortened, dropped, cut]) {
          fits(text);
          // The line itself is never shortened, and the message is filled to the last character or the one before it.
          expect(text.endsWith(line)).toBe(true);
          expect(visibleLength(text)).toBeGreaterThan(TELEGRAM_TEXT_LIMIT - 2);
        }
      }
    });

    it("keeps at least 40 characters of the translation when the word leaves less room than that", () => {
      // Without the transcription the word fills the message up to 30 characters short of the limit.
      const bare = card({ word: "ә", transcription: null, pos: "", translation: "я", exampleTt: "", exampleRu: "" });
      const word = "ә".repeat(TELEGRAM_TEXT_LIMIT - visibleLength(bare) - 30);
      const text = card({ word, transcription: null, pos: "", translation: "я".repeat(500), exampleTt: "ә".repeat(500), exampleRu: "" });
      fits(text);
      // Now the word has to give way: it is cut in the middle so that 40 characters of the translation fit.
      expect(text).toContain(`<b>${"я".repeat(39)}…</b>`);
      expect(text).toMatch(/<b>ә+…ә+<\/b>/);
    });

    it("a word that alone is longer than a message is cut in the middle, as the last resort", () => {
      const word = `башы${"ә".repeat(6000)}ахыры`;
      for (const direction of ["tt_ru", "ru_tt"] as const) {
        const text = card({ direction, word, transcription: word, translation: "я".repeat(6000), exampleTt: "ә".repeat(6000), exampleRu: "я".repeat(6000) }, LEAD);
        fits(text);
        const shown = text.match(/<b>(башы[^<]*ахыры)<\/b>/)![1]!;
        expect(shown).toContain("…");
        expect(shown.length).toBeGreaterThan(3500);
        expect(visibleLength(text)).toBeGreaterThan(TELEGRAM_TEXT_LIMIT - 2);
      }
    });

    it("counts what Telegram counts: an escaped character is one character, and a cut never splits one", () => {
      const escaped = card({ translation: "<&>".repeat(3000), exampleTt: "", exampleRu: "" });
      fits(escaped);
      expect(visibleLength(escaped)).toBe(TELEGRAM_TEXT_LIMIT);
      expect(escaped).toContain(`<b>${"&lt;&amp;&gt;".repeat(1000)}`);
      expect(escaped).not.toMatch(/&(?!lt;|gt;|amp;|quot;)/);
      const emoji = card({ exampleTt: "😀".repeat(3000), exampleRu: "" });
      fits(emoji);
      expect(emoji).toMatch(/<i>(😀)+…<\/i>/u);
      expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
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
    const card = renderCard(view(), counts, { 1: "1 минут", 2: "3 көн", 3: "7 көн", 4: "14 көн" }, true, "tt");
    expect(card.keyboard.slice(0, 2).flat().map((b) => b.text)).toEqual(["Яңадан · 1 минут", "Авыр · 3 көн", "Яхшы · 7 көн", "Җиңел · 14 көн"]);
    expect(card.keyboard[2]!.map((b) => b.text)).toEqual(["🔊", "↩️ Кире алу", "⚑"]);
    expect(card.text).toContain("🌿 Өйрәнәм · баскыч 4/10 · кабатлау №4");
    const done = renderDone({ reviewsToday: 24, learnedToday: 3, postponedToday: 0, nextLearningInMs: 480_000, streak: 5 }, "tt", null);
    expect(done.text).toContain("Бүген: 24 кабатлау · +3 өйрәнелде");
    expect(done.text).not.toContain("Барлыгы:");
    expect(done.text).toContain("8 минут");
    expect(done.text).toContain("🔥 Рәттән 5 көн");
    expect(done.text).not.toMatch(/Сегодня|Всего|Серия/);
  });

  it("the done screen says when the next card comes in the words of the grade buttons, in the form the sentence asks for", () => {
    const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const next = (ms: number, lang: "ru" | "tt") => renderDone({ reviewsToday: 1, learnedToday: 0, postponedToday: 0, nextLearningInMs: ms, streak: 0 }, lang, null).text.split("\n")[3];
    // Russian: after «через» the minute is «минуту» for 1, 21, 31…; every other word is as on the button.
    expect([MIN + 1000, 2 * MIN, 5 * MIN, 10 * MIN, 21 * MIN, 3 * HOUR, DAY, 11 * DAY, 36 * DAY].map((ms) => next(ms, "ru"))).toEqual(
      ["1 минуту", "2 минуты", "5 минут", "10 минут", "21 минуту", "3 часа", "1 день", "11 дней", "1,2 месяца"].map((after) => `Карточки на закреплении вернутся через ${after}. Я напомню.`));
    // Tatar: the interval stands before «бар» and takes no ending.
    expect([MIN + 1000, 5 * MIN, 8 * MIN, 3 * HOUR, DAY, 11 * DAY, 36 * DAY].map((ms) => next(ms, "tt"))).toEqual(
      ["1 минут", "5 минут", "8 минут", "3 сәгать", "1 көн", "11 көн", "1,2 ай"].map((left) => `Ныгытудагы карточкалар кайтканчы ${left} бар. Искә төшерермен.`));
    // A card is never less than a minute away on this screen; if it were, the sentence would still say a minute.
    expect([next(20_000, "ru"), next(0, "tt")]).toEqual(["Карточки на закреплении вернутся через 1 минуту. Я напомню.", "Ныгытудагы карточкалар кайтканчы 1 минут бар. Искә төшерермен."]);
    // No shortened unit is left on the screen: «10 мин», «11 дн.», «1,2 мес.» were its old form.
    for (const ms of [10 * MIN, 3 * HOUR, 11 * DAY, 36 * DAY]) expect(next(ms, "ru")).not.toMatch(/\d (мин|ч|дн|мес)\.? /);
  });

  it("settings and the language choice name both languages in their own words", () => {
    const user = { lang: "ru", retention: 0.9, newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180, direction: "tt_ru", autoplay: false } as User;
    const labels = (u: User) => renderSettings(u).keyboard.flat().map((b) => b.text);
    expect(labels(user)).toEqual([
      "🌐 Язык: Русский", "🆕 Новых в день: 10", "⏰ Напоминание: 09:00", "🕒 Часовой пояс: UTC+3",
      "↔️ Направление: татарский → русский", "🔊 Автоозвучка: выкл", "📚 Уровни, темы, порядок слов",
    ]);
    expect(labels({ ...user, lang: "tt", direction: "ru_tt" })).toEqual([
      "🌐 Тел: Татарча", "🆕 Көненә яңа сүзләр: 10", "⏰ Искә төшерү: 09:00", "🕒 Сәгать поясы: UTC+3",
      "↔️ Юнәлеш: русча → татарча", "🔊 Автомат тавыш: сүндерелгән", "📚 Дәрәҗәләр, темалар, сүзләр тәртибе",
    ]);
    expect(renderSettings({ ...user, lang: "tt" }).text).toContain("Көйләүләр");
    for (const lang of ["ru", "tt"] as const) {
      expect(renderOnboarding({ kind: "lang" }, lang).keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([["Русский", "ob:ru"], ["Татарча", "ob:tt"]]);
    }
  });
});
