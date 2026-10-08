import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Direction, DirectionSetting, Repo } from "../../src/db/repo";
import { mergeStreams } from "../../src/levels/order";
import { levelBit, levelsOf } from "../../src/levels/scale";
import { ReviewService, directionsOf, newScopeOf } from "../../src/review/service";
import { type Rating, newMem } from "../../src/srs/ladder";
import { dayWindow, localDay } from "../../src/users/service";
import { bulkCatalog } from "../helpers/catalog";
import { gradedMem } from "../helpers/review";
import { note, seedCatalog, seedGuidedOrder, seedLearner } from "../helpers/seed";
import { type Shown, allNewCards, seeded, study } from "../helpers/sim";

const DAY = 86_400_000;
/** 09:00 local (+03:00) on the learner's first day; `day(n)` is the same hour of day n. */
const now = Date.UTC(2026, 8, 30, 6, 0);
const day = (n: number) => now + (n - 1) * DAY;
const TZ = 180;
const BOTH: Direction[] = ["tt_ru", "ru_tt"];

/** The cards of a sitting as text: «китап tt_ru new» for a card shown as new, «китап tt_ru» for a repetition. */
const cards = (shown: Shown[]) => shown.map((c) => `${c.word} ${c.direction}${c.fresh ? " new" : ""}`);
const fresh = (shown: Shown[]) => shown.filter((c) => c.fresh).map((c) => `${c.word} ${c.direction}`);
/** A1: китап, вакыт, авыл (and су with `four`); A2: су, юл when asked for. */
const seedWords = (o: { four?: boolean; a2?: boolean } = {}) => seedCatalog(env.DB, [
  ...["китап", "вакыт", "авыл", ...(o.four ? ["су"] : [])].map((word) => ({ level: 1, word })),
  ...(o.a2 ? ["су", "юл"].map((word) => ({ level: 2, word })) : []),
]);

/*
 * On the ladder a started word is back the next day at the earliest, and on a day when both a repetition and a new
 * card wait they take turns. So the days of these learners are laid out with what is certain: a word left on a minute
 * rung comes back before anything else, and a word graded «Легко» from the 10-minute rung is three days away.
 */
