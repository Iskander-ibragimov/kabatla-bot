import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type DayWindow, type Direction, type NewScope, type Queue, Repo } from "../../src/db/repo";
import { STREAM_LIMIT, nextSpans } from "../../src/levels/order";
import { newMem } from "../../src/srs/fsrs";
import { dayWindow } from "../../src/users/service";
import { countingDb } from "../helpers/countingDb";
import { gradedMem, logStmt } from "../helpers/review";
import { note, seedCatalog, seedLearner } from "../helpers/seed";

const MIN = 60_000;
const DAY = 86_400_000;
/** 10:00 at UTC+3 on 2026-09-30. */
const T = Date.UTC(2026, 8, 30, 7, 0);
const TODAY = "2026-09-30";
const BOTH: Direction[] = ["tt_ru", "ru_tt"];

const win = (directions: Direction[] = ["tt_ru"], now = T): DayWindow => ({ ...dayWindow(180, now), directions });
const scope = (s: Partial<NewScope> = {}): NewScope => ({ levels: [1], posCodes: null, mode: "freq", topicNo: null, spans: {}, spansVersion: 0, ...s });
/** The stream of a level as `word/direction`, or as words when the learner asks one direction. */
const stream = (q: Queue, level: number) => (q.streams[level] ?? []).map((x) => x.word);
const cards = (q: Queue, level: number) => (q.streams[level] ?? []).map((x) => `${x.word}/${x.direction}`);
/**
 * The words a level gives one after another, up to `n`: the note of each read's stream is started (a card graded
 * yesterday for every card the stream gave) and the read position is moved as the session moves it.
 */
async function inTurn(repo: Repo, userId: number, w: DayWindow, s: NewScope, level: number, n = 9): Promise<string[]> {
  const out: string[] = [];
  let spans = s.spans;
  for (let i = 0; i < n; i++) {
    const q = await repo.queue(userId, w, { ...s, spans });
    const given = q.streams[level] ?? [];
    if (!given.length) break;
    out.push(given[0]!.word);
    for (const c of given) await repo.insertCard(userId, c.noteId, c.direction, gradedMem(T - DAY));
    spans = nextSpans(spans, q.seen).spans;
  }
  return out;
}
/** `n` catalog rows of a level, words `<prefix>1…`, with the topic and the part of speech of each place. */
const rows = (level: number, prefix: string, n: number, at: (i: number) => { topic?: number; pos?: string } = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ level, word: `${prefix}${i + 1}`, ...at(i) }));

