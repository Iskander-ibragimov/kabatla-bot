import { describe, expect, it } from "vitest";
import { CURSOR_STEP, STREAM_LIMIT, emptyReason, guidedTseq, mergeStreams, nextSpans, readSpans, scopeKey, writeSpans, type EmptyFacts } from "../../src/levels/order";
import { ALL_POS, tseqOf } from "../../src/levels/scale";

/** A word of a level whose place in the guided order is `position` in the run of `anchor`. */
const o = (level: number, anchor: number, position: number, seq = position) => ({ level, seq, tseq: tseqOf(anchor, position) });

describe("guidedTseq", () => {
  const row = (topicNo: number, seq: number) => ({ topicNo, seq });
  /** The rows in the order of the values given for them. */
  const inOrder = (rows: { topicNo: number; seq: number }[], tseq: number[]) =>
    rows.map((r, i) => ({ ...r, tseq: tseq[i]! })).sort((a, b) => a.tseq - b.tseq).map((r) => `${r.topicNo}:${r.seq}`);

  it("alternates a themed word and a basic one, the themed first; a basic word is anchored at the topic of the themed word before it", () => {
    const rows = [row(0, 1), row(1, 2), row(0, 3), row(2, 4), row(1, 5), row(0, 6)];
    const tseq = guidedTseq(rows);
    expect(inOrder(rows, tseq)).toEqual(["1:2", "0:1", "1:5", "0:3", "2:4", "0:6"]);
    // In input order: the basic rows at 1, 1 and 2; positions count inside the run of an anchor.
    expect(tseq).toEqual([1_000_002, 1_000_001, 1_000_004, 2_000_001, 1_000_003, 2_000_002]);
  });
  it("a level of basic words only is anchored at 0, in the order of the level", () => {
    expect(guidedTseq([row(0, 3), row(0, 1), row(0, 2)])).toEqual([3, 1, 2]);
    expect(guidedTseq([])).toEqual([]);
  });
  it("more basic words than themed ones: the rest of them follows the last themed word and is anchored at its topic", () => {
    const rows = [row(0, 1), row(0, 2), row(0, 3), row(0, 4), row(3, 5), row(7, 6)];
    const tseq = guidedTseq(rows);
    expect(inOrder(rows, tseq)).toEqual(["3:5", "0:1", "7:6", "0:2", "0:3", "0:4"]);
    expect(tseq).toEqual([3_000_002, 7_000_002, 7_000_003, 7_000_004, 3_000_001, 7_000_001]);
  });
  it("more themed words than basic ones: the rest of them follows by topic and then by place in the level", () => {
    const rows = [row(2, 1), row(1, 2), row(0, 3), row(2, 4), row(1, 5)];
    const tseq = guidedTseq(rows);
    expect(inOrder(rows, tseq)).toEqual(["1:2", "0:3", "1:5", "2:1", "2:4"]);
    expect(tseq).toEqual([2_000_001, 1_000_001, 1_000_002, 2_000_002, 1_000_003]);
  });
  it("the order the rows are given in does not matter", () => {
    const rows = [row(0, 1), row(1, 2), row(0, 3), row(2, 4), row(1, 5), row(0, 6)];
    const shuffled = [4, 0, 5, 2, 1, 3].map((i) => rows[i]!);
    const tseq = guidedTseq(shuffled);
    expect(shuffled.map((r, i) => [rows.indexOf(r), tseq[i]]).sort((a, b) => a[0]! - b[0]!).map((x) => x[1])).toEqual(guidedTseq(rows));
  });
  it("the words of one anchor are one range of values, and no two words share a value", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i % 4 === 0 ? 0 : 1 + (i % 5), i + 1));
    const tseq = guidedTseq(rows);
    expect(new Set(tseq).size).toBe(60);
    const sorted = [...tseq].sort((a, b) => a - b);
    for (const [i, v] of sorted.entries()) {
      const before = sorted[i - 1];
      // The next value is the next position of the same anchor, or position 1 of a later anchor.
      if (before !== undefined) expect(v === before + 1 || (v % 1_000_000 === 1 && Math.floor(v / 1_000_000) > Math.floor(before / 1_000_000))).toBe(true);
    }
  });
});

describe("mergeStreams", () => {
  const streams = [[o(1, 2, 5), o(1, 3, 1)], [o(2, 2, 1)]];
  it("guided and topic order by anchor, level, place in the guided order of the level", () => {
    expect(mergeStreams(streams, "guided")).toEqual([o(1, 2, 5), o(2, 2, 1), o(1, 3, 1)]);
    expect(mergeStreams(streams, "topic")).toEqual([o(1, 2, 5), o(2, 2, 1), o(1, 3, 1)]);
  });
  it("guided keeps the basic words of an anchor with it: the whole run of a level comes before the same anchor of the next level", () => {
    // Level 1: a themed word of topic 1 (seq 40) and the basic word after it (seq 2); level 2: a themed word of topic 1.
    const one = [o(1, 1, 1, 40), o(1, 1, 2, 2), o(1, 2, 1, 7)];
    const two = [o(2, 1, 1, 3)];
    expect(mergeStreams([two, one], "guided")).toEqual([o(1, 1, 1, 40), o(1, 1, 2, 2), o(2, 1, 1, 3), o(1, 2, 1, 7)]);
    expect(mergeStreams([two, one], "freq")).toEqual([o(1, 1, 2, 2), o(1, 2, 1, 7), o(1, 1, 1, 40), o(2, 1, 1, 3)]);
  });
  it("freq orders by level, seq", () => {
    expect(mergeStreams(streams, "freq")).toEqual([o(1, 3, 1), o(1, 2, 5), o(2, 2, 1)]);
  });
  it("does not mutate the input", () => {
    mergeStreams(streams, "freq");
    expect(streams[0]).toEqual([o(1, 2, 5), o(1, 3, 1)]);
  });
});