describe("both directions: a card that was hidden for a day is given later", () => {
  /**
   * Two days of a learner with both directions and the three words of A1, after which `soon` alone is due on day 3
   * and no card has been asked Russian → Tatar. Day 1: the three words are graded «Хорошо» and stay on the 10-minute
   * rung; their reverse cards are hidden until tomorrow. Day 2: the three come back first, and each repetition hides
   * the reverse card of its word for the day again; `soon` goes to 1 day, the other two («Легко») to 3 days.
   * `leaveAt`: the learner leaves when this word comes up.
   */
  async function twoDays(repo: Repo, userId: number, soon: string, leaveAt?: string) {
    const leave = leaveAt === undefined ? {} : { leaveAt: (v: { word: string }) => v.word === leaveAt };
    const first = await study(repo, userId, day(1), { rate: () => 3, waitForSteps: false, ...leave });
    expect(cards(first)).toEqual(["китап tt_ru new", "вакыт tt_ru new", "авыл tt_ru new"]);
    const second = await study(repo, userId, day(2), { rate: (v) => (v.word === soon ? 3 : 4), ...leave });
    expect(cards(second)).toEqual(["китап tt_ru", "вакыт tt_ru", "авыл tt_ru"]);
  }

  it("the reverse card of a word that was repeated on the day the rest of its level was asked in reverse comes the next day", async () => {
    await seedWords();
    const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: "both" } });
    await twoDays(repo, user.id, "китап");
    // Day 3: the repetition of «китап» comes first and hides its reverse card for the day;
    // the reverse cards of the other two words are given, the last word of the level among them.
    await repo.updateUser(user.id, { mixCounter: 0 });
    const third = await study(repo, user.id, day(3), { rate: () => 3 });
    expect(cards(third).slice(0, 3)).toEqual(["китап tt_ru", "вакыт ru_tt new", "авыл ru_tt new"]);
    expect(fresh(third)).toEqual(["вакыт ru_tt", "авыл ru_tt"]);
    // Day 4: «китап» Russian → Tatar comes. It was never asked in that direction.
    const later: string[] = [];
    for (let d = 4; d <= 15; d++) later.push(...fresh(await study(repo, user.id, day(d), { rate: () => 3 })).map((c) => `day ${d}: ${c}`));
    expect(later).toEqual(["day 4: китап ru_tt"]);
    const asked = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log WHERE user_id = ? AND was_new = 1").bind(user.id).first<{ n: number }>();
    expect(asked!.n).toBe(6);
  });

  it("the reverse cards the started words have for today come before the words of the next checked level; a card hidden for today does not hold that level back", async () => {
    await seedWords({ a2: true });
    const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: "both", levels: levelBit(1) | levelBit(2) } });
    // Days 1 and 2: every word of A1 is asked Tatar → Russian and repeated. Its reverse cards are hidden until tomorrow,
    // A1 has nothing more for the day, so A2 goes on the same day; the learner leaves at its first word, which has been shown.
    await twoDays(repo, user.id, "авыл", "су");
    // Day 3: «авыл» is repeated first, which hides its reverse card for the day. A1 still has two reverse cards for
    // today: they come before the words of A2. Then A2 goes on — the hidden card of «авыл» does not stop it.
    const third = await study(repo, user.id, day(3), { rate: () => 4 });
    expect(cards(third)).toEqual(["авыл tt_ru", "китап ru_tt new", "вакыт ru_tt new", "су tt_ru new", "юл tt_ru new"]);
    // Day 4: the card that was hidden is the first card, before the reverse cards of A2; the cards asked yesterday
    // are repeated in turn with the new ones.
    const fourth = await study(repo, user.id, day(4), { rate: () => 4 });
    expect(cards(fourth)).toEqual(["авыл ru_tt new", "китап ru_tt", "су ru_tt new", "вакыт ru_tt", "юл ru_tt new"]);
    // No new card is left: every word has both its cards started.
    for (const d of [5, 6, 7]) expect(fresh(await study(repo, user.id, day(d), { rate: () => 4 })), `day ${d}`).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND state = 'new'").bind(user.id).first()).toEqual({ n: 0 });
    expect((await repo.getUser(user.id))!.levels).toBe(levelBit(1) | levelBit(2));
  });

  it("a level checked on a later day: the reverse cards the started words have for today come first, then its words", async () => {
    await seedWords({ a2: true });
    const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: "both" } });
    // Days 1 and 2, A1 alone: the three words are asked Tatar → Russian and repeated. No word of A2 comes.
    await twoDays(repo, user.id, "авыл");
    await repo.updateUser(user.id, { levels: levelBit(1) | levelBit(2) });
    const third = await study(repo, user.id, day(3), { rate: () => 4 });
    expect(cards(third)).toEqual(["авыл tt_ru", "китап ru_tt new", "вакыт ru_tt new", "су tt_ru new", "юл tt_ru new"]);
  });

  it("after a switch from one direction to both, the other direction of every word already learned is asked, a word repeated that day included", async () => {
    await seedWords({ four: true });
    const { repo, user } = await seedLearner(env.DB, { now }); // Tatar → Russian only
    // Days 1 and 2: the four words are learned in one direction. «вакыт» is due again on day 3, the other three («Легко») on day 5.
    const first = await study(repo, user.id, day(1), { rate: () => 3, waitForSteps: false });
    expect(cards(first)).toEqual(["китап tt_ru new", "вакыт tt_ru new", "авыл tt_ru new", "су tt_ru new"]);
    expect(cards(await study(repo, user.id, day(2), { rate: (v) => (v.word === "вакыт" ? 3 : 4) }))).toEqual(["китап tt_ru", "вакыт tt_ru", "авыл tt_ru", "су tt_ru"]);
    await repo.updateUser(user.id, { direction: "both" });
    // Day 3: «вакыт» is repeated first and its reverse card is hidden for the day; the other three are asked in reverse.
    expect(cards(await study(repo, user.id, day(3), { rate: () => 4 }))).toEqual(["вакыт tt_ru", "китап ru_tt new", "авыл ru_tt new", "су ru_tt new"]);
    // Day 4: the reverse card of «вакыт», in turn with the repetitions of the three asked yesterday.
    expect(cards(await study(repo, user.id, day(4), { rate: () => 4 }))).toEqual(["китап ru_tt", "вакыт ru_tt new", "авыл ru_tt", "су ru_tt"]);
    for (const d of [5, 6, 7]) expect(fresh(await study(repo, user.id, day(d), { rate: () => 4 })), `day ${d}`).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND state != 'new'").bind(user.id).first()).toEqual({ n: 8 });
  });

  it("after a switch from both directions to one, a card of that direction that was hidden earlier is still asked", async () => {
    await seedWords();
    const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: "both" } });
    await twoDays(repo, user.id, "китап");
    await repo.updateUser(user.id, { mixCounter: 0 });
    expect(fresh(await study(repo, user.id, day(3), { rate: () => 3 }))).toEqual(["вакыт ru_tt", "авыл ru_tt"]);
    // The learner now asks for Russian → Tatar only. «китап» was never asked that way.
    await repo.updateUser(user.id, { direction: "ru_tt" });
    expect(fresh(await study(repo, user.id, day(4), { rate: () => 3 }))).toEqual(["китап ru_tt"]);
  });

  it("a word whose grade was taken back and that was left for later is asked the next day, whatever came after it", async () => {
    await seedWords();
    const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: "both" } });
    // «китап» is graded and the grade is taken back; the learner presses «Учить» again instead of grading it anew.
    // Its other card was hidden for the day by the grade, so the word waits until tomorrow with both cards new.
    const svc = new ReviewService(repo, day(1));
    const s = await svc.nextScreen(user);
    if (s.kind !== "card") throw new Error("no card");
    await svc.grade(user, s.view.cardId, s.view.reps, 4);
    await svc.undo((await repo.getUser(user.id))!);
    expect(fresh(await study(repo, user.id, day(1) + 60_000, { rate: () => 4 }))).toEqual(["вакыт tt_ru", "авыл tt_ru"]);
    // Day 2: «китап» comes, Tatar → Russian. The two words of yesterday are due again and take turns with the new cards:
    // «вакыт» is repeated, which hides its reverse card; the reverse card of «авыл» is asked, which hides its repetition.
    expect(cards(await study(repo, user.id, day(2), { rate: () => 4 }))).toEqual(["китап tt_ru new", "вакыт tt_ru", "авыл ru_tt new"]);
    // Day 3: the reverse card of «китап», and the one of «вакыт» that was hidden.
    expect(fresh(await study(repo, user.id, day(3), { rate: () => 4 }))).toEqual(["китап ru_tt", "вакыт ru_tt"]);
    for (const d of [4, 5]) expect(fresh(await study(repo, user.id, day(d), { rate: () => 4 })), `day ${d}`).toEqual([]);
  });
});

