import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { readSpans, scopeKey } from "../../src/levels/order";
import { levelBit } from "../../src/levels/scale";
import { ReviewService, type Screen } from "../../src/review/service";
import { easyButton, harness } from "../helpers/botHarness";
import { bulkCatalog } from "../helpers/catalog";
import { countingDb } from "../helpers/countingDb";
import { asCard, gradeShown } from "../helpers/review";
import { note, seedCatalog, seedGuidedOrder, seedLearner } from "../helpers/seed";
import { type Shown, study } from "../helpers/sim";

const DAY = 86_400_000;
/** 09:00 local (+03:00) on the learner's first day; `day(n)` is the same hour of day n. */
const now = Date.UTC(2026, 8, 30, 6, 0);
const day = (n: number) => now + (n - 1) * DAY;

/** `n` catalog rows of a level, words `<prefix>1…`, with the topic and the part of speech of each place. */
const rows = (level: number, prefix: string, n: number, at: (i: number) => { topic?: number; pos?: string } = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ level, word: `${prefix}${i + 1}`, ...at(i) }));
const words = (shown: Shown[]) => shown.map((c) => c.word);
/** The words that were shown as new cards, in order. */
const fresh = (shown: Shown[]) => shown.filter((c) => c.fresh).map((c) => c.word);
/** The screen «Учить» gives the learner at `at`. */
const screenAt = async (repo: Repo, userId: number, at: number) => new ReviewService(repo, at).nextScreen((await repo.getUser(userId))!);
/** The reason the end-of-session screen gives for having no new words; throws when another screen came. */
const emptyOf = (s: Screen) => { if (s.kind !== "done") throw new Error(`expected done, got ${s.kind}`); return s.empty; };
const easy = { rate: () => 4 as const };

