import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo, type User } from "../../src/db/repo";
import { enqueue } from "../../src/jobs/queue";
import { tick } from "../../src/reminders/service";
import { newMem } from "../../src/srs/ladder";
import { bulkCatalog } from "../helpers/catalog";
import { countingDb } from "../helpers/countingDb";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { ru } from "../../src/i18n/ru";
import { gradedMem, logStmt } from "../helpers/review";
import { note, recountProgress, seedCatalog, seedLearner } from "../helpers/seed";

const MIN = 60_000;
const local = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m) - 180 * MIN; // +03:00
const run = (db: D1Database, tg: ReturnType<typeof fakeTelegram>, now: number) => tick({ repo: new Repo(db), tg, now });

/** The `n` catalog words of a level (A1 unless given), «сүз1х1»…; returns their note ids. Once per level in a test. */
const catalog = (n: number, level = 1) => seedCatalog(env.DB, Array.from({ length: n }, (_, i) => ({ level, word: `сүз${level}х${i + 1}` })));
/** A learner who finished onboarding at 08:00 on the 30th (UTC+3), A1 checked, the daily reminder due at 09:00. */
const learner = (o: { tgId?: number; patch?: Partial<User> } = {}) => seedLearner(env.DB, { now: local(30, 8, 0), ...o });
/** The notes are started for the user: a card graded yesterday noon, not due today; the counters of started words follow the cards. */
async function start(repo: Repo, userId: number, noteIds: number[]) {
  for (let i = 0; i < noteIds.length; i += 50) await repo.batch(noteIds.slice(i, i + 50).map((id) => repo.insertCardStmt(userId, id, "tt_ru", gradedMem(local(29, 12, 0)))));
  await recountProgress(env.DB, userId);
}