describe("a learner who switches to both directions after 300 words", () => {
  for (const mode of ["guided", "freq"] as const) {
    it(`${mode}: the reverse cards of the started words come in the order of the mode`, { timeout: 60_000 }, async () => {
      // A1 and A2, 200 words each, in every topic. The first 300 words of the order of the mode are started Tatar → Russian.
      const catalog = await bulkCatalog(env.DB, { sizes: { 1: 200, 2: 200 } });
      const { repo, user } = await seedLearner(env.DB, { now, patch: { levels: levelBit(1) | levelBit(2), newMode: mode, newPerDay: 20 } });
      const order = mergeStreams([catalog], mode);
      const started = order.slice(0, 300);
      const stmts = started.map((n) => repo.insertCardStmt(user.id, n.id, "tt_ru", gradedMem(day(0))));
      for (let i = 0; i < stmts.length; i += 100) await repo.batch(stmts.slice(i, i + 100));
      // The orders differ: by frequency all of A1 comes before A2, by topic the two levels take turns.
      expect(new Set(started.slice(0, 40).map((n) => n.level)).size).toBe(mode === "freq" ? 1 : 2);

      await repo.updateUser(user.id, { direction: "both" });
      const asked: string[] = [];
      for (const d of [1, 2]) asked.push(...fresh(await study(repo, user.id, day(d), { rate: () => 3 })));
      expect(asked).toEqual(started.slice(0, 40).map((n) => `${n.word} ru_tt`));
      // No word that was not started has been touched: the reverse cards of the started words stand before it.
      const untouched = await env.DB.prepare("SELECT COUNT(DISTINCT note_id) AS n FROM cards WHERE user_id = ?").bind(user.id).first<{ n: number }>();
      expect(untouched!.n).toBe(300);
    });
  }
});