describe("emptyReason", () => {
  const base: EmptyFacts = { mode: "guided", levels: 0b1, posGroups: ALL_POS, totals: { 1: 10, 2: 10, 3: 0, 4: 5, 5: 0 }, started: { 1: 10, 2: 0, 3: 0, 4: 0, 5: 0 } };
  it("topic mode asks for a topic", () => {
    expect(emptyReason({ ...base, mode: "topic" })).toEqual({ kind: "pickTopic" });
  });
  it("narrowed parts of speech with unstarted words in a checked level", () => {
    expect(emptyReason({ ...base, posGroups: 1, started: { ...base.started, 1: 4 } })).toEqual({ kind: "allPos" });
  });
  it("narrowed parts of speech but checked levels fully started falls through", () => {
    expect(emptyReason({ ...base, posGroups: 1 })).toEqual({ kind: "addLevel", level: 2 });
  });
  it("adds the lowest unchecked level that has cards", () => {
    expect(emptyReason({ ...base, levels: 0b1 })).toEqual({ kind: "addLevel", level: 2 });
    expect(emptyReason({ ...base, levels: 0b11 })).toEqual({ kind: "addLevel", level: 4 });
  });
  it("all done when nothing is left", () => {
    expect(emptyReason({ ...base, levels: 0b01011, started: { 1: 10, 2: 10, 3: 0, 4: 5, 5: 0 } })).toEqual({ kind: "allDone" });
  });
});

describe("spans storage", () => {
  const u = { levels: 3, posGroups: 255, newMode: "guided" as const, topicNo: null, direction: "tt_ru" };
  it("scopeKey differs by every field", () => {
    const k = scopeKey(u);
    expect(scopeKey({ ...u })).toBe(k);
    for (const change of [{ levels: 1 }, { posGroups: 1 }, { newMode: "freq" as const }, { topicNo: 4 }, { direction: "ru_tt" }]) {
      expect(scopeKey({ ...u, ...change })).not.toBe(k);
    }
  });
  it("round-trips and ignores another key", () => {
    const raw = writeSpans("k", 4, { 1: { from: 10, to: null }, 3: { from: 0, to: 7 } });
    expect(readSpans(raw, "k")).toEqual({ version: 4, spans: { 1: { from: 10, to: null }, 3: { from: 0, to: 7 } } });
    expect(readSpans(raw, "other")).toEqual({ version: -1, spans: {} });
  });
  it("tolerates null and broken input", () => {
    const empty = { version: -1, spans: {} };
    expect(readSpans(null, "k")).toEqual(empty);
    expect(readSpans("{oops", "k")).toEqual(empty);
    expect(readSpans("42", "k")).toEqual(empty);
    expect(readSpans('{"k":"k","v":"x","s":{}}', "k")).toEqual(empty);
    expect(readSpans('{"k":"k","v":1,"s":{"1":[1]}}', "k")).toEqual(empty);
  });
});

describe("nextSpans", () => {
  /** What a stream of one level held; with STREAM_LIMIT = 1 a stream holds its head (`full`) or nothing. */
  const head = (ord: number) => ({ 1: { first: ord, last: ord, full: true } });
  const nothing = { 1: { first: null, last: null, full: false } };
  it("constants", () => {
    expect(CURSOR_STEP).toBe(25);
    expect(STREAM_LIMIT).toBe(1);
  });
  it("a head: the span starts just before it and its end is unknown; saved at a move of 25 but not of 24", () => {
    const prev = { 1: { from: 100, to: null } };
    expect(nextSpans(prev, head(125 + 1))).toEqual({ spans: { 1: { from: 125, to: null } }, save: true });
    expect(nextSpans(prev, head(124 + 1))).toEqual({ spans: { 1: { from: 124, to: null } }, save: false });
    expect(nextSpans(prev, head(101))).toEqual({ spans: { 1: { from: 100, to: null } }, save: false });
  });
  it("no note: the level is finished for the scope — the span collapses onto from and is saved", () => {
    expect(nextSpans({ 1: { from: 40, to: null } }, nothing)).toEqual({ spans: { 1: { from: 40, to: 40 } }, save: true });
    // Read again, the finished level changes nothing and asks for no save.
    expect(nextSpans({ 1: { from: 40, to: 40 } }, nothing)).toEqual({ spans: { 1: { from: 40, to: 40 } }, save: false });
  });
  it("a head in a level whose stored span had an end: the end is unknown again, and that is saved", () => {
    expect(nextSpans({ 1: { from: 100, to: 100 } }, head(101))).toEqual({ spans: { 1: { from: 100, to: null } }, save: true });
  });
  it("treats a missing previous span as from 0, and saves it", () => {
    expect(nextSpans({}, nothing)).toEqual({ spans: { 1: { from: 0, to: 0 } }, save: true });
    expect(nextSpans({}, head(3))).toEqual({ spans: { 1: { from: 2, to: null } }, save: true });
  });
  it("keeps levels it did not see", () => {
    const r = nextSpans({ 2: { from: 5, to: null } }, head(1));
    expect(r.spans[2]).toEqual({ from: 5, to: null });
  });
  it("the rule for a stream longer than one note still holds: notes but fewer than the limit end the span at the last of them", () => {
    expect(nextSpans({ 1: { from: 100, to: null } }, { 1: { first: 101, last: 300, full: false } })).toEqual({ spans: { 1: { from: 100, to: 300 } }, save: true });
    expect(nextSpans({}, { 1: { first: 3, last: 9, full: false } })).toEqual({ spans: { 1: { from: 2, to: 9 } }, save: true });
  });
});