describe("repo.queue: the streams of new catalog words", () => {
  it("freq: the first notes of every level of the scope in the order of the level, and nothing of an unchecked level", async () => {
    const topics1 = [3, 1, 2, 1];
    const topics2 = [2, 0, 1, 0];
    const ids = await seedCatalog(env.DB, [
      ...rows(1, "а", 4, (i) => ({ topic: topics1[i]! })), ...rows(2, "б", 4, (i) => ({ topic: topics2[i]! })), ...rows(3, "в", 2),
    ]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const q = await repo.queue(user.id, win(), scope({ levels: [1, 2], mode: "freq" }));
    expect(STREAM_LIMIT).toBe(1);
    expect(Object.keys(q.streams)).toEqual(["1", "2"]);
    expect(stream(q, 1)).toEqual(["а1"]);
    expect(stream(q, 2)).toEqual(["б1"]);
    expect(q.seen).toEqual({ 1: { first: 1, last: 1, full: true }, 2: { first: 1, last: 1, full: true } });
    expect(q.streams[1]![0]).toEqual({
      noteId: ids[0], direction: "tt_ru", level: 1, topicNo: 3, seq: 1,
      word: "а1", transcription: null, pos: "n", translation: "а1-ru", exampleTt: "а1.", exampleRu: "а1-ru.", exampleSrc: "own", audioFileId: null, sourceUrl: null,
    });
    expect(q.streams[2]![0]).toMatchObject({ noteId: ids[4], level: 2, topicNo: 2, seq: 1 });
    const s = scope({ levels: [1, 2], mode: "freq" });
    expect(await inTurn(repo, user.id, win(), s, 1)).toEqual(["а1", "а2", "а3", "а4"]);
    expect(await inTurn(repo, user.id, win(), s, 2)).toEqual(["б1", "б2", "б3", "б4"]);
    // Both levels are finished for this scope; the unchecked one was never read.
    const done = await repo.queue(user.id, win(), s);
    expect(done.streams).toEqual({ 1: [], 2: [] });
    expect(done.seen).toEqual({ 1: { first: null, last: null, full: false }, 2: { first: null, last: null, full: false } });
  });

  it("guided: the notes of a level by topic, and inside a topic in the order of the level; `seen` holds the topic order values", async () => {
    const topics1 = [3, 1, 2, 1];
    const topics2 = [2, 0, 1, 0];
    await seedCatalog(env.DB, [...rows(1, "а", 4, (i) => ({ topic: topics1[i]! })), ...rows(2, "б", 4, (i) => ({ topic: topics2[i]! }))]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const s = scope({ levels: [1, 2], mode: "guided" });
    const q = await repo.queue(user.id, win(), s);
    expect(stream(q, 1)).toEqual(["а2"]);
    expect(stream(q, 2)).toEqual(["б2"]);
    expect(q.seen).toEqual({ 1: { first: 1_000_002, last: 1_000_002, full: true }, 2: { first: 2, last: 2, full: true } });
    expect(q.streams[1]!.map((x) => [x.topicNo, x.seq])).toEqual([[1, 2]]);
    expect(await inTurn(repo, user.id, win(), s, 1)).toEqual(["а2", "а4", "а3", "а1"]);
    expect(await inTurn(repo, user.id, win(), s, 2)).toEqual(["б2", "б4", "б3", "б1"]);
  });

  it("a chosen topic: only its notes, in `topic` and in `guided`; a level without it has an empty stream; `freq` takes no notice of a topic", async () => {
    const topics1 = [5, 1, 5, 6, 5, 5];
    await seedCatalog(env.DB, [...rows(1, "а", 6, (i) => ({ topic: topics1[i]! })), ...rows(2, "б", 3, (i) => ({ topic: i === 1 ? 5 : 4 })), ...rows(3, "в", 2, () => ({ topic: 6 }))]);
    const { repo, user } = await seedLearner(env.DB, { now: T });
    for (const mode of ["topic", "guided"] as const) {
      const q = await repo.queue(user.id, win(), scope({ levels: [1, 2, 3], mode, topicNo: 5, spans: { 1: { from: 5_000_001, to: null } } }));
      expect(stream(q, 1)).toEqual(["а3"]);
      expect(stream(q, 2)).toEqual(["б2"]);
      expect(stream(q, 3)).toEqual([]);
      expect(q.seen).toEqual({
        1: { first: 5_000_003, last: 5_000_003, full: true }, 2: { first: 5_000_002, last: 5_000_002, full: true }, 3: { first: null, last: null, full: false },
      });
    }
    const freq = scope({ levels: [1], mode: "freq", topicNo: 5 });
    expect(await inTurn(repo, user.id, win(), scope({ levels: [1, 2, 3], mode: "topic", topicNo: 5 }), 1)).toEqual(["а1", "а3", "а5", "а6"]);
    expect(await inTurn(repo, user.id, win(), scope({ levels: [1, 2, 3], mode: "guided", topicNo: 5 }), 2)).toEqual(["б2"]);
    // What is left of level 1 lies outside the topic: `freq` gives it, the topic order with the topic chosen does not.
    expect(await inTurn(repo, user.id, win(), freq, 1)).toEqual(["а2", "а4"]);
  });

  it("`topic` with no topic chosen has no new catalog words: no stream is read and nothing is seen", async () => {
    await seedCatalog(env.DB, rows(1, "а", 4, () => ({ topic: 5 })));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const q = await repo.queue(user.id, win(), scope({ levels: [1], mode: "topic", topicNo: null }));
    expect(q.streams).toEqual({});
    expect(q.seen).toEqual({});
  });

  it("parts of speech: only the notes of the given codes, however far into the level they are", async () => {
    const pos = ["n", "v", "num", "n", "num", "adj", "post", "num", "num"];
    await seedCatalog(env.DB, rows(1, "а", 9, (i) => ({ pos: pos[i]! })));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const num = await repo.queue(user.id, win(), scope({ posCodes: ["num"] }));
    expect(stream(num, 1)).toEqual(["а3"]);
    expect(num.seen[1]).toEqual({ first: 3, last: 3, full: true });
    expect(num.streams[1]![0]!.pos).toBe("num");
    expect(await inTurn(repo, user.id, win(), scope({ posCodes: ["num"] }), 1)).toEqual(["а3", "а5", "а8", "а9"]);
    const two = scope({ posCodes: ["post", "adj"] });
    expect((await repo.queue(user.id, win(), two)).seen[1]).toEqual({ first: 6, last: 6, full: true });
    expect(await inTurn(repo, user.id, win(), two, 1)).toEqual(["а6", "а7"]);
    expect((await repo.queue(user.id, win(), two)).seen[1]).toEqual({ first: null, last: null, full: false });
    // With every part of speech asked again, the words of the other ones are still there.
    expect(await inTurn(repo, user.id, win(), scope(), 1)).toEqual(["а1", "а2", "а4"]);
  });

  it("a note with a started tt_ru card is passed for a tt_ru learner and is given Russian → Tatar to a learner of both directions", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 4));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    await repo.insertCard(user.id, ids[0]!, "tt_ru", gradedMem(T - DAY));
    const one = await repo.queue(user.id, win(["tt_ru"]), scope());
    expect(cards(one, 1)).toEqual(["а2/tt_ru"]);
    expect(one.seen[1]).toEqual({ first: 2, last: 2, full: true });
    const both = await repo.queue(user.id, win(BOTH), scope());
    expect(cards(both, 1)).toEqual(["а1/ru_tt"]);
    expect(both.seen[1]).toEqual({ first: 1, last: 1, full: true });
    // A note with no card at all: one card for every asked direction, in the order asked.
    const after = scope({ spans: { 1: { from: 1, to: null } } });
    expect(cards(await repo.queue(user.id, win(BOTH), after), 1)).toEqual(["а2/tt_ru", "а2/ru_tt"]);
    expect(cards(await repo.queue(user.id, win(["ru_tt", "tt_ru"]), after), 1)).toEqual(["а2/ru_tt", "а2/tt_ru"]);
    expect(cards(await repo.queue(user.id, win(["ru_tt"]), scope()), 1)).toEqual(["а1/ru_tt"]);
  });

  it("a card that was shown and not graded is a row in state 'new': its note is passed by the stream and the card comes in `newRows`", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 4));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    await repo.ensureNewCard(user.id, ids[1]!, "tt_ru", newMem(T));
    const q = await repo.queue(user.id, win(), scope());
    expect(stream(q, 1)).toEqual(["а1"]);
    expect(q.newRows.map((x) => [x.noteId, x.direction, x.word])).toEqual([[ids[1], "tt_ru", "а2"]]);
    expect(stream(await repo.queue(user.id, win(), scope({ spans: { 1: { from: 1, to: null } } })), 1)).toEqual(["а3"]);
  });

  it("a level word the learner owns a copy of is passed, by the stream and as a row in state 'new'", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 5));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const [own] = await repo.insertNotes(await repo.customDeck(user.id, T), [note("А2!", "моё")]);
    await repo.ensureNewCard(user.id, ids[2]!, "tt_ru", newMem(T));
    await repo.insertNotes(await repo.customDeck(user.id, T), [note("а3")]);
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    await repo.insertNotes(await repo.customDeck(other.user.id, T), [note("а1")]);
    const q = await repo.queue(user.id, win(), scope());
    // а1 is a word of another learner's deck, not of this one's.
    expect(stream(q, 1)).toEqual(["а1"]);
    expect(await inTurn(repo, user.id, win(), scope(), 1)).toEqual(["а1", "а4", "а5"]);
    expect(q.newRows).toEqual([]);
    expect(q.ownNew.map((x) => x.word)).toEqual(["А2!", "а3"]);
    expect(q.ownNew[0]).toMatchObject({ noteId: own, direction: "tt_ru", translation: "моё" });
  });

  it("a word hidden today is passed: the grade that hides it creates its other card, which waits in state 'new' until tomorrow", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 4));
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const cardId = await repo.ensureNewCard(user.id, ids[0]!, "tt_ru", newMem(T));
    // The statements of a grade that matter here: the card, then its sibling.
    await repo.batch([repo.gradeCardStmt(cardId, 0, gradedMem(T)), repo.guardedSiblingStmt(user.id, ids[0]!, "ru_tt", TODAY, T)]);
    const today = await repo.queue(user.id, win(BOTH), scope());
    expect(cards(today, 1)).toEqual(["а2/tt_ru", "а2/ru_tt"]);
    expect(today.seen[1]).toEqual({ first: 2, last: 2, full: true });
    expect(today.newRows).toEqual([]);
    const tomorrow = await repo.queue(user.id, win(BOTH, T + DAY), scope());
    expect(tomorrow.newRows.map((x) => `${x.word}/${x.direction}`)).toEqual(["а1/ru_tt"]);
    expect(cards(tomorrow, 1)).toEqual(cards(today, 1));
    // The grade is taken back: the card is new again and not hidden itself, but its word stays hidden for the day.
    await repo.updateCardStmt(cardId, newMem(T)).run();
    expect((await repo.queue(user.id, win(BOTH), scope())).newRows).toEqual([]);
    expect((await repo.queue(user.id, win(BOTH, T + DAY), scope())).newRows.map((x) => `${x.word}/${x.direction}`)).toEqual(["а1/tt_ru", "а1/ru_tt"]);
  });

  it("what is hidden today is not kept out of a stream: it holds no filter on hidden words, so a level cannot look finished because of them", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 3));
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    // A state no grade produces — a hidden card whose word lacks the other card: the stream still gives that card.
    for (const id of ids) await repo.insertCard(user.id, id, "tt_ru", gradedMem(T), TODAY);
    const q = await repo.queue(user.id, win(BOTH), scope());
    expect(cards(q, 1)).toEqual(["а1/ru_tt"]);
    expect(q.seen[1]).toEqual({ first: 1, last: 1, full: true });
  });

  describe("read positions", () => {
    async function sixty() {
      const ids = await seedCatalog(env.DB, rows(1, "а", 60));
      const { repo, user } = await seedLearner(env.DB, { now: T });
      return { ids, repo, user };
    }

    it("a span {from: 40, to: null} starts after 40", async () => {
      const { repo, user } = await sixty();
      const q = await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: null } } }));
      expect(stream(q, 1)).toEqual(["а41"]);
      expect(q.seen[1]).toEqual({ first: 41, last: 41, full: true });
    });

    it("a span {from: 40, to: 55} stops at 55", async () => {
      const { ids, repo, user } = await sixty();
      for (let i = 41; i <= 53; i++) await repo.insertCard(user.id, ids[i - 1]!, "tt_ru", gradedMem(T - DAY));
      const q = await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: 55 } } }));
      expect(stream(q, 1)).toEqual(["а54"]);
      expect(q.seen[1]).toEqual({ first: 54, last: 54, full: true });
      // With 54 and 55 started nothing is given, though the level goes on to 60: the span ends at 55.
      for (const i of [54, 55]) await repo.insertCard(user.id, ids[i - 1]!, "tt_ru", gradedMem(T - DAY));
      const end = await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: 55 } } }));
      expect(end.streams[1]).toEqual([]);
      expect(end.seen[1]).toEqual({ first: null, last: null, full: false });
      expect(stream(await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: null } } })), 1)).toEqual(["а56"]);
      // A level that is finished for this scope: from = to.
      const done = await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: 40 } } }));
      expect(done.streams[1]).toEqual([]);
      expect(done.seen[1]).toEqual({ first: null, last: null, full: false });
    });

    it("a span stored for another catalog version is ignored: the whole level is read", async () => {
      const { repo, user } = await sixty();
      const stale = await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: 55 } }, spansVersion: 3 }));
      expect(stream(stale, 1)).toEqual(["а1"]);
      expect(stale.catalogVersion).toBe(0);
      await env.DB.prepare("UPDATE meta SET value = '3' WHERE key = 'catalog_version'").run();
      const fresh = await repo.queue(user.id, win(), scope({ spans: { 1: { from: 40, to: 55 } }, spansVersion: 3 }));
      expect(stream(fresh, 1)).toEqual(["а41"]);
      expect(fresh.catalogVersion).toBe(3);
    });

    it("in the topic order a span is a pair of topic order values, and it narrows a chosen topic further", async () => {
      await seedCatalog(env.DB, rows(1, "а", 12, (i) => ({ topic: i % 2 ? 5 : 2 })));
      const { repo, user } = await seedLearner(env.DB, { now: T });
      const at = async (s: Partial<NewScope>, from: number, to: number | null) => stream(await repo.queue(user.id, win(), scope({ ...s, spans: { 1: { from, to } } })), 1);
      const guided = { mode: "guided" as const };
      expect(await at(guided, 2_000_009, 5_000_004)).toEqual(["а11"]);
      expect(await at(guided, 2_000_011, 5_000_004)).toEqual(["а2"]);
      expect(await at(guided, 5_000_002, 5_000_004)).toEqual(["а4"]);
      expect(await at(guided, 5_000_004, 5_000_004)).toEqual([]);
      const topic = { mode: "topic" as const, topicNo: 5 };
      expect(await at(topic, 5_000_004, 5_000_008)).toEqual(["а6"]);
      expect(await at(topic, 5_000_006, 5_000_008)).toEqual(["а8"]);
      expect(await at(topic, 5_000_008, 5_000_008)).toEqual([]);
      // A span that lies before the chosen topic leaves the topic whole; the notes of the topics between are not given.
      expect(await at(topic, 2_000_003, null)).toEqual(["а2"]);
      // A span that ends before the chosen topic leaves nothing of it.
      expect(await at(topic, 2_000_003, 2_000_011)).toEqual([]);
    });
  });
});