/** A simulated learner makes a few hundred grades; on a slow machine that is more than the default five seconds. */
const SIMULATION_MS = 120_000;

/** Four levels of six words: three themed topics and the basic words, nouns, verbs, an adjective and numerals in every level. */
const SMALL_TOPICS = [1, 0, 2, 1, 0, 3];
const SMALL_POS = ["n", "v", "num", "n", "adj", "num"];
const smallLevel = (level: number, from = 0, to = 6) =>
  Array.from({ length: to - from }, (_, i) => ({ level, word: `сүз${level}х${from + i + 1}`, topic: SMALL_TOPICS[(from + i) % 6]!, pos: SMALL_POS[(from + i) % 6]! }));
async function seedSmallLevels() {
  await seedCatalog(env.DB, [1, 2, 3, 4].flatMap((level) => smallLevel(level)));
  await seedGuidedOrder(env.DB);
}
const FOUR_LEVELS = levelBit(1) | levelBit(2) | levelBit(3) | levelBit(4);

/** A random grade: «Снова» 15 %, «Трудно» 10 %, «Хорошо» 45 %, «Легко» 30 %. */
const randomGrade = (r: () => number): Rating => { const x = r(); return x < 0.15 ? 1 : x < 0.25 ? 2 : x < 0.7 ? 3 : 4; };