describe("reminders tick", () => {
  it("missed tick still sends exactly one daily push", async () => {
    await catalog(3);
    await learner({ patch: { remindAt: "09:00" } });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 8, 58));
    expect(tg.of("sendMessage")).toHaveLength(0);
    await run(env.DB, tg, local(30, 9, 1));
    await run(env.DB, tg, local(30, 9, 2));
    const sent = tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain("3");
    expect(JSON.stringify(sent[0]!.payload.reply_markup)).toContain('"learn"');
  });

  it("next day sends again", async () => {
    await catalog(3);
    await learner();
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 5));
    await run(env.DB, tg, local(30, 9, 5) + 86_400_000);
    expect(tg.of("sendMessage")).toHaveLength(2);
  });

  it("no push when nothing is due", async () => {
    // The checked level has no cards, the learner has no card and no word of their own.
    await catalog(3, 2);
    await learner({ patch: { newPerDay: 5 } });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 5));
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  it("the daily push counts the reviews due and the new words apart; with nothing due it calls to learn new words", async () => {
    const ids = await catalog(5);
    const { repo, user } = await learner();
    await start(repo, user.id, ids.slice(0, 2));
    const tg = fakeTelegram();
    // Nothing due, three new words wait.
    await run(env.DB, tg, local(30, 9, 1));
    // One review is due the next morning, and the three words still wait.
    await repo.updateCardStmt((await repo.getCardByNote(user.id, ids[0]!, "tt_ru"))!.id, { ...gradedMem(local(25, 12, 0)), due: local(31, 7, 0) }).run();
    await run(env.DB, tg, local(31, 9, 1));
    expect(tg.of("sendMessage").map((c) => String(c.payload.text))).toEqual([
      "⏰ <b>Пора учить новые слова</b>\n🌱 Новых слов на сегодня: 3",
      "⏰ <b>Пора повторить</b>\n1 карточка · ~1 мин\n🌱 Новых слов на сегодня: 3",
    ]);
  });

  describe("the new words of the daily reminder: an estimate by the counters of the checked levels", () => {
    const pushes = async (now = local(30, 9, 1)) => { const tg = fakeTelegram(); await run(env.DB, tg, now); return tg.of("sendMessage").map((c) => String(c.payload.text)); };
    /** The reminder is due again at 09:00, for a second tick of the same morning. */
    const dueAgain = (repo: Repo, userId: number, patch: Partial<User> = {}) => repo.updateUser(userId, { ...patch, nextDailyAt: local(30, 9, 0) });

    it("a learner with A1 checked, 10 of 400 started and nothing due is reminded of as many new words as the day allows", async () => {
      const notes = await bulkCatalog(env.DB, { sizes: { 1: 400 } });
      const { repo, user } = await learner();
      await start(repo, user.id, notes.slice(0, 10).map((n) => n.id));
      // 390 words are left and ten are allowed today.
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 10)]);
      await dueAgain(repo, user.id, { newPerDay: 20 });
      expect(await pushes(local(30, 9, 2))).toEqual([ru.pushDaily(0, 1, 20)]);
    });

    it("counts no more new words than the checked levels have left", async () => {
      const ids = await catalog(12);
      const { repo, user } = await learner();
      await start(repo, user.id, ids.slice(0, 10));
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 2)]);
    });

    it("a learner whose checked levels are started whole and who has nothing due gets no push: the bot checks no level by itself", async () => {
      const ids = await catalog(2);
      // A2 has words, and it is not checked.
      await catalog(3, 2);
      const { repo, user } = await learner();
      await start(repo, user.id, ids);
      expect(await pushes()).toEqual([]);
      // Once the learner checks A2, its words are counted.
      await dueAgain(repo, user.id, { levels: 0b11 });
      expect(await pushes(local(30, 9, 2))).toEqual([ru.pushDaily(0, 1, 3)]);
    });

    it("counts every checked level and no other", async () => {
      const a1 = await catalog(3);
      await catalog(9, 2);
      await catalog(5, 3);
      const { repo, user } = await learner({ patch: { levels: 0b101, newPerDay: 20 } });
      await start(repo, user.id, a1.slice(0, 1));
      // Two words of A1 and the five of B1; the nine of A2 are not checked.
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 7)]);
    });

    it("a word started in a level that is not checked is not taken from what the checked levels have left", async () => {
      await catalog(2);
      const a2 = await catalog(4, 2);
      const { repo, user } = await learner({ patch: { newPerDay: 20 } });
      await start(repo, user.id, a2);
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 2)]);
    });

    it("adds the reviews due today to the new words", async () => {
      const ids = await catalog(3);
      const { repo, user } = await learner();
      await start(repo, user.id, ids.slice(0, 2));
      await repo.updateCardStmt((await repo.getCardByNote(user.id, ids[0]!, "tt_ru"))!.id, { ...gradedMem(local(25, 12, 0)), due: local(30, 7, 0) }).run();
      // One review and the one word that is left.
      expect(await pushes()).toEqual([ru.pushDaily(1, 1, 1)]);
    });

    it("is reminded of the reviews alone when the checked levels are started whole", async () => {
      const ids = await catalog(2);
      const { repo, user } = await learner();
      await start(repo, user.id, ids);
      await repo.updateCardStmt((await repo.getCardByNote(user.id, ids[0]!, "tt_ru"))!.id, { ...gradedMem(local(25, 12, 0)), due: local(30, 7, 0) }).run();
      expect(await pushes()).toEqual([ru.pushDaily(1, 1, 0)]);
    });

    it("is not reminded when today's limit of new words is already used up", async () => {
      const ids = await catalog(4);
      const { repo, user } = await learner({ patch: { newPerDay: 2 } });
      await start(repo, user.id, ids.slice(0, 2));
      // Both words were first graded this morning, after the 04:00 day boundary.
      const mem = gradedMem(local(30, 6, 0));
      await repo.batch(ids.slice(0, 2).map((_, i) => logStmt(env.DB, {
        cardId: i + 1, userId: user.id, rating: 3, stateBefore: newMem(local(30, 6, 0)), intervalBeforeDays: 0, intervalAfterMs: mem.due - local(30, 6, 0),
        reviewedAt: local(30, 6, 0), wasNew: true,
      })));
      expect(await pushes()).toEqual([]);
    });

    it("counts the learner's own words that were never shown together with the checked levels", async () => {
      await catalog(3);
      const { repo, user } = await learner({ patch: { newPerDay: 20 } });
      await repo.insertNotes(await repo.customDeck(user.id, local(30, 8, 0)), [note("рәхмәт"), note("зинһар")]);
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 5)]);
    });

    it("is reminded of own words alone when the checked levels are started whole", async () => {
      const ids = await catalog(2);
      const { repo, user } = await learner();
      await start(repo, user.id, ids);
      const own = await repo.insertNotes(await repo.customDeck(user.id, local(30, 8, 0)), [note("рәхмәт"), note("зинһар"), note("әйе")]);
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 3)]);
      // An own word that is started is no new word.
      await start(repo, user.id, own.slice(0, 2));
      await dueAgain(repo, user.id);
      expect(await pushes(local(30, 9, 2))).toEqual([ru.pushDaily(0, 1, 1)]);
      await start(repo, user.id, own.slice(2));
      await dueAgain(repo, user.id);
      expect(await pushes(local(30, 9, 3))).toEqual([]);
    });

    it("is reminded about a reverse card that was hidden on the day the rest of its level was asked: the session will give it", async () => {
      // «оба». Three words, all asked Tatar → Russian. Two were asked Russian → Tatar too; the reverse card of the
      // first word was hidden that day and still waits. Every word of the level is started.
      const ids = await catalog(3);
      const { repo, user } = await learner({ patch: { direction: "both" } });
      for (const id of ids.slice(1)) await repo.insertCard(user.id, id, "ru_tt", gradedMem(local(29, 12, 0)));
      await repo.insertCard(user.id, ids[0]!, "ru_tt", newMem(local(28, 12, 0)), "2026-09-28");
      await start(repo, user.id, ids);
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 1)]);
      // A learner who asks for Tatar → Russian only has nothing new: the card that waits is of the other direction.
      await dueAgain(repo, user.id, { direction: "tt_ru" });
      expect(await pushes(local(30, 9, 2))).toEqual([]);
    });

    it("with both directions counts the reverse cards that wait and the words never shown, each once", async () => {
      // Four words: two were asked Tatar → Russian yesterday, so their reverse cards wait; two were never shown.
      const ids = await catalog(4);
      const { repo, user } = await learner({ patch: { direction: "both" } });
      for (const id of ids.slice(0, 2)) await repo.insertCard(user.id, id, "ru_tt", newMem(local(29, 12, 0)), "2026-09-29");
      await start(repo, user.id, ids.slice(0, 2));
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 4)]);
    });

    it("a catalog word the learner owns a copy of is no new word of its level: with the rest started and the copy started, no push (ruling T6a)", async () => {
      const ids = await catalog(3);
      const { repo, user } = await learner();
      await start(repo, user.id, ids.slice(0, 2));
      const [own] = await repo.insertNotes(await repo.customDeck(user.id, local(30, 8, 0)), [note("сүз1х3")]);
      // The copy itself is a new word, once: not once as an own word and once more as a word of A1.
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 1)]);
      await start(repo, user.id, [own!]);
      await dueAgain(repo, user.id);
      expect(await pushes(local(30, 9, 2))).toEqual([]);
    });

    it("own words started Tatar → Russian are new words again, once each, for a learner who went over to Russian → Tatar or to both directions", async () => {
      const ids = await catalog(2);
      const { repo, user } = await learner();
      const own = await repo.insertNotes(await repo.customDeck(user.id, local(30, 8, 0)), [note("рәхмәт"), note("зинһар"), note("әйе")]);
      await start(repo, user.id, [...ids, ...own]);
      expect(await pushes()).toEqual([]);
      await dueAgain(repo, user.id, { direction: "ru_tt" });
      expect(await pushes(local(30, 9, 2))).toEqual([ru.pushDaily(0, 1, 3)]);
      await dueAgain(repo, user.id, { direction: "both" });
      expect(await pushes(local(30, 9, 3))).toEqual([ru.pushDaily(0, 1, 3)]);
      // The reverse card of one of them exists and waits: it is counted as that card, the other two as words never shown that way.
      await repo.insertCard(user.id, own[0]!, "ru_tt", newMem(local(29, 12, 0)), "2026-09-29");
      await dueAgain(repo, user.id);
      expect(await pushes(local(30, 9, 4))).toEqual([ru.pushDaily(0, 1, 3)]);
      // Once every own word is started both ways nothing is new.
      await repo.updateCardStmt((await repo.getCardByNote(user.id, own[0]!, "ru_tt"))!.id, gradedMem(local(29, 12, 0))).run();
      for (const id of own.slice(1)) await repo.insertCard(user.id, id, "ru_tt", gradedMem(local(29, 12, 0)));
      await dueAgain(repo, user.id);
      expect(await pushes(local(30, 9, 5))).toEqual([]);
    });

    it("takes no notice of the checked parts of speech nor of the chosen topic: the number may say more than the session gives (spec §6)", async () => {
      await seedCatalog(env.DB, [{ level: 1, word: "китап", topic: 2 }, { level: 1, word: "су", topic: 8 }, { level: 1, word: "юл", topic: 10 }]);
      // Numerals only, and the topic «Еда»: of the three nouns the session would give none.
      await learner({ patch: { posGroups: 1 << 5, newMode: "topic", topicNo: 8 } });
      expect(await pushes()).toEqual([ru.pushDaily(0, 1, 3)]);
    });
  });

  it("evening push only with a streak of 2+ and no study today", async () => {
    const future = local(30, 9, 0) + 10 * 86_400_000;
    await catalog(1);
    await learner({ tgId: 1, patch: { streak: 1, lastStudyDay: "2026-09-29", nextDailyAt: future } });
    await learner({ tgId: 2, patch: { streak: 3, lastStudyDay: "2026-09-29", nextDailyAt: future } });
    await learner({ tgId: 3, patch: { streak: 3, lastStudyDay: "2026-09-30", nextDailyAt: future } });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 19, 59));
    expect(tg.of("sendMessage")).toHaveLength(0);
    await run(env.DB, tg, local(30, 20, 5));
    await run(env.DB, tg, local(30, 20, 6));
    const sent = tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.chat_id).toBe(2);
  });

  it("step ping once and never in quiet hours", async () => {
    const noteIds = await catalog(1);
    const { repo, user } = await learner({ patch: { nextDailyAt: local(30, 9, 0) + 10 * 86_400_000 } });
    const t0 = local(30, 12, 0);
    await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(t0), state: "learning", step: 1, due: t0 + 10 * MIN, reps: 1, lastReview: t0 });
    await repo.updateUser(user.id, { lastReviewAt: t0 });
    const tg = fakeTelegram();
    await run(env.DB, tg, t0 + 5 * MIN);
    expect(tg.of("sendMessage")).toHaveLength(0);
    await run(env.DB, tg, t0 + 11 * MIN);
    await run(env.DB, tg, t0 + 12 * MIN);
    expect(tg.of("sendMessage")).toHaveLength(1);

    const n = local(30, 23, 30);
    await repo.updateUser(user.id, { lastReviewAt: n - 20 * MIN, lastStepPingAt: null });
    const tg2 = fakeTelegram();
    await run(env.DB, tg2, n);
    expect(tg2.of("sendMessage")).toHaveLength(0);
  });

  it("caps sends at 35 per tick, rest next tick", async () => {
    await catalog(1);
    for (let i = 0; i < 40; i++) await learner({ tgId: 1000 + i });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 1));
    expect(tg.of("sendMessage")).toHaveLength(35);
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(40);
  });

  it("403 deactivates the user", async () => {
    await catalog(1);
    const { repo, user } = await learner();
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
    await run(env.DB, tg, local(30, 9, 1));
    expect((await repo.getUser(user.id))!.active).toBe(false);
  });

  it("429 reschedules as a job and the job is delivered later", async () => {
    await catalog(1);
    await learner();
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 429, "Too Many Requests", 30);
    await run(env.DB, tg, local(30, 9, 1));
    const job = await env.DB.prepare("SELECT kind, run_at FROM jobs").first<{ kind: string; run_at: number }>();
    expect(job).toMatchObject({ kind: "push", run_at: local(30, 9, 1) + 30_000 });
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(2);
    expect((await env.DB.prepare("SELECT done_at FROM jobs").first<{ done_at: number | null }>())!.done_at).not.toBeNull();
  });

  describe("housekeeping", () => {
    const DAY = 86_400_000;
    const now = local(30, 9, 1);
    const preview = (createdAt: number) => env.DB.prepare("INSERT INTO previews (user_id, kind, payload, created_at) VALUES (1, 'add', '[]', ?)").bind(createdAt).run();
    const job = (doneAt: number | null) => env.DB.prepare("INSERT INTO jobs (kind, payload, run_at, done_at) VALUES ('voice', '{}', ?, ?)").bind(now + DAY, doneAt).run();

    it("deletes previews older than 24 hours and finished jobs older than 7 days, and nothing else", async () => {
      for (const at of [now - DAY - 1, now - 3 * DAY, now - DAY, now - 60_000]) await preview(at);
      for (const at of [now - 7 * DAY - 1, now - 30 * DAY, now - 7 * DAY, now - 60_000, null]) await job(at);
      await run(env.DB, fakeTelegram(), now);
      expect((await env.DB.prepare("SELECT created_at FROM previews ORDER BY created_at").all<{ created_at: number }>()).results.map((r) => r.created_at)).toEqual([now - DAY, now - 60_000]);
      // A job that is not done is never deleted, however old.
      expect((await env.DB.prepare("SELECT done_at FROM jobs ORDER BY id").all<{ done_at: number | null }>()).results.map((r) => r.done_at)).toEqual([now - 7 * DAY, now - 60_000, null]);
    });

    it("costs no D1 call: an idle tick still makes two", async () => {
      // Learners there are, with words to learn; none is due this minute.
      await catalog(3);
      for (const tgId of [1, 2]) await learner({ tgId, patch: { nextDailyAt: now + DAY, nextEveningAt: now + DAY } });
      await preview(now - 2 * DAY);
      const db = countingDb(env.DB);
      await run(db, fakeTelegram(), now);
      expect(db.calls).toBe(2); // the batch that reads who is due, and the claim of queued jobs
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM previews").first()).toEqual({ n: 0 });
    });
  });

  it("tick uses at most 10 D1 calls", async () => {
    await catalog(1);
    for (let i = 0; i < 5; i++) await learner({ tgId: 2000 + i });
    await enqueue(env.DB, "push", { chat_id: 1, text: "x" }, local(30, 9, 0));
    const db = countingDb(env.DB);
    await run(db, fakeTelegram(), local(30, 9, 1));
    expect(db.calls).toBeLessThanOrEqual(10);
  });

  it("a tick with 40 users due for a reminder makes at most 35 sends and 10 D1 calls", async () => {
    await catalog(1);
    for (let i = 0; i < 40; i++) await learner({ tgId: 4000 + i });
    // Pushes that an earlier tick put off wait in the queue as well.
    for (let i = 0; i < 10; i++) await enqueue(env.DB, "push", { chat_id: 5000 + i, text: "x" }, local(30, 9, 0));
    const db = countingDb(env.DB);
    const first = fakeTelegram();
    expect(await run(db, first, local(30, 9, 1))).toEqual({ sent: 35 });
    expect(first.calls).toHaveLength(35);
    expect(first.calls.every((c) => c.method === "sendMessage")).toBe(true);
    expect(db.calls).toBeLessThanOrEqual(10);
    // The next minute: the five users left and the queued pushes, again within the budget.
    db.calls = 0;
    const second = fakeTelegram();
    expect(await run(db, second, local(30, 9, 2))).toEqual({ sent: 15 });
    expect(second.calls).toHaveLength(15);
    expect(db.calls).toBeLessThanOrEqual(10);
    const reminded = [...first.calls, ...second.calls].map((c) => c.payload.chat_id as number).filter((id) => id < 5000);
    expect(new Set(reminded).size).toBe(40);
  });

  it("stays within 10 D1 calls when Telegram refuses some users and limits the rest", async () => {
    await catalog(1);
    for (let i = 0; i < 40; i++) await learner({ tgId: 6000 + i });
    const db = countingDb(env.DB);
    const tg = fakeTelegram();
    // The first user has blocked the bot; then Telegram asks to slow down: the rest of the plan is queued in one batch.
    let n = 0;
    const flaky = { call: async <T>(method: string, payload: Record<string, unknown>) => {
      n++;
      if (n === 1) throw Object.assign(new Error("Forbidden: bot was blocked by the user"), { error_code: 403 });
      if (n === 3) throw Object.assign(new Error("Too Many Requests"), { error_code: 429, parameters: { retry_after: 5 } });
      return tg.call<T>(method, payload);
    } };
    expect(await tick({ repo: new Repo(db), tg: flaky, now: local(30, 9, 1) })).toEqual({ sent: 1 });
    expect(n).toBeLessThanOrEqual(35);
    expect(db.calls).toBeLessThanOrEqual(10);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'push' AND run_at = ?").bind(local(30, 9, 1) + 5000).first<{ n: number }>())!.n).toBe(33);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 0").first<{ n: number }>())!.n).toBe(1);
  });

  it("does not voice words: a voice job left in the queue costs no Telegram call and writes nothing to the note", async () => {
    const noteIds = await catalog(1);
    await learner({ patch: { nextDailyAt: local(30, 9, 0) + 10 * 86_400_000 } });
    await enqueue(env.DB, "voice", { noteId: noteIds[0] }, local(30, 9, 0));
    const db = countingDb(env.DB);
    const tg = fakeTelegram();
    expect(await run(db, tg, local(30, 9, 1))).toEqual({ sent: 0 });
    expect(tg.calls).toEqual([]);
    expect(db.calls).toBeLessThanOrEqual(10);
    expect(await env.DB.prepare("SELECT audio_file_id, audio_tries FROM notes WHERE id = ?").bind(noteIds[0]).first()).toEqual({ audio_file_id: null, audio_tries: 0 });
    // The job is closed, not retried every minute: voicing happens in GitHub Actions, the tick only clears the queue.
    const job = await env.DB.prepare("SELECT attempts, error, done_at FROM jobs").first<{ attempts: number; error: string | null; done_at: number | null }>();
    expect(job).toEqual({ attempts: 0, error: null, done_at: local(30, 9, 1) });
  });

  it("a failed send is not retried every minute", async () => {
    await catalog(1);
    await learner();
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 400, "Bad Request: chat not found");
    await run(env.DB, tg, local(30, 9, 1));
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(1);
  });

  it("users are marked before sending, so a crashed send never repeats", async () => {
    await catalog(1);
    await learner();
    const crashing = { call: async () => { throw new Error("network reset"); } };
    await tick({ repo: new Repo(env.DB), tg: crashing, now: local(30, 9, 1) }).catch(() => undefined);
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  it("the tick reads only due users (indexed next_daily_at)", async () => {
    for (let i = 0; i < 30; i++) await learner({ tgId: 3000 + i, patch: { nextDailyAt: local(30, 9, 0) + 86_400_000 } });
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT u.id, u.chat_id FROM users u WHERE u.next_daily_at <= CAST(?1 AS INTEGER) AND +u.active = 1 AND u.onboarding_step IS NULL ORDER BY u.next_daily_at, u.id LIMIT 35").bind(local(30, 9, 1)).all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" ");
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_users_next_daily/);
    expect(detail).not.toMatch(/SCAN u\b/);
    const stepPlan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT u.id FROM users u WHERE u.last_review_at BETWEEN ?1 - 86400000 AND ?1 - 180000 AND +u.active = 1 AND u.onboarding_step IS NULL").bind(local(30, 9, 1)).all<{ detail: string }>();
    expect(stepPlan.results.map((r) => r.detail).join(" ")).toMatch(/idx_users_last_review/);
  });
});