describe("repo.queue: cards that exist", () => {
  it("`newRows` gives the reverse card of a word graded yesterday whatever the scope is, in a direction that is asked", async () => {
    const ids = await seedCatalog(env.DB, [...rows(1, "а", 2), ...rows(2, "б", 2, () => ({ topic: 4, pos: "v" }))]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    await repo.insertCard(user.id, ids[3]!, "tt_ru", gradedMem(T - DAY));
    await repo.insertCard(user.id, ids[3]!, "ru_tt", newMem(T - DAY), "2026-09-29");
    const narrow = scope({ levels: [1], posCodes: ["num"], mode: "topic", topicNo: 7 });
    const q = await repo.queue(user.id, win(BOTH), narrow);
    expect(q.newRows).toEqual([{
      noteId: ids[3], direction: "ru_tt", word: "б2", transcription: null, pos: "v", translation: "б2-ru",
      exampleTt: "б2.", exampleRu: "б2-ru.", exampleSrc: "own", audioFileId: null, sourceUrl: null,
    }]);
    expect(q.streams).toEqual({ 1: [] });
    expect((await repo.queue(user.id, win(["tt_ru"]), narrow)).newRows).toEqual([]);
    expect((await repo.queue(user.id, win(["ru_tt"]), narrow)).newRows).toHaveLength(1);
  });

  it("`newRows` come in the order of the note ids, the directions of a note as asked, twenty at most; own words are not among them", async () => {
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    // The own word is older than the catalog: its card is the first row of the index.
    const [own] = await repo.insertNotes(await repo.customDeck(user.id, T), [note("үзем")]);
    await repo.ensureNewCard(user.id, own!, "tt_ru", newMem(T));
    const ids = await seedCatalog(env.DB, rows(1, "а", 12));
    expect(own).toBeLessThan(ids[0]!);
    for (const id of [...ids].reverse()) for (const d of BOTH) await repo.ensureNewCard(user.id, id, d, newMem(T));
    const q = await repo.queue(user.id, win(BOTH), scope());
    expect(q.newRows).toHaveLength(20);
    expect(q.newRows.slice(0, 4).map((x) => `${x.word}/${x.direction}`)).toEqual(["а1/tt_ru", "а1/ru_tt", "а2/tt_ru", "а2/ru_tt"]);
    expect(q.newRows.map((x) => x.noteId)).toEqual(ids.slice(0, 10).flatMap((id) => [id, id]));
    expect(q.ownNew.map((x) => `${x.word}/${x.direction}`)).toEqual(["үзем/tt_ru", "үзем/ru_tt"]);
    expect(q.streams[1]).toEqual([]);
  });

  it("`learning` and `review` hold every card of the learner in the asked directions, a card of an unchecked level included", async () => {
    const ids = await seedCatalog(env.DB, [...rows(1, "а", 2), ...rows(3, "в", 6)]);
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const learning = { ...newMem(T), state: "learning" as const, step: 1, due: T - MIN, reps: 1, lastReview: T - 10 * MIN, stability: 2, difficulty: 5 };
    const due = { ...gradedMem(T - 5 * DAY), due: T + 3 * 60 * MIN };
    await repo.insertCard(user.id, ids[2]!, "tt_ru", learning);
    await repo.insertCard(user.id, ids[3]!, "tt_ru", due);
    await repo.insertCard(user.id, ids[4]!, "ru_tt", { ...due, due: T - MIN });
    await repo.insertCard(user.id, ids[5]!, "tt_ru", { ...due, due: T + 2 * DAY }); // not due today
    await repo.insertCard(user.id, ids[6]!, "tt_ru", due, TODAY); // hidden today
    await repo.insertCard(user.id, ids[7]!, "tt_ru", { ...learning, state: "relearning", due: T + MIN });
    const cardId = await repo.insertCard(user.id, ids[0]!, "tt_ru", gradedMem(T));
    await repo.batch([
      logStmt(env.DB, { cardId, userId: user.id, rating: 3, stateBefore: newMem(T), intervalBeforeDays: 0, intervalAfterMs: MIN, reviewedAt: T - MIN, wasNew: true }),
      logStmt(env.DB, { cardId, userId: user.id, rating: 4, stateBefore: newMem(T), intervalBeforeDays: 0, intervalAfterMs: MIN, reviewedAt: T - 2 * MIN, wasNew: true }),
      logStmt(env.DB, { cardId, userId: user.id, rating: 4, stateBefore: newMem(T), intervalBeforeDays: 0, intervalAfterMs: MIN, reviewedAt: T - 3 * MIN, wasNew: true }),
      logStmt(env.DB, { cardId, userId: user.id, rating: 3, stateBefore: gradedMem(T), intervalBeforeDays: 1, intervalAfterMs: MIN, reviewedAt: T - 4 * MIN, wasNew: false }),
      logStmt(env.DB, { cardId, userId: user.id, rating: 3, stateBefore: newMem(T), intervalBeforeDays: 0, intervalAfterMs: MIN, reviewedAt: T - DAY, wasNew: true }),
    ]);
    await env.DB.prepare("UPDATE review_log SET undone = 1 WHERE reviewed_at = ?").bind(T - 3 * MIN).run();

    const q = await repo.queue(user.id, win(BOTH), scope({ levels: [1] }));
    expect(q.learning.map((x) => x.word)).toEqual(["в1", "в6"]);
    expect(q.learning[0]).toMatchObject({ noteId: ids[2], direction: "tt_ru", exampleTt: "в1.", buriedDay: null, mem: { state: "learning", step: 1, reps: 1 } });
    expect(q.review.map((x) => `${x.word}/${x.direction}`)).toEqual(["в3/ru_tt", "в2/tt_ru"]);
    expect(q.counts).toEqual({ learning: 2, review: 2, newDoneToday: 1, easyNewToday: 1 });
    expect(q.hasCards).toBe(true);

    const one = await repo.queue(user.id, win(["tt_ru"]), scope({ levels: [1] }));
    expect(one.review.map((x) => x.word)).toEqual(["в2"]);
    expect(one.counts).toMatchObject({ learning: 2, review: 1 });
    const few = await repo.queue(user.id, { ...win(BOTH), limitEach: 1 }, scope({ levels: [1] }));
    expect(few.learning.map((x) => x.word)).toEqual(["в1"]);
    expect(few.review.map((x) => x.word)).toEqual(["в3"]);
    expect(few.counts).toMatchObject({ learning: 2, review: 2 });
  });

  it("a learner with no card: nothing to repeat, `hasCards` is false", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 2));
    const { repo, user } = await seedLearner(env.DB, { now: T });
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    await repo.insertCard(other.user.id, ids[0]!, "tt_ru", gradedMem(T - 9 * DAY));
    const q = await repo.queue(user.id, win(), scope());
    expect(q).toMatchObject({ learning: [], review: [], ownNew: [], newRows: [], hasCards: false, catalogVersion: 0 });
    expect(q.counts).toEqual({ learning: 0, review: 0, newDoneToday: 0, easyNewToday: 0 });
  });
});