describe("new words by the learner's settings", () => {
  it("with A2 and B1 checked new words come only from them, A2 first in the order by frequency; then the bot offers the lowest level that is not checked", async () => {
    await seedCatalog(env.DB, [...rows(1, "а", 3), ...rows(2, "б", 3), ...rows(3, "в", 3), ...rows(4, "г", 2)]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { levels: levelBit(2) | levelBit(3), newMode: "freq" } });
    expect(words(await study(repo, user.id, now, easy))).toEqual(["б1", "б2", "б3", "в1", "в2", "в3"]);
    expect(emptyOf(await screenAt(repo, user.id, now + 60_000))).toEqual({ kind: "addLevel", level: 1 });
    // The bot checked nothing by itself.
    expect((await repo.getUser(user.id))!.levels).toBe(levelBit(2) | levelBit(3));
    const started = await env.DB.prepare("SELECT COUNT(*) AS n FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ? AND n.level NOT IN (2, 3)").bind(user.id).first<{ n: number }>();
    expect(started!.n).toBe(0);
  });

  it("guided: topic 1 of A2 comes before topic 2 of A2, and topic 1 of B1 before topic 2 of A2; a basic word stands among the words of its topic", async () => {
    const a2 = [2, 1, 0, 1]; // б1 topic 2, б2 topic 1, б3 basic, б4 topic 1
    await seedCatalog(env.DB, [...rows(1, "а", 2), ...rows(2, "б", 4, (i) => ({ topic: a2[i]! })), ...rows(3, "в", 2, (i) => ({ topic: i + 1 }))]);
    await seedGuidedOrder(env.DB);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { levels: levelBit(2) | levelBit(3) } });
    expect(user.newMode).toBe("guided");
    expect(words(await study(repo, user.id, now, easy))).toEqual(["б2", "б3", "б4", "в1", "б1", "в2"]);
  });

  it("topic: only the words of the chosen topic are given, and then the bot asks for a topic; the choice stays", async () => {
    const topics = [5, 1, 5, 2];
    await seedCatalog(env.DB, [...rows(1, "а", 4, (i) => ({ topic: topics[i]! })), ...rows(2, "б", 2, (i) => ({ topic: i ? 5 : 1 }))]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { levels: levelBit(1) | levelBit(2), newMode: "topic", topicNo: 5 } });
    expect(words(await study(repo, user.id, now, easy))).toEqual(["а1", "а3", "б2"]);
    expect(emptyOf(await screenAt(repo, user.id, now + 60_000))).toEqual({ kind: "pickTopic" });
    expect((await repo.getUser(user.id))!.topicNo).toBe(5);
    // With no topic chosen there are no new catalog words either.
    await repo.updateUser(user.id, { topicNo: null });
    expect(emptyOf(await screenAt(repo, user.id, now + 60_000))).toEqual({ kind: "pickTopic" });
  });

  it("guided with a chosen topic: that topic comes first; when it has no word left the choice is cleared and the order goes on from the first unfinished topic", async () => {
    const topics = [1, 1, 3, 3, 2];
    await seedCatalog(env.DB, rows(1, "а", 5, (i) => ({ topic: topics[i]! })));
    const { repo, user } = await seedLearner(env.DB, { now, patch: { topicNo: 3 } });
    let s = await new ReviewService(repo, now).nextScreen(user);
    expect(asCard(s).view.word).toBe("а3");
    s = await gradeShown(repo, user, s, 4, now);
    expect(asCard(s).view.word).toBe("а4");
    expect((await repo.getUser(user.id))!.topicNo).toBe(3);
    // The last word of the topic is graded: the same screen already shows the first word of the guided order.
    s = await gradeShown(repo, user, s, 4, now);
    expect(asCard(s).view.word).toBe("а1");
    expect(asCard(s).counts.n).toBe(10);
    expect((await repo.getUser(user.id))!.topicNo).toBeNull();
    expect(words(await study(repo, user.id, now + 60_000, easy))).toEqual(["а1", "а2", "а5"]);
    expect(emptyOf(await screenAt(repo, user.id, now + 120_000))).toEqual({ kind: "allDone" });
  });

  it("a topic chosen while the finished one was being cleared is kept, with its read positions", async () => {
    const { repo, user } = await seedLearner(env.DB, { now, patch: { topicNo: 7, newCursors: "{}" } });
    await repo.batch([repo.clearTopicStmt(user.id, 3)]);
    expect((await repo.getUser(user.id))!).toMatchObject({ topicNo: 7, newCursors: "{}" });
    await repo.batch([repo.clearTopicStmt(user.id, 7)]);
    expect((await repo.getUser(user.id))!).toMatchObject({ topicNo: null, newCursors: null });
  });

  it("the 🔵 counter, also on the card that undo brings back: the day's limit while a level has a word to give; else the new cards that are left", async () => {
    await seedCatalog(env.DB, rows(1, "а", 3));
    const { repo, user } = await seedLearner(env.DB, { now });
    const me = async () => (await repo.getUser(user.id))!;
    let s = await new ReviewService(repo, now).nextScreen(user);
    expect(asCard(s).counts).toEqual({ n: 10, l: 0, r: 0 });
    // «а1» is graded «Хорошо» and the grade is taken back: the level still has a word to give, and no card is on a learning step any more.
    s = await gradeShown(repo, user, s, 3, now);
    expect([asCard(s).view.word, asCard(s).counts]).toEqual(["а2", { n: 9, l: 1, r: 0 }]);
    s = await new ReviewService(repo, now).undo(await me());
    expect([asCard(s).view.word, asCard(s).counts]).toEqual(["а1", { n: 10, l: 0, r: 0 }]);
    // Every word of the checked level is started; two own words are all that is new.
    for (let i = 0; i < 3; i++) s = await gradeShown(repo, user, s, 4, now);
    expect(s.kind).toBe("done");
    await repo.insertNotes(await repo.customDeck(user.id, now), [note("үзем1"), note("үзем2")]);
    s = await screenAt(repo, user.id, now);
    expect([asCard(s).view.word, asCard(s).counts]).toEqual(["үзем1", { n: 2, l: 0, r: 0 }]);
    s = await gradeShown(repo, user, s, 4, now);
    expect([asCard(s).view.word, asCard(s).counts]).toEqual(["үзем2", { n: 1, l: 0, r: 0 }]);
    s = await new ReviewService(repo, now).undo(await me());
    expect([asCard(s).view.word, asCard(s).counts]).toEqual(["үзем1", { n: 2, l: 0, r: 0 }]);
  });

  it("a level unchecked after ten words: the ten keep coming for review and no new word of it is given; checked again, its eleventh word is next", async () => {
    await seedCatalog(env.DB, [...rows(1, "а", 12), ...rows(2, "б", 3)]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { newMode: "freq", newPerDay: 10 } });
    const ten = Array.from({ length: 10 }, (_, i) => `а${i + 1}`);
    // Day 1: the daily ten of A1, each graded «Хорошо» until it leaves the learning steps.
    expect(fresh(await study(repo, user.id, day(1), { rate: () => 3 }))).toEqual(ten);
    // The learner unchecks A1 and checks A2.
    await repo.updateUser(user.id, { levels: levelBit(2) });
    const later = await study(repo, user.id, day(15), { rate: () => 3 });
    expect(fresh(later)).toEqual(["б1", "б2", "б3"]);
    expect([...new Set(later.filter((c) => !c.fresh && c.word.startsWith("а")).map((c) => c.word))].sort()).toEqual([...ten].sort());
    expect(emptyOf(await screenAt(repo, user.id, day(15) + 3_600_000))).toEqual({ kind: "addLevel", level: 1 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ?").bind(user.id).first<{ n: number }>())!.n).toBe(13);
    // A1 is checked again: its eleventh word is the next new one.
    await repo.updateUser(user.id, { levels: levelBit(1) | levelBit(2) });
    expect(fresh(await study(repo, user.id, day(16), { rate: () => 3 }))).toEqual(["а11", "а12"]);
  });

  it("a card that was on the screen when its level was unchecked is still given, once: the learner has seen that word; no other word of the level follows", async () => {
    await seedCatalog(env.DB, [...rows(1, "а", 3), ...rows(2, "б", 2)]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { newMode: "freq" } });
    expect(asCard(await new ReviewService(repo, now).nextScreen(user)).view.word).toBe("а1");
    await repo.updateUser(user.id, { levels: levelBit(2) });
    expect(words(await study(repo, user.id, now + 60_000, easy))).toEqual(["а1", "б1", "б2"]);
  });

  it("with numerals only, only numerals are given; when none is left and other words remain, the bot offers every part of speech", async () => {
    const pos = ["n", "num", "v", "num", "adj"];
    await seedCatalog(env.DB, [...rows(1, "а", 5, (i) => ({ pos: pos[i]! })), ...rows(2, "б", 2)]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { newMode: "freq", posGroups: 1 << 5 } });
    expect(words(await study(repo, user.id, now, easy))).toEqual(["а2", "а4"]);
    expect(emptyOf(await screenAt(repo, user.id, now + 60_000))).toEqual({ kind: "allPos" });
    await repo.updateUser(user.id, { posGroups: 255 });
    expect(words(await study(repo, user.id, now + 120_000, easy))).toEqual(["а1", "а3", "а5"]);
  });

  it("with a narrowed set of parts of speech, words the learner owns a copy of are not words left in the level: the bot does not offer every part of speech for them (ruling T6a)", async () => {
    const pos = ["num", "n", "v"];
    await seedCatalog(env.DB, [...rows(1, "а", 3, (i) => ({ pos: pos[i]! })), ...rows(2, "б", 1)]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { newMode: "freq", posGroups: 1 << 5 } });
    // The noun and the verb of A1 are the learner's own words too; they are started there.
    const deck = await repo.customDeck(user.id, now);
    await repo.insertNotes(deck, [note("а2"), note("а3")]);
    expect(words(await study(repo, user.id, now, easy))).toEqual(["а2", "а3", "а1"]);
    // Nothing of A1 is left for any part of speech: the next thing to offer is A2, not the other parts of speech.
    expect(emptyOf(await screenAt(repo, user.id, now + 60_000))).toEqual({ kind: "addLevel", level: 2 });
    await repo.updateUser(user.id, { posGroups: 255 });
    expect(emptyOf(await screenAt(repo, user.id, now + 120_000))).toEqual({ kind: "addLevel", level: 2 });
  });

  it("every checked level is in work: the bot offers the lowest unchecked level that has cards, and says so when nothing is left anywhere", async () => {
    await seedCatalog(env.DB, [...rows(1, "а", 2), ...rows(2, "б", 1)]);
    const { repo, user } = await seedLearner(env.DB, { now });
    expect(words(await study(repo, user.id, now, easy))).toEqual(["а1", "а2"]);
    expect(emptyOf(await screenAt(repo, user.id, now + 60_000))).toEqual({ kind: "addLevel", level: 2 });
    expect((await repo.getUser(user.id))!.levels).toBe(levelBit(1));
    await repo.updateUser(user.id, { levels: levelBit(1) | levelBit(2) });
    expect(words(await study(repo, user.id, now + 120_000, easy))).toEqual(["б1"]);
    expect(emptyOf(await screenAt(repo, user.id, now + 180_000))).toEqual({ kind: "allDone" });
  });

  it("own words come before catalog words and take no notice of the checkboxes", async () => {
    await seedCatalog(env.DB, [...rows(1, "а", 1), ...rows(2, "б", 2, (i) => ({ pos: i ? "num" : "n" }))]);
    const { repo, user } = await seedLearner(env.DB, { now, patch: { levels: levelBit(2), posGroups: 1 << 5 } });
    await repo.insertNotes(await repo.customDeck(user.id, now), [note("үзем1"), note("үзем2")]);
    const first = asCard(await new ReviewService(repo, now).nextScreen(user));
    expect(first.view.word).toBe("үзем1");
    expect(words(await study(repo, user.id, now + 60_000, easy))).toEqual(["үзем1", "үзем2", "б2"]);
  });

  it("the daily limit holds, «Легко» on a first sight does not spend it, and the reason for no new words is given only while new words are still allowed", async () => {
    await seedCatalog(env.DB, rows(1, "а", 8));
    const { repo, user } = await seedLearner(env.DB, { now, patch: { newPerDay: 3 } });
    let s = await new ReviewService(repo, now).nextScreen(user);
    const left: number[] = [];
    for (const rating of [4, 4, 3, 3] as const) {
      left.push(asCard(s).counts.n);
      s = await gradeShown(repo, user, s, rating, now);
    }
    expect(left).toEqual([3, 3, 3, 2]);
    expect(asCard(s).counts.n).toBe(1);
    expect(asCard(s).view.word).toBe("а5");
    s = await gradeShown(repo, user, s, 3, now);
    // The limit is spent: no sixth word today, and nothing is said about levels.
    expect(s.kind).toBe("done");
    expect(emptyOf(s)).toBeNull();
    expect(fresh(await study(repo, user.id, day(2), { rate: () => 3 }))).toEqual(["а6", "а7", "а8"]);
  });

  it("a learner with nothing at all gets the empty screen; one who has cards gets the end of the session", async () => {
    const { repo, user } = await seedLearner(env.DB, { now });
    expect((await new ReviewService(repo, now).nextScreen(user)).kind).toBe("nothing");
    // The catalog gets its first word; a load of the catalog moves its version, so the stored end of the level is not trusted.
    await seedCatalog(env.DB, rows(1, "а", 1, () => ({ topic: 4 })));
    await env.DB.prepare("UPDATE meta SET value = '1' WHERE key = 'catalog_version'").run();
    await repo.updateUser(user.id, { newMode: "topic" });
    expect((await screenAt(repo, user.id, now)).kind).toBe("nothing");
    await repo.updateUser(user.id, { newMode: "guided" });
    const s = await gradeShown(repo, user, await screenAt(repo, user.id, now), 4, now);
    expect(s).toMatchObject({ kind: "done", empty: { kind: "allDone" }, summary: { reviewsToday: 1, learnedToday: 0, nextLearningInMs: null, streak: 1 } });
    expect(s.kind === "done" && "totals" in s.summary).toBe(false);
  });
});

