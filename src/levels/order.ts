import { ALL_POS, LEVELS, hasLevel, type LevelNo, type NewMode } from "./scale";

export interface Ordered { level: number; topicNo: number; seq: number }

/** Merges per-level streams (each already in its own order) into the order of `mode`. */
export function mergeStreams<T extends Ordered>(streams: T[][], mode: NewMode): T[] {
  const byTopic = mode !== "freq";
  return streams.flat().sort((a, b) =>
    (byTopic ? a.topicNo - b.topicNo : 0) || a.level - b.level || a.seq - b.seq);
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
/** New-word candidates read per level per queue read. */
export const STREAM_LIMIT = 3;

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