describe("repo.queue: own words", () => {
  it("`ownNew` gives the words of the own and the AI decks as `candidateCards` did, and no level word", async () => {
    const ids = await seedCatalog(env.DB, rows(1, "а", 3));
    const { repo, user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const custom = await repo.customDeck(user.id, T);
    const own = await repo.insertNotes(custom, [{ ...note("бер"), sourceUrl: "https://example.org/a" }, note("ике"), note("өч")]);
    const ai = await repo.insertDeck({ slug: null, kind: "ai", titleRu: "Кухня", titleTt: "Аш бүлмәсе", levelNo: null, coveragePct: null, ownerId: user.id });
    await repo.subscribe(user.id, ai, T);
    await repo.insertNotes(ai, [note("дүрт")]);
    await repo.insertCard(user.id, own[0]!, "tt_ru", gradedMem(T - DAY));
    await repo.insertCard(user.id, own[1]!, "tt_ru", gradedMem(T), TODAY);
    // A deck of somebody else, and a level deck the learner is subscribed to in the old way: neither is an own deck.
    const other = await seedLearner(env.DB, { now: T, tgId: 2 });
    await repo.insertNotes(await repo.customDeck(other.user.id, T), [note("чужое")]);
    const before = await repo.candidateCards(user.id, win(BOTH));
    expect(before.newNotes.map((x) => `${x.word}/${x.direction}`)).toEqual(["бер/ru_tt", "өч/tt_ru", "өч/ru_tt", "дүрт/tt_ru", "дүрт/ru_tt"]);

    const q = await repo.queue(user.id, win(BOTH), scope());
    expect(q.ownNew).toEqual(before.newNotes);
    expect(q.ownNew[0]).toMatchObject({ noteId: own[0], sourceUrl: "https://example.org/a" });

    await repo.subscribe(user.id, (await repo.getDeckBySlug("a1"))!.id, T);
    const subscribed = await repo.candidateCards(user.id, win(BOTH));
    expect(subscribed.newNotes).toHaveLength(5 + 2 * ids.length);
    expect((await repo.queue(user.id, win(BOTH), scope())).ownNew).toEqual(before.newNotes);
    expect((await repo.queue(user.id, { ...win(BOTH), limitEach: 2 }, scope())).ownNew).toEqual(before.newNotes.slice(0, 2));
  });
});

describe("repo.queue: one call", () => {
  it("reads everything in one D1 call, with five levels in the scope", async () => {
    const ids = await seedCatalog(env.DB, [1, 2, 3, 4, 5].flatMap((l) => rows(l, `сүз${l}х`, 4, (i) => ({ topic: i % 2 }))));
    const { user } = await seedLearner(env.DB, { now: T, patch: { direction: "both" } });
    const plain = new Repo(env.DB);
    await plain.insertNotes(await plain.customDeck(user.id, T), [note("үзем")]);
    await plain.insertCard(user.id, ids[0]!, "tt_ru", gradedMem(T - 5 * DAY));
    const db = countingDb(env.DB);
    const q = await new Repo(db).queue(user.id, win(BOTH), scope({ levels: [1, 2, 3, 4, 5], mode: "guided", posCodes: ["n", "v"], spans: { 1: { from: 0, to: null }, 2: { from: 2, to: 1_000_004 } } }));
    expect(db.calls).toBe(1);
    expect(Object.keys(q.streams)).toEqual(["1", "2", "3", "4", "5"]);
    expect(cards(q, 1)).toEqual(["сүз1х1/ru_tt"]);
    expect(cards(q, 2)).toEqual(["сүз2х3/tt_ru", "сүз2х3/ru_tt"]);
    expect(cards(q, 5)).toEqual(["сүз5х1/tt_ru", "сүз5х1/ru_tt"]);
    expect(q.ownNew).toHaveLength(2);
  });
});
