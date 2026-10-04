import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Direction, Repo } from "../../src/db/repo";
import { ReviewService, directionsOf } from "../../src/review/service";
import { type Rating, newMem } from "../../src/srs/fsrs";
import { dayWindow, localDay } from "../../src/users/service";
import { gradedMem } from "../helpers/review";
import { note, seedLevels, seedUser } from "../helpers/seed";
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
const levelOf = async (repo: Repo, userId: number) => (await repo.getUser(userId))!.level;

describe("both directions: a card that was hidden for a day is given later, and a level ends only when none is left", () => {
  it("the reverse card of a word that was repeated on the day the rest of its level was asked in reverse comes the next day", async () => {
    // The reviewer's reproduction. A level of three words, direction «оба».
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 3, patch: { direction: "both" } }); // китап, вакыт, авыл
    // Day 1: «китап» is graded «Снова» and then learned, the other two «Легко». The reverse cards are hidden until tomorrow.
    const first = await study(repo, user.id, day(1), { rate: (v, nth) => (v.word === "китап" ? (nth === 0 ? 1 : 3) : 4) });
    expect(cards(first)).toEqual(["китап tt_ru new", "вакыт tt_ru new", "авыл tt_ru new", "китап tt_ru", "китап tt_ru"]);
    // Three days away. Day 5: the repetition of «китап» comes first and hides its reverse card for the day;
    // the reverse cards of the other two words are given, the last word of the level among them.
    await repo.updateUser(user.id, { mixCounter: 0 });
    const fifth = await study(repo, user.id, day(5), { rate: () => 3 });
    expect(cards(fifth).slice(0, 3)).toEqual(["китап tt_ru", "вакыт ru_tt new", "авыл ru_tt new"]);
    expect(fresh(fifth)).toEqual(["вакыт ru_tt", "авыл ru_tt"]);
    // Day 6: «китап» Russian → Tatar is the first card. It was never asked in that direction.
    const later: string[] = [];
    for (let d = 6; d <= 17; d++) later.push(...fresh(await study(repo, user.id, day(d), { rate: () => 3 })).map((c) => `day ${d}: ${c}`));
    expect(later).toEqual(["day 6: китап ru_tt"]);
    const asked = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log WHERE user_id = ? AND was_new = 1").bind(user.id).first<{ n: number }>();
    expect(asked!.n).toBe(6);
  });

  it("the reverse cards a level still has for today come before the words of the next level; a card hidden for today does not hold the next level back", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 3, patch: { direction: "both" } }); // китап, вакыт, авыл
    await seedLevels(env.DB, { 2: ["су", "юл"] }, { 1: 31 });
    // Day 1: every word of level 1 is asked Tatar → Russian. The reverse cards are hidden until tomorrow, level 1 has
    // nothing more for today, so level 2 opens the same day (ruling T8a); the learner leaves at its first word.
    // «авыл», the last word of level 1, was graded «Хорошо» and is still on a learning step.
    const first = await study(repo, user.id, day(1), { rate: (v) => (v.word === "авыл" ? 3 : 4), leaveAt: (v) => v.word === "су" });
    expect(cards(first)).toEqual(["китап tt_ru new", "вакыт tt_ru new", "авыл tt_ru new"]);
    expect(await levelOf(repo, user.id)).toBe(2);
    // Day 2: «авыл» is repeated first, which hides its reverse card for the day. Level 1 still has two reverse cards
    // for today: they come before the words of level 2. Then level 2 goes on — the hidden card of «авыл» does not stop it.
    const second = await study(repo, user.id, day(2), { rate: () => 4 });
    expect(cards(second)).toEqual(["авыл tt_ru", "китап ru_tt new", "вакыт ru_tt new", "су tt_ru new", "юл tt_ru new"]);
    expect(second.every((c) => c.levelUp === null)).toBe(true);
    // Day 3: the card that was hidden comes first, before the reverse cards of level 2.
    expect(cards(await study(repo, user.id, day(3), { rate: () => 4 }))).toEqual(["авыл ru_tt new", "су ru_tt new", "юл ru_tt new"]);
    expect(cards(await study(repo, user.id, day(4), { rate: () => 4 }))).toEqual([]);
  });

  it("a level is not finished for opening the next one while it has a new card for today, and is finished when all it has left is hidden until tomorrow", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 3, patch: { direction: "both" } }); // китап, вакыт, авыл
    // Day 1: the three words are asked Tatar → Russian; «авыл» stays on a learning step. No level 2 yet.
    await study(repo, user.id, day(1), { rate: (v) => (v.word === "авыл" ? 3 : 4), waitForSteps: false });
    expect(await levelOf(repo, user.id)).toBe(1);
    await seedLevels(env.DB, { 2: ["су", "юл"] }, { 1: 31 });
    // Day 2: «авыл» is repeated and hidden. Level 2 must not open before the two reverse cards level 1 has for today are asked.
    const second = await study(repo, user.id, day(2), { rate: () => 4 });
    expect(cards(second)).toEqual(["авыл tt_ru", "китап ru_tt new", "вакыт ru_tt new", "су tt_ru new", "юл tt_ru new"]);
    expect(second.map((c) => c.levelUp?.to ?? null)).toEqual([null, null, null, 2, null]);
  });

  it("after a switch from one direction to both, the other direction of every word already learned is asked, a word repeated that day included", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 4 }); // китап, вакыт, авыл, су; Tatar → Russian only
    // Day 1: the four words are learned in one direction; «вакыт» is left on a learning step.
    const first = await study(repo, user.id, day(1), { rate: (v) => (v.word === "вакыт" ? 3 : 4), waitForSteps: false });
    expect(cards(first)).toEqual(["китап tt_ru new", "вакыт tt_ru new", "авыл tt_ru new", "су tt_ru new"]);
    await repo.updateUser(user.id, { direction: "both" });
    // Day 3: «вакыт» is repeated first and its reverse card is hidden for the day; the other three are asked in reverse.
    expect(cards(await study(repo, user.id, day(3), { rate: () => 4 }))).toEqual(["вакыт tt_ru", "китап ru_tt new", "авыл ru_tt new", "су ru_tt new"]);
    // Day 4: the reverse card of «вакыт».
    expect(cards(await study(repo, user.id, day(4), { rate: () => 4 }))).toEqual(["вакыт ru_tt new"]);
    expect(cards(await study(repo, user.id, day(5), { rate: () => 4 }))).toEqual([]);
  });

  it("after a switch from both directions to one, a card of that direction that was hidden earlier is still asked", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 3, patch: { direction: "both" } });
    await study(repo, user.id, day(1), { rate: (v, nth) => (v.word === "китап" ? (nth === 0 ? 1 : 3) : 4) });
    await repo.updateUser(user.id, { mixCounter: 0 });
    expect(fresh(await study(repo, user.id, day(5), { rate: () => 3 }))).toEqual(["вакыт ru_tt", "авыл ru_tt"]);
    // The learner now asks for Russian → Tatar only. «китап» was never asked that way.
    await repo.updateUser(user.id, { direction: "ru_tt" });
    expect(fresh(await study(repo, user.id, day(6), { rate: () => 3 }))).toEqual(["китап ru_tt"]);
  });

  it("a word whose grade was taken back and that was left for later is asked the next day, whatever came after it", async () => {
    const { repo, user } = await seedUser(env.DB, { now, level: 1, words: 3, patch: { direction: "both" } });
    // «китап» is graded and the grade is taken back; the learner presses «Учить» again instead of grading it anew.
    // Its other card was hidden for the day by the grade, so the word waits until tomorrow with both cards new.
    const svc = new ReviewService(repo, day(1));
    const s = await svc.nextScreen(user);
    if (s.kind !== "card") throw new Error("no card");
    await svc.grade(user, s.view.cardId, s.view.reps, 4);
    await svc.undo((await repo.getUser(user.id))!);
    expect(fresh(await study(repo, user.id, day(1) + 60_000, { rate: () => 4 }))).toEqual(["вакыт tt_ru", "авыл tt_ru"]);
    expect(fresh(await study(repo, user.id, day(2), { rate: () => 4 }))).toEqual(["китап tt_ru", "вакыт ru_tt", "авыл ru_tt"]);
    expect(fresh(await study(repo, user.id, day(3), { rate: () => 4 }))).toEqual(["китап ru_tt"]);
  });
});