describe("the read positions of the levels (users.new_cursors)", () => {
  it("a word added to the catalog before the stored position is still given: a position stored for another catalog version is not used, and a new one is stored", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 40));
    const { repo, user } = await seedLearner(env.DB, { now, patch: { newMode: "freq" } });
    let s = await new ReviewService(repo, now).nextScreen(user);
    for (let i = 0; i < 30; i++) s = await gradeShown(repo, user, s, 4, now);
    expect(asCard(s).view.word).toBe("а31");
    const before = (await repo.getUser(user.id))!;
    const stored = readSpans(before.newCursors, scopeKey(before));
    expect(stored.version).toBe(0);
    expect(stored.spans[1]!.from).toBeGreaterThanOrEqual(25);
    // The catalog is loaded again with a new word at the fifth place of A1; the load moves the version.
    await env.DB.batch([
      env.DB.prepare("UPDATE notes SET seq = seq + 1, tseq = tseq + 1 WHERE level = 1 AND seq >= 5"),
      env.DB.prepare("INSERT INTO notes (deck_id, word, word_key, pos, translation, level, topic_no, seq, tseq) SELECT deck_id, 'яңа', 'яңа', 'n', 'новый', 1, 0, 5, 5 FROM notes WHERE id = ?").bind(ids[0]!),
      env.DB.prepare("UPDATE meta SET value = '1' WHERE key = 'catalog_version'"),
    ]);
    s = await gradeShown(repo, user, s, 4, now);
    expect(asCard(s).view.word).toBe("яңа");
    const after = (await repo.getUser(user.id))!;
    expect(readSpans(after.newCursors, scopeKey(after))).toEqual({ version: 1, spans: { 1: { from: 4, to: null } } });
    s = await gradeShown(repo, user, s, 4, now);
    expect(asCard(s).view.word).toBe("а32");
  });
});

