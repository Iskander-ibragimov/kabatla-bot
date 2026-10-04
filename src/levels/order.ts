import { ALL_POS, LEVELS, TSEQ_BASE, hasLevel, type LevelNo, type NewMode, tseqOf } from "./scale";

/**
 * The guided order of ONE level, as the `tseq` of each of its rows (in input order): `ORDER BY tseq` is that order.
 *
 * A themed word (topic 1–20) and a basic one (topic 0, «Основа») alternate, the themed first, until one of the two
 * lists ends; then the rest of the other follows. Themed words are taken by topic number and then by their place in
 * the level (`seq`), basic words by their place in the level. So a beginner meets the pronouns and particles a few
 * at a time among the words of the topics, not all of them before the first greeting.
 *
 * `tseq = anchor × TSEQ_BASE + position`. The anchor of a themed word is its topic; the anchor of a basic word is the
 * topic of the themed word just before it (0 when the level has no themed word). `position` counts 1, 2, 3… through
 * the words of one anchor. So the words of an anchor are one unbroken range of `tseq`, and the themed words of a
 * topic lie inside the range of that topic.
 */
export function guidedTseq(rows: { topicNo: number; seq: number }[]): number[] {
  const at = rows.map((r, i) => ({ ...r, i }));
  const themed = at.filter((r) => r.topicNo >= 1).sort((a, b) => a.topicNo - b.topicNo || a.seq - b.seq);
  const basic = at.filter((r) => !(r.topicNo >= 1)).sort((a, b) => a.seq - b.seq);
  const tseq = new Array<number>(rows.length);
  let anchor = 0;
  let position = 0;
  const put = (i: number, a: number) => {
    if (a !== anchor) { anchor = a; position = 0; }
    tseq[i] = tseqOf(anchor, ++position);
  };
  for (let k = 0; k < Math.max(themed.length, basic.length); k++) {
    const t = themed[k];
    if (t) put(t.i, t.topicNo);
    const b = basic[k];
    if (b) put(b.i, anchor);
  }
  return tseq;
}

/** The anchor of a place in the guided order: the topic whose run the word stands in; see `guidedTseq`. */
export const anchorOf = (tseq: number): number => Math.floor(tseq / TSEQ_BASE);

/** A word with its level and its two places in it: `seq` in the order of the level, `tseq` in the guided order. */
export interface Ordered { level: number; seq: number; tseq: number }

/**
 * Merges per-level streams (each already in its own order) into the order of `mode`. `guided`, `topic`: by anchor,
 * then the lower level first, then the guided order of the level. `freq`: the lower level first, then its own order.
 */
export function mergeStreams<T extends Ordered>(streams: T[][], mode: NewMode): T[] {
  return streams.flat().sort((a, b) =>
    mode === "freq" ? a.level - b.level || a.seq - b.seq : anchorOf(a.tseq) - anchorOf(b.tseq) || a.level - b.level || a.tseq - b.tseq);
}

export type EmptyReason =
  | { kind: "pickTopic" }
  | { kind: "allPos" }
  | { kind: "addLevel"; level: LevelNo }
  | { kind: "allDone" };

export interface EmptyFacts {
  mode: NewMode;
  levels: number;
  posGroups: number;
  /** Catalog cards per level 1-5. */
  totals: Record<number, number>;
  /** Started catalog cards per level 1-5. */
  started: Record<number, number>;
}

/** Why there are no new words, and what to offer. */
export function emptyReason(f: EmptyFacts): EmptyReason {
  if (f.mode === "topic") return { kind: "pickTopic" };
  const total = (n: number) => f.totals[n] ?? 0;
  const started = (n: number) => f.started[n] ?? 0;
  if (f.posGroups !== ALL_POS && LEVELS.some((l) => hasLevel(f.levels, l.no) && total(l.no) > started(l.no))) return { kind: "allPos" };
  const next = LEVELS.find((l) => !hasLevel(f.levels, l.no) && total(l.no) > 0);
  return next ? { kind: "addLevel", level: next.no } : { kind: "allDone" };
}

/** Read position of one level: nothing at or before `from`, and nothing after `to` (when known), is a new word. */
export interface Span { from: number; to: number | null }
export type Spans = Partial<Record<number, Span>>;

export function scopeKey(u: { levels: number; posGroups: number; newMode: NewMode; topicNo: number | null; direction: string }): string {
  return [u.levels, u.posGroups, u.newMode, u.topicNo ?? 0, u.direction].join(".");
}

const NONE = { version: -1, spans: {} as Spans };

/** Stored shape: `{k: scope key, v: catalog version, s: {level: [from, to]}}`. */
export function readSpans(raw: string | null, key: string): { version: number; spans: Spans } {
  if (raw === null) return { version: -1, spans: {} };
  try {
    const o = JSON.parse(raw) as { k?: unknown; v?: unknown; s?: unknown };
    if (!o || o.k !== key || typeof o.v !== "number" || !Number.isInteger(o.v) || !o.s || typeof o.s !== "object") return { ...NONE, spans: {} };
    const spans: Spans = {};
    for (const [lv, p] of Object.entries(o.s as Record<string, unknown>)) {
      const no = Number(lv);
      if (!Number.isInteger(no) || !Array.isArray(p) || p.length !== 2) return { ...NONE, spans: {} };
      const [from, to] = p as unknown[];
      if (typeof from !== "number" || !(to === null || typeof to === "number")) return { ...NONE, spans: {} };
      spans[no] = { from, to };
    }
    return { version: o.v, spans };
  } catch {
    return { ...NONE, spans: {} };
  }
}

export function writeSpans(key: string, version: number, spans: Spans): string {
  const s: Record<string, [number, number | null]> = {};
  for (const [lv, sp] of Object.entries(spans)) if (sp) s[lv] = [sp.from, sp.to];
  return JSON.stringify({ k: key, v: version, s });
}

/** A span is saved only when it moved this far (fewer writes), or when `to` changed. */
export const CURSOR_STEP = 25;
/**
 * New-word candidates read per level per queue read. One is enough: the session merges the heads of the level streams
 * and gives one card. A level whose head is where it was costs a row or two; only the level whose head was just
 * started is walked on to its next candidate, once, however far that is, and the position found is stored.
 */
export const STREAM_LIMIT = 1;

export function nextSpans(
  prev: Spans,
  seen: Partial<Record<number, { first: number | null; last: number | null; full: boolean }>>,
): { spans: Spans; save: boolean } {
  const spans: Spans = { ...prev };
  let save = false;
  for (const [lv, s] of Object.entries(seen)) {
    if (!s) continue;
    const no = Number(lv);
    const before = prev[no];
    const from0 = before?.from ?? 0;
    const next: Span = s.first == null ? { from: from0, to: from0 } : { from: s.first - 1, to: s.full ? null : s.last };
    spans[no] = next;
    if (Math.abs(next.from - from0) >= CURSOR_STEP || next.to !== (before ? before.to : undefined)) save = true;
  }
  return { spans, save };
}