/** A simulated learner makes a few hundred grades; on a slow machine that is more than the default five seconds. */
const SIMULATION_MS = 120_000;

/** Four levels of six words. */
const SMALL_LEVELS = Object.fromEntries([1, 2, 3, 4].map((l) => [l, Array.from({ length: 6 }, (_, i) => `сүз${l}х${i + 1}`)]));

/** A random grade: «Снова» 15 %, «Трудно» 10 %, «Хорошо» 45 %, «Легко» 30 %. */
const randomGrade = (r: () => number): Rating => { const x = r(); return x < 0.15 ? 1 : x < 0.25 ? 2 : x < 0.7 ? 3 : 4; };

describe("both directions: learners with days off and random grades (a simulation)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`learner ${seed}: every new card is the first one of the documented order, none is asked twice as new, and in the end every word was asked in both directions`, { timeout: SIMULATION_MS }, async () => {
      const r = seeded(seed);
      await seedLevels(env.DB, { 1: SMALL_LEVELS[1]! });
      const { repo, user } = await seedUser(env.DB, { now, level: 1, patch: { direction: "both", newPerDay: seed % 2 ? 5 : 10 } });
      await seedLevels(env.DB, { 2: SMALL_LEVELS[2]!, 3: SMALL_LEVELS[3]!, 4: SMALL_LEVELS[4]! });
      const askedNew = new Map<string, number>();
      const sitting = (start: number, rate: () => Rating) => study(repo, user.id, start, {
        rate,
        onCard: async (s, at) => {
          if (s.view.mem.state !== "new") return;
          // The new card on screen is the first of all the new cards the learner has today, in the documented order.
          const all = await allNewCards(env.DB, user.id, localDay(TZ, at), BOTH);
          expect([s.view.noteId, s.view.direction]).toEqual([all[0]?.noteId, all[0]?.direction]);
          const key = `${s.view.noteId}:${s.view.direction}`;
          askedNew.set(key, (askedNew.get(key) ?? 0) + 1);
        },
      });
      // Thirty days: three days in ten are days off; own words are added on day 8 by every second learner.
      for (let d = 1; d <= 30; d++) {
        if (d === 8 && seed % 2 === 0) await repo.insertNotes(await repo.customDeck(user.id, day(d)), [note("үзем1"), note("үзем2"), note("үзем3")]);
        if (r() < 0.3) continue;
        await repo.updateUser(user.id, { mixCounter: Math.floor(r() * 4) });
        await sitting(day(d), () => randomGrade(r));
      }
      // Then the learner studies every day until the bot has had nothing new for two days in a row.
      let quiet = 0;
      for (let d = 31; d <= 90 && quiet < 2; d++) quiet = fresh(await sitting(day(d), () => (r() < 0.5 ? 3 : 4))).length ? 0 : quiet + 1;
      expect(quiet).toBe(2);

      const notes = (await env.DB.prepare("SELECT n.id FROM notes n WHERE n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?)").bind(user.id).all<{ id: number }>()).results;
      expect(notes).toHaveLength(seed % 2 === 0 ? 27 : 24);
      // Every word of every open deck was asked as new exactly once in each direction …
      const expected = notes.flatMap((n) => BOTH.map((d) => `${n.id}:${d}`)).sort();
      expect([...askedNew.keys()].sort()).toEqual(expected);
      expect([...askedNew.values()].every((n) => n === 1)).toBe(true);
      // … and was graded: no card is left new, and each has one first grade in the log.
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND state = 'new'").bind(user.id).first<{ n: number }>();
      expect(left!.n).toBe(0);
      const firsts = await env.DB.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT card_id) AS cards FROM review_log WHERE user_id = ? AND was_new = 1").bind(user.id).first<{ n: number; cards: number }>();
      expect(firsts).toEqual({ n: expected.length, cards: expected.length });
      expect(await levelOf(repo, user.id)).toBe(4);
    });
  }
});

