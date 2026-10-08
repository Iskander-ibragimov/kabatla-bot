import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo, type User } from "../../src/db/repo";
import { ru } from "../../src/i18n/ru";
import { ReviewService } from "../../src/review/service";
import { type Mem, type Rating, newMem } from "../../src/srs/ladder";
import { harness } from "../helpers/botHarness";
import { bulkCards } from "../helpers/catalog";
import { countingDb } from "../helpers/countingDb";
import { readingDb } from "../helpers/readingDb";
import { asCard, gradeShown, logStmt } from "../helpers/review";
import { seedLearner, seedUser } from "../helpers/seed";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 local (+03:00)

type Row = { state: string; step: number | null; stability: number | null; difficulty: number | null; due: number; last_review: number | null; scheduled_days: number; reps: number; lapses: number };
const rowOf = async (cardId: number) =>
  (await env.DB.prepare("SELECT state, step, stability, difficulty, due, last_review, scheduled_days, reps, lapses FROM cards WHERE id = ?").bind(cardId).first<Row>())!;
const cardIdOf = async (userId: number, noteId: number) =>
  (await env.DB.prepare("SELECT id FROM cards WHERE user_id = ? AND note_id = ?").bind(userId, noteId).first<{ id: number }>())!.id;

/** A card as the ladder stores it on a day rung: graded `days` ago for `days`, due at `now`. */
const onDayRung = (now: number, days: number, reps = 4): Mem =>
  ({ ...newMem(now), state: "review", due: now, lastReview: now - days * DAY, scheduledDays: days, reps });
/** A card as the ladder stores it on a minute rung (`step` 0 or 1), due at `due`. */
const onMinuteRung = (step: 0 | 1, due: number): Mem => ({ ...newMem(due), state: "learning", step, due, lastReview: due - MIN, reps: 1 });

/**
 * The bot of a learner (Telegram id 42) over a database that counts its calls. An update gives its Telegram calls and
 * the texts of the grade buttons it left on screen, and is held to the budget of an update: 8 D1 calls, 3 Telegram calls.
 */
function botOf() {
  const db = countingDb(env.DB);
  const h = harness(db, { now: T });
  const update = async (run: () => Promise<unknown>) => {
    const before = h.tg.calls.length;
    db.calls = 0;
    await run();
    const calls = h.tg.calls.slice(before);
    expect(db.calls, "D1 calls").toBeLessThanOrEqual(8);
    expect(calls.length, calls.map((c) => c.method).join(",")).toBeLessThanOrEqual(3);
    return { calls: calls.map((c) => [c.method, c.payload.text]) };
  };
  const keyboard = () => h.lastMarkup().inline_keyboard ?? [];
  return {
    h, text: (s: string) => update(() => h.text(s)), press: (data: string, messageId = 100) => update(() => h.press(data, messageId)),
    /** The texts of the four grade buttons of the card on screen, in the order «Снова», «Трудно», «Хорошо», «Легко». */
    grades: () => keyboard().flat().filter((b) => /^g:\d+:\d+:[1-4]$/.test(b.callback_data)).map((b) => b.text),
    rows: () => keyboard().flat().map((b) => [b.text, b.callback_data]),
  };
}

