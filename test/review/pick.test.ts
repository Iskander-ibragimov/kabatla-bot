import { describe, expect, it } from "vitest";
import { type Candidates, NEW_AFTER_LEARNING, NO_RECENT, pick, recentOf } from "../../src/review/pick";
import type { CardRow, NewNote } from "../../src/db/repo";
import { newMem } from "../../src/srs/ladder";

const T = Date.UTC(2026, 8, 30, 6);
const note = { word: "сүз", transcription: null, pos: "", translation: "слово", exampleTt: "", exampleRu: "", exampleSrc: "", audioFileId: null, sourceUrl: null };
const card = (id: number, state: CardRow["mem"]["state"], due: number, noteId = id, direction: CardRow["direction"] = "tt_ru"): CardRow =>
  ({ ...note, id, noteId, direction, buriedDay: null, mem: { ...newMem(T), state, due } });
const fresh = (id: number): NewNote => ({ ...note, noteId: 100 + id, direction: "tt_ru" });
const cands = (learning: CardRow[], review: CardRow[], newNotes: NewNote[]): Candidates => ({ learning, review, newNotes });

describe("pick", () => {
  it("due learning card comes first", () => {
    const p = pick(cands([card(1, "learning", T - 1)], [card(2, "review", T - 5)], [fresh(1)]), 5, T, 0);
    expect(p).toEqual({ kind: "card", card: expect.objectContaining({ id: 1 }) });
  });

  it("new cards are spread among reviews", () => {
    const reviews = Array.from({ length: 10 }, (_, i) => card(10 + i, "review", T - 1000));
    const seq = [0, 1, 2, 3, 4, 5].map((mix) => pick(cands([], reviews, [fresh(1)]), 5, T, mix)!.kind);
    expect(seq).toEqual(["card", "card", "new", "card", "card", "new"]);
  });

  it("learn-ahead shows a learning card due within 60s when nothing else", () => {
    const p = pick(cands([card(1, "learning", T + 59_000)], [], []), 0, T, 0);
    expect(p?.kind).toBe("card");
  });

  it("no learn-ahead beyond 60s", () => {
    expect(pick(cands([card(1, "learning", T + 61_000)], [], [fresh(1)]), 0, T, 0)).toBeNull();
  });

  it("respects zero new left", () => {
    expect(pick(cands([], [], [fresh(1)]), 0, T, 0)).toBeNull();
  });
});

describe("pick and the last answers (spec A1, A2)", () => {
  it("a new word comes after two learning cards", () => {
    expect(NEW_AFTER_LEARNING).toBe(2);
  });

  it("after two learning cards in a row a new word comes before a due learning card (A1)", () => {
    const c = cands([card(1, "learning", T - 1)], [], [fresh(1)]);
    expect(pick(c, 5, T, 0, { noteId: 9, learningRun: 2 })?.kind).toBe("new");
    expect(pick(c, 5, T, 0, { noteId: 9, learningRun: 1 })?.kind).toBe("card");
    expect(pick(c, 0, T, 0, { noteId: 9, learningRun: 2 })?.kind).toBe("card"); // the day's limit holds
  });

  it("A1 gives a new word, not the new reverse card of a word on a learning step", () => {
    const reverse = { ...fresh(1), noteId: 2, direction: "ru_tt" as const };
    const c = cands([card(1, "learning", T - 1), card(2, "learning", T + 120_000)], [], [reverse, fresh(2)]);
    expect(pick(c, 5, T, 0, { noteId: 9, learningRun: 2 })).toEqual({ kind: "new", note: expect.objectContaining({ noteId: 102 }) });
    expect(pick(cands(c.learning, [], [reverse]), 5, T, 0, { noteId: 9, learningRun: 2 })).toEqual({ kind: "card", card: expect.objectContaining({ id: 1 }) });
  });

  it("the word just answered is not next while another due card exists (A2)", () => {
    const p = pick(cands([card(1, "learning", T - 2), card(2, "learning", T - 1)], [], []), 0, T, 0, { noteId: 1, learningRun: 1 });
    expect(p).toEqual({ kind: "card", card: expect.objectContaining({ id: 2 }) });
  });

  it("nor its card of the other direction", () => {
    const c = cands([card(1, "learning", T + 120_000), card(3, "learning", T - 2, 1, "ru_tt"), card(2, "learning", T - 1)], [], []);
    expect(pick(c, 0, T, 0, { noteId: 1, learningRun: 1 })).toEqual({ kind: "card", card: expect.objectContaining({ id: 2 }) });
  });

  it("nor a new card of the same note", () => {
    const c = cands([], [card(2, "review", T - 1)], [{ ...fresh(1), noteId: 1, direction: "ru_tt" }]);
    expect(pick(c, 5, T, 1, { noteId: 1, learningRun: 0 })).toEqual({ kind: "card", card: expect.objectContaining({ id: 2 }) });
  });

  it("a new word or a learn-ahead card counts as another card", () => {
    expect(pick(cands([card(1, "learning", T - 1)], [], [fresh(1)]), 5, T, 0, { noteId: 1, learningRun: 0 })?.kind).toBe("new");
    expect(pick(cands([card(1, "learning", T - 1), card(2, "learning", T + 30_000)], [], []), 0, T, 0, { noteId: 1, learningRun: 0 }))
      .toEqual({ kind: "card", card: expect.objectContaining({ id: 2 }) });
  });

  it("the same card again when nothing else can be shown (L6 kept)", () => {
    expect(pick(cands([card(1, "learning", T + 30_000)], [], []), 0, T, 0, { noteId: 1, learningRun: 1 }))
      .toEqual({ kind: "card", card: expect.objectContaining({ id: 1 }) });
  });

  it("recentOf: the last word and the run of learning answers", () => {
    expect(recentOf([])).toEqual(NO_RECENT);
    expect(recentOf([{ cardId: 5, noteId: 7, stateBefore: "learning" }, { cardId: 6, noteId: 8, stateBefore: "relearning" }])).toEqual({ noteId: 7, learningRun: 2 });
    expect(recentOf([{ cardId: 5, noteId: 7, stateBefore: "new" }, { cardId: 6, noteId: 8, stateBefore: "learning" }])).toEqual({ noteId: 7, learningRun: 0 });
    expect(recentOf([{ cardId: 5, noteId: 7, stateBefore: "learning" }, { cardId: 6, noteId: 8, stateBefore: "review" }])).toEqual({ noteId: 7, learningRun: 1 });
  });
});
