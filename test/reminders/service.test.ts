import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { enqueue } from "../../src/jobs/queue";
import { tick } from "../../src/reminders/service";
import { newMem } from "../../src/srs/fsrs";
import { countingDb } from "../helpers/countingDb";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { ru } from "../../src/i18n/ru";
import { gradedMem } from "../helpers/review";
import { note, seedLevels, seedUser } from "../helpers/seed";

const MIN = 60_000;
const local = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m) - 180 * MIN; // +03:00
const run = (db: D1Database, tg: ReturnType<typeof fakeTelegram>, now: number) => tick({ repo: new Repo(db), tg, now });

describe("reminders tick", () => {
  it("missed tick still sends exactly one daily push", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 3, patch: { remindAt: "09:00" } });
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
    await seedUser(env.DB, { now: local(30, 8, 0), words: 3 });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 5));
    await run(env.DB, tg, local(30, 9, 5) + 86_400_000);
    expect(tg.of("sendMessage")).toHaveLength(2);
  });

  it("no push when nothing is due", async () => {
    // Nothing is open, and the catalog has no deck of the learner's level nor of a higher one: a tap would open nothing.
    await seedUser(env.DB, { now: local(30, 8, 0), words: 3, patch: { newPerDay: 5 } });
    await env.DB.batch([env.DB.prepare("DELETE FROM user_decks"), env.DB.prepare("UPDATE users SET level = 5")]);
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 5));
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  describe("a learner who finished every open level", () => {
    /** Level 1 with `words` words, all graded and not due today, for a user whose reminder is due at 09:00. */
    async function finishedLevel1(words: number, patch: Parameters<typeof seedUser>[1]["patch"] = {}) {
      const seeded = await seedUser(env.DB, { now: local(30, 8, 0), words, patch });
      for (const id of seeded.noteIds) await seeded.repo.insertCard(seeded.user.id, id, "tt_ru", gradedMem(local(29, 12, 0)));
      return seeded;
    }
    const pushes = async (now = local(30, 9, 1)) => { const tg = fakeTelegram(); await run(env.DB, tg, now); return tg.of("sendMessage").map((c) => String(c.payload.text)); };

    it("is reminded when a higher level is in the catalog: a tap would open it", async () => {
      await finishedLevel1(2);
      await seedLevels(env.DB, { 2: ["авыл", "су", "юл"] });
      // Three new words wait in level 2, fewer than the daily limit of ten.
      expect(await pushes()).toEqual([ru.pushDaily(3, 1)]);
    });

    it("counts the new words up to the daily limit", async () => {
      await finishedLevel1(2, { newPerDay: 5 });
      await seedLevels(env.DB, { 2: Array.from({ length: 12 }, (_, i) => `сүз${i + 1}`) });
      expect(await pushes()).toEqual([ru.pushDaily(5, 2)]);
    });

    it("the next level may be behind a gap", async () => {
      await finishedLevel1(1);
      await seedLevels(env.DB, { 4: ["авыл", "су"] });
      expect(await pushes()).toEqual([ru.pushDaily(2, 1)]);
    });

    it("adds the reviews due today to the new words of the next level", async () => {
      const { repo, user, noteIds } = await finishedLevel1(2);
      await seedLevels(env.DB, { 2: ["авыл"] });
      await repo.updateCardStmt((await repo.getCardByNote(user.id, noteIds[0]!, "tt_ru"))!.id, { ...gradedMem(local(25, 12, 0)), due: local(30, 7, 0) }).run();
      expect(await pushes()).toEqual([ru.pushDaily(2, 1)]);
    });

    it("is not reminded while no higher level is published", async () => {
      await finishedLevel1(2);
      expect(await pushes()).toEqual([]);
      // A level below the current one is a skipped level: a tap on the reminder would not open it.
      const { repo, user } = await seedUser(env.DB, { now: local(30, 8, 0), level: 3, words: 1, tgId: 2 });
      await repo.insertCard(user.id, (await env.DB.prepare("SELECT id FROM notes WHERE deck_id = (SELECT id FROM decks WHERE level_no = 3)").first<{ id: number }>())!.id, "tt_ru", gradedMem(local(29, 12, 0)));
      expect(await pushes(local(30, 9, 2))).toEqual([]);
    });

    it("is not reminded when today's limit of new words is already used up", async () => {
      const { repo, user, noteIds } = await finishedLevel1(2, { newPerDay: 2 });
      await seedLevels(env.DB, { 2: ["авыл", "су"] });
      // Both words were first graded this morning, after the 04:00 day boundary.
      const mem = gradedMem(local(30, 6, 0));
      await repo.batch(noteIds.map((id, i) => repo.insertLogStmt({
        cardId: i + 1, userId: user.id, rating: 3, stateBefore: newMem(local(30, 6, 0)), intervalBeforeDays: 0, intervalAfterMs: mem.due - local(30, 6, 0),
        reviewedAt: local(30, 6, 0), wasNew: true, learnedNow: false, streakBefore: 0, lastStudyDayBefore: null,
      })));
      expect(await pushes()).toEqual([]);
    });

    it("is not reminded after the last level: there is nothing left to open", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), level: 20, words: 1 });
      await repo.insertCard(user.id, noteIds[0]!, "tt_ru", gradedMem(local(29, 12, 0)));
      // A deck numbered above the last level is not a level.
      await seedLevels(env.DB, { 21: ["авыл"] });
      expect(await pushes()).toEqual([]);
      await repo.updateUser(user.id, { level: 21, nextDailyAt: local(30, 9, 0) });
      expect(await pushes(local(30, 9, 2))).toEqual([]);
    });

    it("a current level that was never opened counts as the level a tap would open (ruling T16c)", async () => {
      // Finished onboarding at level 4 when the catalog had no such level; now it has, and level 5 behind it.
      const repo = new Repo(env.DB);
      const id = await repo.insertUser({ tgId: 7, chatId: 7, lang: "ru", now: local(30, 8, 0) });
      await repo.updateUser(id, { onboardingStep: null, tzOffsetMin: 180, level: 4, nextDailyAt: local(30, 9, 0) });
      await seedLevels(env.DB, { 4: ["авыл", "су", "юл"], 5: Array.from({ length: 8 }, (_, i) => `сүз${i + 1}`) });
      expect(await pushes()).toEqual([ru.pushDaily(3, 1)]);
      // Once it is open and finished, the level above is the next one.
      await repo.subscribe(id, (await repo.getDeckBySlug("l04"))!.id, local(30, 9, 5));
      const notes = await env.DB.prepare("SELECT id FROM notes WHERE deck_id = (SELECT id FROM decks WHERE level_no = 4)").all<{ id: number }>();
      for (const n of notes.results) await repo.insertCard(id, n.id, "tt_ru", gradedMem(local(29, 12, 0)));
      await repo.updateUser(id, { nextDailyAt: local(30, 9, 0) });
      expect(await pushes(local(30, 9, 6))).toEqual([ru.pushDaily(8, 3)]);
    });

    it("is not reminded about a level word the learner owns a copy of: the session would not show it", async () => {
      // Level 1: «китап» is graded, «вакыт» is in «Мои слова» and graded there; nothing is above level 1.
      const { repo, user, noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), words: 2 });
      await repo.insertCard(user.id, noteIds[0]!, "tt_ru", gradedMem(local(29, 12, 0)));
      const [own] = await repo.insertNotes(await repo.customDeck(user.id, local(30, 8, 0)), [note("вакыт")]);
      await repo.insertCard(user.id, own!, "tt_ru", gradedMem(local(29, 12, 0)));
      expect(await pushes()).toEqual([]);
    });

    it("counts the new words in the direction the learner asks for", async () => {
      // Both words are started Tatar → Russian; a learner who has switched to Russian → Tatar has both ahead again.
      await finishedLevel1(2, { direction: "ru_tt" });
      expect(await pushes()).toEqual([ru.pushDaily(2, 1)]);
    });

    it("counts own words and the lowest open level that has new words, not the levels above it", async () => {
      const { repo, user } = await seedUser(env.DB, { now: local(30, 8, 0), words: 3, patch: { newPerDay: 20 } });
      const l2 = (await seedLevels(env.DB, { 2: Array.from({ length: 9 }, (_, i) => `сүз${i + 1}`) }))[2]!;
      await repo.subscribe(user.id, l2, local(30, 8, 0));
      await repo.insertNotes(await repo.customDeck(user.id, local(30, 8, 0)), [note("рәхмәт"), note("зинһар")]);
      // Two own words and the three words of level 1; the nine of level 2 come after level 1.
      expect(await pushes()).toEqual([ru.pushDaily(5, 2)]);
    });

    it("still counts the unseen words of the open levels first, without looking ahead", async () => {
      const { repo, user, noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), words: 3 });
      await repo.insertCard(user.id, noteIds[0]!, "tt_ru", gradedMem(local(29, 12, 0)));
      await seedLevels(env.DB, { 2: Array.from({ length: 9 }, (_, i) => `сүз${i + 1}`) });
      expect(await pushes()).toEqual([ru.pushDaily(2, 1)]);
    });
  });

  it("evening push only with a streak of 2+ and no study today", async () => {
    const future = local(30, 9, 0) + 10 * 86_400_000;
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 1, patch: { streak: 1, lastStudyDay: "2026-09-29", nextDailyAt: future } });
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 2, patch: { streak: 3, lastStudyDay: "2026-09-29", nextDailyAt: future } });
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 3, patch: { streak: 3, lastStudyDay: "2026-09-30", nextDailyAt: future } });
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
    const { repo, user, noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), words: 1, patch: { nextDailyAt: local(30, 9, 0) + 10 * 86_400_000 } });
    const t0 = local(30, 12, 0);
    await repo.insertCard(user.id, noteIds[0]!, "tt_ru", { ...newMem(t0), state: "learning", step: 1, due: t0 + 10 * MIN, reps: 1, lastReview: t0, stability: 2, difficulty: 5 });
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
    for (let i = 0; i < 40; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 1000 + i });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 1));
    expect(tg.of("sendMessage")).toHaveLength(35);
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(40);
  });

  it("403 deactivates the user", async () => {
    const { repo, user } = await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
    await run(env.DB, tg, local(30, 9, 1));
    expect((await repo.getUser(user.id))!.active).toBe(false);
  });

  it("429 reschedules as a job and the job is delivered later", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
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
      await preview(now - 2 * DAY);
      const db = countingDb(env.DB);
      await run(db, fakeTelegram(), now);
      expect(db.calls).toBe(2); // the batch that reads who is due, and the claim of queued jobs
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM previews").first()).toEqual({ n: 0 });
    });
  });

  it("tick uses at most 10 D1 calls", async () => {
    for (let i = 0; i < 5; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 2000 + i });
    await enqueue(env.DB, "push", { chat_id: 1, text: "x" }, local(30, 9, 0));
    const db = countingDb(env.DB);
    await run(db, fakeTelegram(), local(30, 9, 1));
    expect(db.calls).toBeLessThanOrEqual(10);
  });

  it("a tick with 40 users due for a reminder makes at most 35 sends and 10 D1 calls", async () => {
    for (let i = 0; i < 40; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 4000 + i });
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
    for (let i = 0; i < 40; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 6000 + i });
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
    const { repo, noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), words: 1, patch: { nextDailyAt: local(30, 9, 0) + 10 * 86_400_000 } });
    await enqueue(env.DB, "voice", { noteId: noteIds[0] }, local(30, 9, 0));
    const db = countingDb(env.DB);
    const tg = fakeTelegram();
    expect(await run(db, tg, local(30, 9, 1))).toEqual({ sent: 0 });
    expect(tg.calls).toEqual([]);
    expect(db.calls).toBeLessThanOrEqual(10);
    expect(await repo.getNote(noteIds[0]!)).toMatchObject({ audioFileId: null });
    expect(await env.DB.prepare("SELECT audio_tries FROM notes WHERE id = ?").bind(noteIds[0]).first()).toEqual({ audio_tries: 0 });
    // The job is closed, not retried every minute: voicing happens in GitHub Actions, the tick only clears the queue.
    const job = await env.DB.prepare("SELECT attempts, error, done_at FROM jobs").first<{ attempts: number; error: string | null; done_at: number | null }>();
    expect(job).toEqual({ attempts: 0, error: null, done_at: local(30, 9, 1) });
  });

  it("a failed send is not retried every minute", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 400, "Bad Request: chat not found");
    await run(env.DB, tg, local(30, 9, 1));
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(1);
  });

  it("users are marked before sending, so a crashed send never repeats", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const crashing = { call: async () => { throw new Error("network reset"); } };
    await tick({ repo: new Repo(env.DB), tg: crashing, now: local(30, 9, 1) }).catch(() => undefined);
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  it("the tick reads only due users (indexed next_daily_at)", async () => {
    for (let i = 0; i < 30; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 3000 + i, patch: { nextDailyAt: local(30, 9, 0) + 86_400_000 } });
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT u.id, u.chat_id FROM users u WHERE u.next_daily_at <= CAST(?1 AS INTEGER) AND +u.active = 1 AND u.onboarding_step IS NULL ORDER BY u.next_daily_at, u.id LIMIT 35").bind(local(30, 9, 1)).all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" ");
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_users_next_daily/);
    expect(detail).not.toMatch(/SCAN u\b/);
    const stepPlan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT u.id FROM users u WHERE u.last_review_at BETWEEN ?1 - 86400000 AND ?1 - 180000 AND +u.active = 1 AND u.onboarding_step IS NULL").bind(local(30, 9, 1)).all<{ detail: string }>();
    expect(stepPlan.results.map((r) => r.detail).join(" ")).toMatch(/idx_users_last_review/);
  });
});