describe("a session on the ladder", () => {
  it("the first card of a new learner names the four intervals of a new word in words, in Russian and in Tatar", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, tgId: 42, words: 3 });
    const b = botOf();
    await b.text("/learn");
    expect(b.grades()).toEqual(["Снова · 1 минута", "Трудно · 5 минут", "Хорошо · 10 минут", "Легко · 1 день"]);
    await repo.updateUser(user.id, { lang: "tt" });
    await b.text("/learn");
    expect(b.grades()).toEqual(["Яңадан · 1 минут", "Авыр · 5 минут", "Яхшы · 10 минут", "Җиңел · 1 көн"]);
  });

  it("a word graded «Хорошо» six times, each time when it is due, stands on 10 minutes, then 1, 3, 7, 14 and 30 days", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const first = asCard(await new ReviewService(repo, T).nextScreen(user));
    const stood: unknown[] = [];
    let now = T;
    for (let i = 0; i < 6; i++) {
      const s = asCard(await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!));
      expect(s.view.cardId).toBe(first.view.cardId);
      await gradeShown(repo, user, s, 3, now);
      const r = await rowOf(first.view.cardId);
      stood.push([r.state, r.step, r.scheduled_days, r.due - now]);
      // The ladder writes no memory model: both columns are empty after every grade.
      expect([r.stability, r.difficulty, r.reps, r.lapses, r.last_review]).toEqual([null, null, i + 1, 0, now]);
      now = r.due;
    }
    expect(stood).toEqual([
      ["learning", 1, 0, 10 * MIN], ["review", null, 1, DAY], ["review", null, 3, 3 * DAY], ["review", null, 7, 7 * DAY], ["review", null, 14, 14 * DAY], ["review", null, 30, 30 * DAY],
    ]);
  });

  describe("«Снова» on the 14-day rung", () => {
    /** A learner with a word due on the 14-day rung and two new words; the word is on screen. */
    async function lapsing() {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 3 });
      const before = onDayRung(T, 14, 5);
      const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", before);
      const shown = asCard(await new ReviewService(repo, T).nextScreen(user));
      expect(shown.view.cardId).toBe(id);
      return { repo, user, id, shown, before };
    }

    it("the word falls to one minute as a relearning card with one lapse, comes back a minute later in the same session, and two «Хорошо» bring it to 1 day", async () => {
      const { repo, user, id, shown } = await lapsing();
      const next = asCard(await gradeShown(repo, user, shown, 1, T));
      expect(await rowOf(id)).toMatchObject({ state: "relearning", step: 0, scheduled_days: 0, due: T + MIN, lapses: 1, reps: 6, stability: null, difficulty: null });
      // Until the minute is over a new word comes, not the word that fell.
      expect(next.view.cardId).not.toBe(id);
      const back = asCard(await new ReviewService(repo, T + MIN).nextScreen((await repo.getUser(user.id))!));
      expect(back.view.cardId).toBe(id);
      expect(back.intervals).toEqual({ 1: "1 минута", 2: "5 минут", 3: "10 минут", 4: "1 день" });
      await gradeShown(repo, user, back, 3, T + MIN);
      expect(await rowOf(id)).toMatchObject({ state: "relearning", step: 1, scheduled_days: 0, due: T + 11 * MIN, lapses: 1 });
      const again = asCard(await new ReviewService(repo, T + 11 * MIN).nextScreen((await repo.getUser(user.id))!));
      expect(again.view.cardId).toBe(id);
      await gradeShown(repo, user, again, 3, T + 11 * MIN);
      expect(await rowOf(id)).toMatchObject({ state: "review", step: null, scheduled_days: 1, due: T + 11 * MIN + DAY, lapses: 1, reps: 8 });
    });

    it("undo of that «Снова» puts the word back on 14 days with its old due time", async () => {
      const { repo, user, id, shown, before } = await lapsing();
      await gradeShown(repo, user, shown, 1, T);
      const undone = asCard(await new ReviewService(repo, T + 5000).undo((await repo.getUser(user.id))!));
      expect(undone.view.cardId).toBe(id);
      expect(await rowOf(id)).toEqual({
        state: "review", step: null, stability: null, difficulty: null, due: before.due, last_review: before.lastReview, scheduled_days: 14, reps: 5, lapses: 0,
      });
      expect(undone.intervals).toEqual({ 1: "1 минута", 2: "14 дней", 3: "1 месяц", 4: "2 месяца" });
    });
  });

  describe("cards written by the old scheduler", () => {
    const BOTTOM = { 1: "1 минута", 2: "5 минут", 3: "10 минут", 4: "1 день" };
    /** What a grade leaves in the row: state, step, scheduled_days and the time until the card is due. */
    type After = [state: string, step: number | null, days: number, dueIn: number];
    const day = (days: number): After => ["review", null, days, days * DAY];
    const OLD: { name: string; mem: Mem; intervals: Record<number, string>; after: Record<Rating, After> }[] = [
      {
        // 11 days is the 7-day rung, the highest whose days are not more than 11.
        name: "a review card at 11 days",
        mem: { ...newMem(T), state: "review", step: null, stability: 11.4, difficulty: 5.2, due: T, lastReview: T - 11 * DAY, scheduledDays: 11, reps: 4 },
        intervals: { 1: "1 минута", 2: "7 дней", 3: "14 дней", 4: "1 месяц" },
        after: { 1: ["relearning", 0, 0, MIN], 2: day(7), 3: day(14), 4: day(30) },
      },
      {
        // 25 days is the 14-day rung (rung 6): 30 days are more than it has.
        name: "a review card at 25 days",
        mem: { ...newMem(T), state: "review", step: null, stability: 24.7, difficulty: 4.9, due: T - 2 * DAY, lastReview: T - 27 * DAY, scheduledDays: 25, reps: 6, lapses: 1 },
        intervals: { 1: "1 минута", 2: "14 дней", 3: "1 месяц", 4: "2 месяца" },
        after: { 1: ["relearning", 0, 0, MIN], 2: day(14), 3: day(30), 4: day(60) },
      },
      {
        // 400 days is above the ladder: the top rung, which nothing leaves upwards.
        name: "a review card at 400 days",
        mem: { ...newMem(T), state: "review", step: null, stability: 401.8, difficulty: 3.3, due: T, lastReview: T - 400 * DAY, scheduledDays: 400, reps: 9 },
        intervals: { 1: "1 минута", 2: "6 месяцев", 3: "6 месяцев", 4: "6 месяцев" },
        after: { 1: ["relearning", 0, 0, MIN], 2: day(180), 3: day(180), 4: day(180) },
      },
      {
        name: "a relearning card on step 0",
        mem: { ...newMem(T), state: "relearning", step: 0, stability: 3.1, difficulty: 6.8, due: T, lastReview: T - 10 * MIN, scheduledDays: 0, reps: 6, lapses: 1 },
        intervals: BOTTOM,
        after: { 1: ["relearning", 0, 0, MIN], 2: ["relearning", 0, 0, 5 * MIN], 3: ["relearning", 1, 0, 10 * MIN], 4: day(1) },
      },
      {
        name: "a learning card without a step",
        mem: { ...newMem(T), state: "learning", step: null, stability: 0.4, difficulty: 7.1, due: T, lastReview: T - MIN, scheduledDays: 0, reps: 1 },
        intervals: BOTTOM,
        after: { 1: ["learning", 0, 0, MIN], 2: ["learning", 0, 0, 5 * MIN], 3: ["learning", 1, 0, 10 * MIN], 4: day(1) },
      },
    ];
    const wholeRow = async (cardId: number) => (await env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(cardId).first<Record<string, unknown>>())!;

    describe.each(OLD)("$name", ({ mem, intervals, after }) => {
      it.each([1, 2, 3, 4] as Rating[])("is shown with four buttons and left as it is; grade %i puts it on the rung of the ladder; undo gives the old row back", async (rating) => {
        const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
        await bulkCards(env.DB, user.id, [[noteIds[0]!, "tt_ru", mem, null]]);
        const id = await cardIdOf(user.id, noteIds[0]!);
        const written = await wholeRow(id);
        expect(written).toMatchObject({ state: mem.state, step: mem.step, stability: mem.stability, difficulty: mem.difficulty, scheduled_days: mem.scheduledDays, due: mem.due });

        // Showing the card writes nothing to its row: its rung is worked out when it is read.
        const shown = asCard(await new ReviewService(repo, T).nextScreen(user));
        expect(shown.view.cardId).toBe(id);
        expect(shown.intervals).toEqual(intervals);
        expect(await wholeRow(id)).toEqual(written);

        const next = await gradeShown(repo, user, shown, rating, T);
        expect(next.kind).not.toBe("stale");
        const [state, step, days, dueIn] = after[rating];
        expect(await rowOf(id)).toEqual({
          state, step, scheduled_days: days, due: T + dueIn, last_review: T, stability: null, difficulty: null, reps: mem.reps + 1,
          // Only «Снова» on a day rung is a lapse.
          lapses: mem.lapses + (rating === 1 && mem.state === "review" ? 1 : 0),
        });

        const undone = asCard(await new ReviewService(repo, T + 5000).undo((await repo.getUser(user.id))!));
        expect(undone.view.cardId).toBe(id);
        expect(undone.intervals).toEqual(intervals);
        // The row is back exactly as the old scheduler left it, the memory model included.
        expect(await wholeRow(id)).toEqual(written);
      });
    });

    it("undo of a grade the old scheduler logged writes the card back with the stability and the difficulty of the log", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
      const before: Mem = { ...newMem(T), state: "review", step: null, stability: 11.4, difficulty: 5.2, due: T - MIN, lastReview: T - 11 * DAY, scheduledDays: 11, reps: 4 };
      const graded: Mem = { ...before, stability: 46.3, difficulty: 5.1, due: T + 46 * DAY, lastReview: T - 30_000, scheduledDays: 46, reps: 5 };
      const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", graded);
      await logStmt(env.DB, { cardId: id, userId: user.id, rating: 3, stateBefore: before, intervalBeforeDays: 11, intervalAfterMs: 46 * DAY, reviewedAt: T - 30_000, wasNew: false }).run();
      const undone = asCard(await new ReviewService(repo, T).undo(user));
      expect(undone.view.cardId).toBe(id);
      expect(await rowOf(id)).toEqual({
        state: "review", step: null, stability: 11.4, difficulty: 5.2, due: T - MIN, last_review: T - 11 * DAY, scheduled_days: 11, reps: 4, lapses: 0,
      });
    });
  });

  it("a learner whose only cards are two words on the minute rungs that are not due yet gets the screen that ends a session, not a card, and nothing is written", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 2 });
    // A card due within 60 seconds is shown ahead of its time when nothing else is left (review/pick.ts), so the nearer
    // word is due a second later than one minute; the other in five minutes.
    await bulkCards(env.DB, user.id, [[noteIds[0]!, "tt_ru", onMinuteRung(0, T + MIN + 1000), null], [noteIds[1]!, "tt_ru", onMinuteRung(1, T + 5 * MIN), null]]);
    // The read positions of the level are stored by the first read of a learner; this learner has read the queue before.
    await new ReviewService(repo, T).nextScreen(user);
    const db = readingDb(env.DB);
    const s = await new ReviewService(new Repo(db), T).nextScreen((await repo.getUser(user.id))!);
    expect(s).toMatchObject({ kind: "done", summary: { nextLearningInMs: MIN + 1000 } });
    expect(db.rowsWritten).toBe(0);
    // A second later the nearer word is due in exactly a minute: that is within the learn-ahead, and it is the card.
    expect(asCard(await new ReviewService(repo, T + 1000).nextScreen((await repo.getUser(user.id))!)).view.noteId).toBe(noteIds[0]);
  });

  it("«Снова» on the only card, a word of the 14-day rung: the word is the next card at once; «Хорошо» then ends the session for 10 minutes", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, tgId: 42, words: 1 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", onDayRung(T, 14, 5));
    const b = botOf();
    /** Presses the grade button `rating` of the card on screen. */
    const press = (rating: Rating) => b.press(b.rows().find(([, data]) => new RegExp(`^g:${id}:\\d+:${rating}$`).test(data!))![1]!, b.h.tg.lastMessageId());
    await b.text("/learn");
    expect(b.h.lastText()).toContain("<b>китап</b>");
    expect(b.grades()).toEqual(["Снова · 1 минута", "Трудно · 14 дней", "Хорошо · 1 месяц", "Легко · 2 месяца"]);

    // Nothing else is left, so the word that is due within a minute is shown at once (ruling L6): the same instant, a new message.
    const again = await press(1);
    expect(again.calls.map(([method]) => method)).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(await rowOf(id)).toMatchObject({ state: "relearning", step: 0, scheduled_days: 0, due: T + MIN, lapses: 1, reps: 6 });
    expect(b.h.lastText()).toContain("<b>китап</b>");
    expect(b.h.lastText()).toContain("🌿 Учу · ступень 1 из 10 · повтор №7");
    expect(b.grades()).toEqual(["Снова · 1 минута", "Трудно · 5 минут", "Хорошо · 10 минут", "Легко · 1 день"]);

    // «Хорошо»: the 10-minute rung is further than a minute away, so the session ends and says when the word comes.
    const good = await press(3);
    expect(good.calls.map(([method]) => method)).toEqual(["sendMessage", "deleteMessage", "answerCallbackQuery"]);
    expect(await rowOf(id)).toMatchObject({ state: "relearning", step: 1, scheduled_days: 0, due: T + 10 * MIN, lapses: 1, reps: 7 });
    expect(b.grades()).toEqual([]);
    expect(b.h.lastText().split("\n")).toEqual([ru.doneTitle, ru.doneToday(2, 0), "", "Карточки на закреплении вернутся через 10 минут. Я напомню.", ru.streak(1), "", ru.emptyAllDone]);
  });

  it("«Легко» from the 14-day rung to 60 days: the grade is logged as the one that learned the word, and the day counts the word once", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 2, patch: { newPerDay: 0 } });
    const fresh = async () => (await repo.getUser(user.id))!;
    const known = await repo.insertCard(user.id, noteIds[0]!, "tt_ru", onDayRung(T, 14, 5));
    // A word that is learned already: a grade that keeps it learned learns nothing.
    const learned = await repo.insertCard(user.id, noteIds[1]!, "tt_ru", { ...onDayRung(T, 30, 6), due: T + 1000 });

    const first = asCard(await new ReviewService(repo, T).nextScreen(user));
    expect(first.view.cardId).toBe(known);
    expect(first.intervals[4]).toBe("2 месяца");
    await gradeShown(repo, user, first, 4, T);
    expect(await rowOf(known)).toMatchObject({ state: "review", scheduled_days: 60, due: T + 60 * DAY });
    // The grade is taken back and given again: the word is learned by one grade, not by two.
    const back = asCard(await new ReviewService(repo, T + 1000).undo(await fresh()));
    expect(await rowOf(known)).toMatchObject({ state: "review", scheduled_days: 14 });
    const second = asCard(await gradeShown(repo, user, back, 4, T + 2000));
    expect(second.view.cardId).toBe(learned);
    const done = await gradeShown(repo, user, second, 3, T + 3000);
    expect(await rowOf(learned)).toMatchObject({ state: "review", scheduled_days: 60 });

    const log = (await env.DB.prepare("SELECT card_id, rating, learned_now, undone FROM review_log WHERE user_id = ? ORDER BY id").bind(user.id).all()).results;
    expect(log).toEqual([
      { card_id: known, rating: 4, learned_now: 1, undone: 1 }, { card_id: known, rating: 4, learned_now: 1, undone: 0 }, { card_id: learned, rating: 3, learned_now: 0, undone: 0 },
    ]);
    expect(done).toMatchObject({ kind: "done", summary: { reviewsToday: 2, learnedToday: 1, nextLearningInMs: null } });
    // The same count on the screen of the next «Учить».
    expect(await new ReviewService(repo, T + 4000).nextScreen(await fresh())).toMatchObject({ kind: "done", summary: { reviewsToday: 2, learnedToday: 1 } });
  });

  it("a card on the top rung shows 6 months on «Трудно», «Хорошо» and «Легко»", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, tgId: 42, words: 1 });
    await repo.insertCard(user.id, noteIds[0]!, "tt_ru", onDayRung(T, 180, 12));
    const b = botOf();
    await b.text("/learn");
    expect(b.grades()).toEqual(["Снова · 1 минута", "Трудно · 6 месяцев", "Хорошо · 6 месяцев", "Легко · 6 месяцев"]);
    expect(b.h.lastText()).toContain("🏆 Выучено · ступень 10 из 10 · повтор №13");
  });

  it("the line under a card names the rung of a started word, in both languages, and no rung for a new word", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, tgId: 42, words: 2 });
    await repo.insertCard(user.id, noteIds[0]!, "tt_ru", onDayRung(T, 7));
    const b = botOf();
    await b.text("/learn");
    expect(b.h.lastText()).toContain("<b>китап</b>");
    expect(b.h.lastText()).toContain("🌳 Знаю · ступень 5 из 10 · повтор №5");
    await repo.updateUser(user.id, { lang: "tt" });
    await b.text("/learn");
    expect(b.h.lastText()).toContain("🌳 Беләм · баскыч 5/10 · кабатлау №5");
    await repo.updateUser(user.id, { lang: "ru" });

    // «Хорошо» takes the word off today's reviews; the next card is a new word.
    const good = b.rows().find(([, data]) => /^g:\d+:\d+:3$/.test(data!))![1]!;
    await b.press(good, b.h.tg.lastMessageId());
    expect(b.h.lastText()).toContain("<b>вакыт</b>");
    // The line of a new word is its stage alone, and it is the last line of the card.
    expect(b.h.lastText().endsWith("</blockquote>🌱 Новое")).toBe(true);
    expect(b.h.lastText()).not.toMatch(/ступень|память/);
  });

  describe("the settings", () => {
    const withoutRow = (rows: (string | undefined)[][]) => {
      expect(rows.map(([, data]) => data)).toEqual(["set:lang", "set:new", "set:rem", "set:tz", "set:dir", "set:auto", "set:hub", "set:tut"]);
      expect(rows.filter(([text]) => /Нагрузка|Йөкләнеш|%/.test(text!))).toEqual([]);
    };

    it("/settings has no row «Нагрузка», in Russian and in Tatar", async () => {
      const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
      const b = botOf();
      await b.text("/settings");
      withoutRow(b.rows());
      await repo.updateUser(user.id, { lang: "tt" });
      await b.text("/settings");
      withoutRow(b.rows());
    });

    it("the button «Нагрузка» of an old message changes nothing and is answered as a button the bot no longer has", async () => {
      const { repo, user } = await seedLearner(env.DB, { now: T, tgId: 42 });
      const b = botOf();
      const before: User = (await repo.getUser(user.id))!;
      expect(before.retention).toBe(0.9);
      const u = await b.press("set:ret", 200);
      expect(u.calls).toEqual([["answerCallbackQuery", ru.staleButton]]);
      expect(await repo.getUser(user.id)).toEqual(before);
    });
  });
});