describe("the list of new cards the queue reads (Repo.candidateCards)", () => {
  /** What the queue must list: the new cards of the own decks and of the lowest open level that has any today, in order, and their number. */
  async function expectQueueMatches(repo: Repo, userId: number, at: number, directions: Direction[]) {
    const w = dayWindow(TZ, at);
    const all = await allNewCards(env.DB, userId, w.today, directions);
    const lowest = all.find((c) => c.levelNo !== null)?.levelNo ?? null;
    const want = all.filter((c) => c.levelNo === null || c.levelNo === lowest).slice(0, 50).map((c) => `${c.word} ${c.direction}`);
    const c = await repo.candidateCards(userId, { ...w, directions });
    expect(c.newNotes.map((n) => `${n.word} ${n.direction}`)).toEqual(want);
    expect(c.counts.newAvailable).toBe(want.length);
  }

  it("a card that waits in a deck whose notes enclose the notes of another deck is found, however many cards wait between them", async () => {
    // Two own words are typed, then a level of sixty words appears, then two more own words: the ids of the own
    // deck enclose the level. Direction «оба»; every word is started Tatar → Russian. The reverse cards of the level
    // wait in state 'new' — sixty of them between the own notes — and so does the reverse card of the last own word.
    const repo = new Repo(env.DB);
    const id = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now });
    await repo.updateUser(id, { onboardingStep: null, tzOffsetMin: TZ, level: 1, direction: "both" });
    const deck = await repo.customDeck(id, now);
    const early = await repo.insertNotes(deck, [note("үзем1"), note("үзем2")]);
    const l1 = (await seedLevels(env.DB, { 1: Array.from({ length: 60 }, (_, i) => `сүз${i + 1}`) }))[1]!;
    await repo.subscribe(id, l1, now);
    const late = await repo.insertNotes(deck, [note("үзем3"), note("үзем4")]);
    const level = (await env.DB.prepare("SELECT id FROM notes WHERE deck_id = ? ORDER BY id").bind(l1).all<{ id: number }>()).results.map((r) => r.id);
    const stmts: D1PreparedStatement[] = [];
    for (const n of [...early, ...level, ...late]) stmts.push(repo.insertCardStmt(id, n, "tt_ru", gradedMem(day(-1))));
    for (const n of [...early, late[0]!]) stmts.push(repo.insertCardStmt(id, n, "ru_tt", gradedMem(day(-1))));
    for (const n of [...level, late[1]!]) stmts.push(repo.insertCardStmt(id, n, "ru_tt", newMem(day(-1)), "2026-09-27"));
    for (let i = 0; i < stmts.length; i += 50) await repo.batch(stmts.slice(i, i + 50));

    const list = async () => (await repo.candidateCards(id, { ...dayWindow(TZ, now), directions: BOTH })).newNotes.map((n) => `${n.word} ${n.direction}`);
    expect((await list()).slice(0, 3)).toEqual(["үзем4 ru_tt", "сүз1 ru_tt", "сүз2 ru_tt"]);
    await expectQueueMatches(repo, id, now, BOTH);
    // The own word is repeated today: its reverse card is hidden until tomorrow, the level goes on.
    await env.DB.prepare("UPDATE cards SET buried_day = ? WHERE user_id = ? AND note_id = ? AND direction = 'ru_tt'").bind(dayWindow(TZ, now).today, id, late[1]!).run();
    expect((await list()).slice(0, 2)).toEqual(["сүз1 ru_tt", "сүз2 ru_tt"]);
    await expectQueueMatches(repo, id, now, BOTH);
    await expectQueueMatches(repo, id, now + DAY, BOTH);
    // The level is asked in reverse to its last word but one; the own deck and the level each have one card left.
    await env.DB.prepare("UPDATE cards SET state = 'review', reps = 1 WHERE user_id = ? AND direction = 'ru_tt' AND note_id IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(level.filter((_, i) => i !== 58))).run();
    expect(await list()).toEqual(["сүз59 ru_tt"]);
    await expectQueueMatches(repo, id, now + DAY, BOTH);
    expect((await repo.candidateCards(id, { ...dayWindow(TZ, now + DAY), directions: BOTH })).newNotes.map((n) => n.word)).toEqual(["үзем4", "сүз59"]);
  });

  for (const seed of [11, 12, 13, 14]) {
    it(`learner ${seed}: after every grade, undo and change of direction the list is what a plain read of every open deck gives`, { timeout: SIMULATION_MS }, async () => {
      const r = seeded(seed);
      await seedLevels(env.DB, { 1: SMALL_LEVELS[1]! });
      const { repo, user } = await seedUser(env.DB, { now, level: 1, patch: { direction: seed % 3 === 0 ? "tt_ru" : "both", newPerDay: 5 } });
      await seedLevels(env.DB, { 2: SMALL_LEVELS[2]!, 3: SMALL_LEVELS[3]!, 4: SMALL_LEVELS[4]! });
      const me = async () => (await repo.getUser(user.id))!;
      for (let d = 1; d <= 40; d++) {
        // Own words on day 6, two of them words of the levels 3 and 4 (the last word of level 4), which the levels then skip;
        // more own words on day 25; a word added to level 1 on day 18, when the levels above it are in work.
        if (d === 6) await repo.insertNotes(await repo.customDeck(user.id, day(d)), [note("үзем1"), note("сүз3х2"), note("үзем2"), note("сүз4х6"), note("үзем3")]);
        if (d === 18) await seedLevels(env.DB, { 1: ["сүз1х7"] });
        if (d === 25) await repo.insertNotes(await repo.customDeck(user.id, day(d)), [note("үзем4"), note("үзем5")]);
        // Now and then the learner changes the direction, sometimes in the middle of a day (below).
        if (r() < 0.12) await repo.updateUser(user.id, { direction: (["tt_ru", "ru_tt", "both", "both"] as const)[Math.floor(r() * 4)]! });
        if (r() < 0.25) continue;
        let at = day(d);
        await repo.updateUser(user.id, { mixCounter: Math.floor(r() * 4) });
        let s = await new ReviewService(repo, at).nextScreen(await me());
        for (let n = 0; n < 60 && s.kind === "card"; n++) {
          await expectQueueMatches(repo, user.id, at, directionsOf(await me()));
          at += 5000;
          s = await new ReviewService(repo, at).grade(await me(), s.view.cardId, s.view.reps, randomGrade(r));
          const x = r();
          if (x < 0.08) {
            // The grade is taken back; half of the time the learner then presses «Учить» instead of grading the card again.
            s = await new ReviewService(repo, at).undo(await me());
            if (r() < 0.5) s = await new ReviewService(repo, at).nextScreen(await me());
          } else if (x < 0.11) {
            await repo.updateUser(user.id, { direction: (["tt_ru", "ru_tt", "both"] as const)[Math.floor(r() * 3)]! });
            s = await new ReviewService(repo, at).nextScreen(await me());
          }
        }
        await expectQueueMatches(repo, user.id, at, directionsOf(await me()));
        // The list in each of the three settings, whatever the learner has chosen.
        for (const dirs of [["tt_ru"], ["ru_tt"], BOTH] as Direction[][]) await expectQueueMatches(repo, user.id, at, dirs);
      }
    });
  }
});