describe("both directions: learners with days off, random grades and changing settings (a simulation)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`learner ${seed}: every new card is the first one of the documented order, none is asked twice as new, and in the end every word was asked in both directions`, { timeout: SIMULATION_MS }, async () => {
      const r = seeded(seed);
      await seedSmallLevels();
      // The order: guided, by frequency, or guided with a chosen topic (which is cleared when its words run out).
      const { repo, user } = await seedLearner(env.DB, {
        now, patch: { direction: "both", newPerDay: seed % 2 ? 5 : 10, levels: FOUR_LEVELS, newMode: seed % 3 === 1 ? "freq" : "guided", topicNo: seed % 3 === 2 ? 2 : null },
      });
      const askedNew = new Map<string, number>();
      const sitting = (start: number, rate: () => Rating) => study(repo, user.id, start, {
        rate,
        onCard: async (s, at) => {
          if (s.view.mem.state !== "new") return;
          // The new card on screen is the first of all the new cards the learner has today, in the documented order.
          const all = await allNewCards(env.DB, user.id, localDay(TZ, at));
          expect([s.view.noteId, s.view.direction]).toEqual([all[0]?.noteId, all[0]?.direction]);
          const key = `${s.view.noteId}:${s.view.direction}`;
          askedNew.set(key, (askedNew.get(key) ?? 0) + 1);
        },
      });
      // Thirty days: three days in ten are days off; own words are added on day 8 by every second learner; the
      // learners change what is checked: a level is unchecked for a while, the parts of speech are narrowed, a topic is chosen.
      for (let d = 1; d <= 30; d++) {
        if (d === 8 && seed % 2 === 0) await repo.insertNotes(await repo.customDeck(user.id, day(d)), [note("үзем1"), note("үзем2"), note("үзем3")]);
        if (d === 5 && seed % 5 === 0) await repo.updateUser(user.id, { levels: FOUR_LEVELS & ~levelBit(1) });
        if (d === 12 && seed % 5 === 0) await repo.updateUser(user.id, { levels: FOUR_LEVELS });
        if (d === 6 && seed % 4 === 1) await repo.updateUser(user.id, { posGroups: 1 << 5 });
        if (d === 14 && seed % 4 === 1) await repo.updateUser(user.id, { posGroups: 255 });
        if (d === 10 && seed % 3 === 0) await repo.updateUser(user.id, { newMode: "topic", topicNo: 3 });
        if (d === 18 && seed % 3 === 0) await repo.updateUser(user.id, { newMode: "guided", topicNo: 1 });
        if (r() < 0.3) continue;
        await repo.updateUser(user.id, { mixCounter: Math.floor(r() * 4) });
        await sitting(day(d), () => randomGrade(r));
      }
      // Then the learner studies every day until the bot has had nothing new for two days in a row.
      let quiet = 0;
      for (let d = 31; d <= 90 && quiet < 2; d++) quiet = fresh(await sitting(day(d), () => (r() < 0.5 ? 3 : 4))).length ? 0 : quiet + 1;
      expect(quiet).toBe(2);

      const notes = (await env.DB.prepare("SELECT n.id FROM notes n JOIN decks dk ON dk.id = n.deck_id WHERE n.level IS NOT NULL OR dk.owner_id = ?").bind(user.id).all<{ id: number }>()).results;
      expect(notes).toHaveLength(seed % 2 === 0 ? 27 : 24);
      // Every word of every checked level and every own word was asked as new exactly once in each direction …
      const expected = notes.flatMap((n) => BOTH.map((d) => `${n.id}:${d}`)).sort();
      expect([...askedNew.keys()].sort()).toEqual(expected);
      expect([...askedNew.values()].every((n) => n === 1)).toBe(true);
      // … and was graded: no card is left new, and each has one first grade in the log.
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND state = 'new'").bind(user.id).first<{ n: number }>();
      expect(left!.n).toBe(0);
      const firsts = await env.DB.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT card_id) AS cards FROM review_log WHERE user_id = ? AND was_new = 1").bind(user.id).first<{ n: number; cards: number }>();
      expect(firsts).toEqual({ n: expected.length, cards: expected.length });
      // The counters of started words agree with the cards: every word of the four levels, and the own words under (0, 0).
      const counted = (await repo.progress(user.id)).reduce((sum, p) => sum + p.started, 0);
      expect(counted).toBe(notes.length);
      // The bot checked no level and chose no topic by itself; the topic of the guided order was cleared when it ran out.
      expect((await repo.getUser(user.id))!).toMatchObject({ levels: FOUR_LEVELS, topicNo: null });
    });
  }
});