describe("D1 and Telegram calls of one update", () => {
  /** A learner (Telegram id 42) at the bot, and `update`: one update with the D1 and the Telegram calls it made. */
  async function atTheBot(patch: Parameters<typeof seedLearner>[1]["patch"]) {
    const { user } = await seedLearner(env.DB, { now, tgId: 42, patch });
    const db = countingDb(env.DB);
    const h = harness(db, { now });
    const update = async (run: () => Promise<unknown>) => {
      const before = h.tg.calls.length;
      db.calls = 0;
      await run();
      return { d1: db.calls, tg: h.tg.calls.length - before };
    };
    const easyGrade = () => update(() => h.press(easyButton(h), h.tg.lastMessageId()));
    return { h, user, update, easyGrade };
  }

  it("a grade is at most 8 D1 calls; the grade that stores the read position is one call more than a plain one; after 30 new words the position of the level is 25 or more", async () => {
    await bulkCatalog(env.DB, { sizes: { 1: 40 } });
    const { h, user, update, easyGrade } = await atTheBot({ newMode: "freq" });
    const first = await update(() => h.text("/learn"));
    expect(h.lastText()).toContain("<b>сүз1х1</b>");
    expect(first.d1).toBeLessThanOrEqual(8);
    const grades: { d1: number; tg: number }[] = [];
    for (let i = 0; i < 30; i++) grades.push(await easyGrade());
    expect(h.lastText()).toContain("<b>сүз1х31</b>");
    const plain = grades[0]!.d1;
    expect(plain).toBe(6);
    // The position is stored when it has moved by 25 words: by the 25th grade, and by no other of the thirty.
    expect(grades.map((g) => g.d1)).toEqual(grades.map((_, i) => (i === 24 ? plain + 1 : plain)));
    expect(Math.max(...grades.map((g) => g.tg))).toBeLessThanOrEqual(3);
    const u = (await new Repo(env.DB).getUser(user.id))!;
    expect(readSpans(u.newCursors, scopeKey(u)).spans[1]!.from).toBeGreaterThanOrEqual(25);
  });

  it("with no positions to store (`topic` with no topic chosen) an empty set is stored once, so the next read costs no write", async () => {
    await seedCatalog(env.DB, rows(1, "а", 1, () => ({ topic: 4 })));
    const { h, user, update, easyGrade } = await atTheBot({});
    await update(() => h.text("/learn"));
    await easyGrade();
    await new Repo(env.DB).updateUser(user.id, { newMode: "topic" });
    // The queue, the positions, the day's log with the counters, the session message — and the user row every update reads.
    expect((await update(() => h.text("/learn"))).d1).toBe(5);
    expect(h.lastText()).toContain("Сегодня: 1 повт.");
    expect((await update(() => h.text("/learn"))).d1).toBe(4);
  });

  it("the grade that finishes a chosen topic in the guided order reads the queue twice and clears the choice in the batch of the second read: one D1 call more than a plain grade; the grade after it stores the positions", async () => {
    await seedCatalog(env.DB, rows(1, "а", 6, (i) => ({ topic: i < 2 ? 3 : 1 })));
    const { h, user, update, easyGrade } = await atTheBot({ topicNo: 3 });
    const me = async () => (await new Repo(env.DB).getUser(user.id))!;
    await update(() => h.text("/learn"));
    expect(h.lastText()).toContain("<b>а1</b>");
    const plain = await easyGrade();
    expect(h.lastText()).toContain("<b>а2</b>");
    expect(plain.d1).toBe(6);
    const clearing = await easyGrade();
    expect(h.lastText()).toContain("<b>а3</b>");
    expect(clearing.d1).toBe(plain.d1 + 1);
    expect(clearing.tg).toBeLessThanOrEqual(3);
    expect(await me()).toMatchObject({ topicNo: null, newCursors: null });
    // The next read finds no position stored for the order without a topic and stores what it sees; then grades are plain again.
    const storing = await easyGrade();
    expect(h.lastText()).toContain("<b>а4</b>");
    expect(storing.d1).toBe(plain.d1 + 1);
    const after = await me();
    expect(readSpans(after.newCursors, scopeKey(after))).toEqual({ version: 0, spans: { 1: { from: 1_000_003, to: null } } });
    expect((await easyGrade()).d1).toBe(plain.d1);
    expect(h.lastText()).toContain("<b>а5</b>");
  });

  it("the grade that ends the session, with the reason for no new words and the position of the finished level stored, is within 8 D1 calls", async () => {
    await seedCatalog(env.DB, [...rows(1, "а", 2), ...rows(2, "б", 1)]);
    const { h, update, easyGrade } = await atTheBot({});
    await update(() => h.text("/learn"));
    await easyGrade();
    const last = await easyGrade();
    expect(h.lastText()).toContain("Сегодня: 2 повт.");
    expect(last.d1).toBe(7);
    expect(last.tg).toBeLessThanOrEqual(3);
    // Undo of that grade: the card comes back, within the same budget.
    const undo = await update(() => h.text("/undo"));
    expect(h.lastText()).toContain("<b>а2</b>");
    expect(undo.d1).toBeLessThanOrEqual(8);
    expect(undo.tg).toBeLessThanOrEqual(3);
  });
});
