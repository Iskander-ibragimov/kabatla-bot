export type CardState = "new" | "learning" | "review" | "relearning";
export type Rating = 1 | 2 | 3 | 4;
export type Lang = "ru" | "tt";
export type Stage = "new" | "learning" | "known" | "learned";

/** Memory state of one card, stored in D1 as plain numbers (ms epoch). */
export interface Mem {
  state: CardState;
  step: number | null;
  stability: number | null;
  difficulty: number | null;
  due: number;
  lastReview: number | null;
  scheduledDays: number;
  reps: number;
  lapses: number;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The ten rungs of the ladder in ms; index 0 is rung 1. A new word is rung 0. */
export const RUNGS: readonly number[] = [1 * MIN, 10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 120 * DAY, 180 * DAY];
export const TOP = 10;
/** «Трудно» on rung 0 or 1 comes back after this long. */
export const HARD_BOTTOM_MS = 5 * MIN;
/** From this many answers of a card today on, «Снова» and «Трудно» send it to tomorrow (spec A3). */
export const DAY_ANSWERS = 3;
/** How far «Снова» and «Трудно» send a card that has had enough for today. */
export const TOMORROW_MS = DAY;

/** Rung 0…10 of a card, also for cards written by the old scheduler. */
export function rungOf(m: Mem): number {
  if (m.state === "new") return 0;
  if (m.state !== "review") return Math.min(Math.max((m.step ?? 0) + 1, 1), 2);
  let rung = 3;
  for (let r = 4; r <= TOP; r++) if (RUNGS[r - 1]! / DAY <= m.scheduledDays) rung = r;
  return rung;
}

export function newMem(now: number): Mem {
  return { state: "new", step: null, stability: null, difficulty: null, due: now, lastReview: null, scheduledDays: 0, reps: 0, lapses: 0 };
}

function nextRung(rung: number, rating: Rating): number {
  switch (rating) {
    case 1: return 1;
    case 2: return Math.max(rung, 1);
    case 3: return rung === 0 ? 2 : Math.min(rung + 1, TOP);
    case 4: return rung === 0 ? 3 : Math.min(rung + 2, TOP);
  }
}

function intervalMs(rung: number, next: number, rating: Rating): number {
  return rating === 2 && rung <= 1 ? HARD_BOTTOM_MS : RUNGS[next - 1]!;
}

/**
 * The card after one answer. `answersToday` is the card's answers today that were not undone,
 * before this one; from DAY_ANSWERS on, «Снова» and «Трудно» put the card on rung 1 due in one day
 * instead of in 1 or 5 minutes, so a hard word leaves the session for tomorrow (spec A3).
 */
export function grade(m: Mem, rating: Rating, now: number, answersToday = 0): Mem {
  if (answersToday >= DAY_ANSWERS && rating <= 2) {
    return {
      state: m.state === "review" || m.state === "relearning" ? "relearning" : "learning",
      step: 0,
      stability: null,
      difficulty: null,
      due: now + TOMORROW_MS,
      lastReview: now,
      scheduledDays: 0,
      reps: m.reps + 1,
      lapses: rating === 1 && m.state === "review" ? m.lapses + 1 : m.lapses,
    };
  }
  const rung = rungOf(m);
  const next = nextRung(rung, rating);
  const minute = next <= 2;
  return {
    state: minute ? (m.state === "review" || m.state === "relearning" ? "relearning" : "learning") : "review",
    step: minute ? next - 1 : null,
    stability: null,
    difficulty: null,
    due: now + intervalMs(rung, next, rating),
    lastReview: now,
    scheduledDays: minute ? 0 : RUNGS[next - 1]! / DAY,
    reps: m.reps + 1,
    lapses: rating === 1 && m.state === "review" ? m.lapses + 1 : m.lapses,
  };
}

/**
 * Due time for each of the 4 ratings; the ladder has no fuzz, so with the same `answersToday`
 * this is exactly what grade() will store.
 */
export function preview(m: Mem, now: number, answersToday = 0): Record<Rating, number> {
  const due = (r: Rating) => grade(m, r, now, answersToday).due;
  return { 1: due(1), 2: due(2), 3: due(3), 4: due(4) };
}

export function stage(m: Mem): Stage {
  if (m.state === "new") return "new";
  if (m.state !== "review") return "learning";
  if (m.scheduledDays >= 21) return "learned";
  if (m.scheduledDays >= 7) return "known";
  return "learning";
}

/** How many days the word is currently held in memory. */
export function memoryDays(m: Mem): number {
  return m.state === "review" ? m.scheduledDays : 0;
}