describe("what the queue reads (Repo.queue) against a plain read of every note and card", () => {
  const name = (c: { word: string; direction: Direction }) => `${c.word} ${c.direction}`;
  /**
   * What one read of the queue must hold, for the learner's settings and the read positions stored on the row:
   * `ownNew` — the new cards of the own decks, `newRows` — the catalog cards that exist and were never graded, and for
   * every checked level the cards of its first word that has none yet. `directions` replaces the asked directions;
   * positions stored for other directions do not count then.
   */
  async function expectQueueMatches(repo: Repo, userId: number, at: number, directions?: Direction[]) {
    const user = (await repo.getUser(userId))!;
    const w = dayWindow(TZ, at);
    const asked = directions ?? directionsOf(user);
    const setting: DirectionSetting = asked.length === 2 ? "both" : asked[0]!;
    const all = await allNewCards(env.DB, userId, w.today, asked);
    const q = await repo.queue(userId, { ...w, directions: asked }, newScopeOf({ ...user, direction: setting }));
    expect(q.ownNew.map(name)).toEqual(all.filter((c) => c.from === "own").slice(0, 50).map(name));
    // One read takes twenty of these cards; a word whose two cards stand at the cut may be cut either way.
    const rows = all.filter((c) => c.from === "row").map(name);
    if (rows.length <= 20) expect(q.newRows.map(name)).toEqual(rows);
    else expect(q.newRows.map(name).slice(0, 19)).toEqual(rows.slice(0, 19));
    const stream = all.filter((c) => c.from === "stream");
    const levels = user.newMode === "topic" && user.topicNo === null ? [] : levelsOf(user.levels);
    expect(Object.keys(q.streams).map(Number)).toEqual(levels);
    for (const level of levels) {
      const head = stream.find((c) => c.level === level);
      expect(q.streams[level]!.map(name), `level ${level}`).toEqual(stream.filter((c) => c.noteId === head?.noteId).map(name));
    }
    const merged = mergeStreams(Object.values(q.streams).map((s) => s ?? []), user.newMode);
    expect(merged.slice(0, 1).map(name)).toEqual(stream.slice(0, 1).map(name));
  }

  it("a card that waits in an own deck whose notes enclose the notes of a level is found, however many cards wait between them", async () => {
    // Two own words are typed, then a level of sixty words appears, then two more own words: the ids of the own
    // deck enclose the level. Direction «оба»; every word is started Tatar → Russian. The reverse cards of the level
    // wait in state 'new' — sixty of them between the own notes — and so does the reverse card of the last own word.
    const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: "both" } });
    const id = user.id;
    const deck = await repo.customDeck(id, now);
    const early = await repo.insertNotes(deck, [note("үзем1"), note("үзем2")]);
    const level = (await bulkCatalog(env.DB, { sizes: { 1: 60 } })).map((n) => n.id);
    const late = await repo.insertNotes(deck, [note("үзем3"), note("үзем4")]);
    expect(Math.min(...level)).toBeGreaterThan(Math.max(...early));
    expect(Math.min(...late)).toBeGreaterThan(Math.max(...level));
    const stmts: D1PreparedStatement[] = [];
    for (const n of [...early, ...level, ...late]) stmts.push(repo.insertCardStmt(id, n, "tt_ru", gradedMem(day(-1))));
    for (const n of [...early, late[0]!]) stmts.push(repo.insertCardStmt(id, n, "ru_tt", gradedMem(day(-1))));
    for (const n of [...level, late[1]!]) stmts.push(repo.insertCardStmt(id, n, "ru_tt", newMem(day(-1)), "2026-09-27"));
    for (let i = 0; i < stmts.length; i += 50) await repo.batch(stmts.slice(i, i + 50));

    const read = async (at = now) => {
      const q = await repo.queue(id, { ...dayWindow(TZ, at), directions: BOTH }, newScopeOf((await repo.getUser(id))!));
      return { own: q.ownNew.map(name), rows: q.newRows.map(name) };
    };
    expect((await read()).own).toEqual(["үзем4 ru_tt"]);
    expect((await read()).rows.slice(0, 2)).toEqual(["сүз1х1 ru_tt", "сүз1х2 ru_tt"]);
    await expectQueueMatches(repo, id, now, BOTH);
    // The own word is repeated today: its reverse card is hidden until tomorrow, the level goes on.
    await env.DB.prepare("UPDATE cards SET buried_day = ? WHERE user_id = ? AND note_id = ? AND direction = 'ru_tt'").bind(dayWindow(TZ, now).today, id, late[1]!).run();
    expect((await read()).own).toEqual([]);
    expect((await read()).rows.slice(0, 2)).toEqual(["сүз1х1 ru_tt", "сүз1х2 ru_tt"]);
    await expectQueueMatches(repo, id, now, BOTH);
    await expectQueueMatches(repo, id, now + DAY, BOTH);
    // The level is asked in reverse to its last word but one; the own deck and the level each have one card left.
    await env.DB.prepare("UPDATE cards SET state = 'review', reps = 1 WHERE user_id = ? AND direction = 'ru_tt' AND note_id IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(level.filter((_, i) => i !== 58))).run();
    expect(await read()).toEqual({ own: [], rows: ["сүз1х59 ru_tt"] });
    await expectQueueMatches(repo, id, now + DAY, BOTH);
    expect(await read(now + DAY)).toEqual({ own: ["үзем4 ru_tt"], rows: ["сүз1х59 ru_tt"] });
  });

  for (const seed of [11, 12, 13, 14]) {
    it(`learner ${seed}: after every grade, undo and change of the settings the queue holds what a plain read gives`, { timeout: SIMULATION_MS }, async () => {
      const r = seeded(seed);
      const oneOf = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
      await seedSmallLevels();
      const { repo, user } = await seedLearner(env.DB, { now, patch: { direction: seed % 3 === 0 ? "tt_ru" : "both", newPerDay: 5, levels: FOUR_LEVELS } });
      const me = async () => (await repo.getUser(user.id))!;
      /** The learner changes one of the settings that decide the new words. */
      const changeSettings = async () => {
        const x = r();
        if (x < 0.3) await repo.updateUser(user.id, { direction: oneOf(["tt_ru", "ru_tt", "both", "both"] as const) });
        else if (x < 0.5) await repo.updateUser(user.id, { levels: oneOf([FOUR_LEVELS, levelBit(1), levelBit(2) | levelBit(4), FOUR_LEVELS & ~levelBit(1), levelBit(3)]) });
        else if (x < 0.65) await repo.updateUser(user.id, { posGroups: oneOf([255, 255, 1 << 5, (1 << 0) | (1 << 1)]) });
        else if (x < 0.85) await repo.updateUser(user.id, { newMode: oneOf(["guided", "freq", "topic"] as const) });
        else await repo.updateUser(user.id, { topicNo: oneOf([null, 0, 1, 2, 3]) });
      };
      for (let d = 1; d <= 40; d++) {
        // Own words on day 6, two of them words of the levels 3 and 4 (the last word of level 4), which the levels then skip;
        // more own words on day 25; on day 18 the catalog is loaded again with a new word in level 1: the version moves.
        if (d === 6) await repo.insertNotes(await repo.customDeck(user.id, day(d)), [note("үзем1"), note("сүз3х2"), note("үзем2"), note("сүз4х6"), note("үзем3")]);
        if (d === 18) {
          await seedCatalog(env.DB, smallLevel(1, 6, 7));
          await seedGuidedOrder(env.DB);
          await env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'catalog_version'").run();
        }
        if (d === 25) await repo.insertNotes(await repo.customDeck(user.id, day(d)), [note("үзем4"), note("үзем5")]);
        // Now and then the learner changes a setting, sometimes in the middle of a day (below).
        if (r() < 0.2) await changeSettings();
        if (r() < 0.25) continue;
        let at = day(d);
        await repo.updateUser(user.id, { mixCounter: Math.floor(r() * 4) });
        let s = await new ReviewService(repo, at).nextScreen(await me());
        for (let n = 0; n < 60 && s.kind === "card"; n++) {
          await expectQueueMatches(repo, user.id, at);
          at += 5000;
          s = await new ReviewService(repo, at).grade(await me(), s.view.cardId, s.view.reps, randomGrade(r));
          const x = r();
          if (x < 0.08) {
            // The grade is taken back; half of the time the learner then presses «Учить» instead of grading the card again.
            s = await new ReviewService(repo, at).undo(await me());
            if (r() < 0.5) s = await new ReviewService(repo, at).nextScreen(await me());
          } else if (x < 0.13) {
            await changeSettings();
            s = await new ReviewService(repo, at).nextScreen(await me());
          }
        }
        await expectQueueMatches(repo, user.id, at);
        // The lists in each of the three directions, whatever the learner has chosen.
        for (const dirs of [["tt_ru"], ["ru_tt"], BOTH] as Direction[][]) await expectQueueMatches(repo, user.id, at, dirs);
      }
    });
  }
});
