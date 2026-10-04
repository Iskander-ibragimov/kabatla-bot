/**
 * The learner's scope — which levels and parts of speech are checked, the order of new words, the chosen topic —
 * changed and reported: what /levels and «Темы» show, and the writes behind their buttons. Every change is one
 * statement that looks at the stored settings and changes them (db/repo.ts), so taps that arrive together cannot
 * leave a set empty. A change needs no write to the read positions of the queue: they carry the settings they were
 * stored for and are not used under others (levels/order.ts `scopeKey`).
 */
import type { DeckRow, LevelsData, Repo, User } from "../db/repo";
import { ALL_POS, LEVELS, type LevelNo, type NewMode, POS_GROUPS, hasLevel } from "./scale";

/** A level of the scale: `total` cards the catalog has of it now (0: «скоро») out of the `size` it will have, `started` of them by the learner. */
export interface LevelLine { no: LevelNo; code: string; checked: boolean; total: number; size: number; started: number; coveragePct: number | null }
/** A topic over the checked levels: the cards it has there and how many of them the learner has started. */
export interface TopicLine { no: number; titleRu: string; titleTt: string; started: number; total: number }
export interface Hub {
  levels: LevelLine[];
  mode: NewMode;
  posGroups: number;
  /**
   * The topic the new words come from: the chosen one; in the guided order without a choice, the topic the order
   * stands in (see `currentTopic`); null in «По частоте», in «Сам выбираю тему» without a choice, and when no word is left.
   */
  topic: TopicLine | null;
  /** «Мои слова» and the AI decks. */
  own: Pick<DeckRow, "kind" | "titleRu" | "titleTt" | "total">[];
}

type Scope = Pick<User, "id" | "levels" | "posGroups" | "newMode" | "topicNo">;

const sum = <T>(rows: T[], n: (row: T) => number): number => rows.reduce((total, row) => total + n(row), 0);

/**
 * The five levels of the scale. The started words of a level count whatever is checked, and whatever their part of
 * speech; a word the learner owns a copy of is started, as it is for the queue (see the counters in db/queue.ts).
 */
function levelLinesOf(d: Pick<LevelsData, "decks" | "progress">, levels: number): LevelLine[] {
  return LEVELS.map((l) => {
    const deck = d.decks.find((x) => x.level === l.no);
    return {
      no: l.no, code: l.code, checked: hasLevel(levels, l.no), total: deck?.total ?? 0, size: l.size,
      started: sum(d.progress.filter((p) => p.level === l.no), (p) => p.started), coveragePct: deck?.coveragePct ?? null,
    };
  });
}

/** The topics that have cards in the checked levels, by number, counted over those levels. */
function topicLinesOf(d: Pick<LevelsData, "topics" | "totals" | "progress">, levels: number): TopicLine[] {
  const here = <T extends { level: number; topicNo: number }>(rows: T[], topicNo: number) => rows.filter((r) => r.topicNo === topicNo && r.level >= 1 && hasLevel(levels, r.level));
  return d.topics
    .map((t) => ({ no: t.no, titleRu: t.titleRu, titleTt: t.titleTt, started: sum(here(d.progress, t.no), (p) => p.started), total: sum(here(d.totals, t.no), (g) => g.total) }))
    .filter((t) => t.total > 0);
}

/**
 * The topic the new words come from. A chosen topic is that topic (none in «По частоте», which takes no notice of
 * it). Without a choice only the guided order has one: the first themed topic (1–20) that has a word left; the
 * words of «Основа» (topic 0) are mixed into the themed topics there, so it is named only when every themed topic
 * is finished and it is not.
 */
function currentTopic(lines: TopicLine[], user: Pick<User, "newMode" | "topicNo">): TopicLine | null {
  if (user.newMode === "freq") return null;
  if (user.topicNo != null) return lines.find((l) => l.no === user.topicNo) ?? null;
  if (user.newMode === "topic") return null;
  const open = lines.filter((l) => l.started < l.total);
  return open.find((l) => l.no >= 1) ?? open[0] ?? null;
}

/** The cards of the checked levels that are not started, by the counters; a counter above the cards of its level counts as the level started whole. */
export const unstartedIn = (levels: LevelLine[]): number => sum(levels.filter((l) => l.checked), (l) => Math.max(0, l.total - l.started));

/**
 * The share of ordinary text the learner's levels cover: the coverage of the highest level up to which every level
 * is started whole, checked or not; null while A1 is not, and when that level has no coverage on record.
 */
export function coverageOf(levels: LevelLine[]): number | null {
  let pct: number | null = null;
  for (const l of levels) {
    if (l.total === 0 || l.started < l.total) break;
    pct = l.coveragePct;
  }
  return pct;
}

/** The lines of the five levels alone, for the statistics. One D1 call. */
export async function levelLines(repo: Repo, user: Pick<User, "id" | "levels">): Promise<LevelLine[]> {
  return levelLinesOf(await repo.levelsData(user.id, false), user.levels);
}

/** What /levels shows. One D1 call. */
export async function hub(repo: Repo, user: Scope): Promise<Hub> {
  const d = await repo.levelsData(user.id, true);
  return {
    levels: levelLinesOf(d, user.levels), mode: user.newMode, posGroups: user.posGroups, topic: currentTopic(topicLinesOf(d, user.levels), user),
    own: d.own.map((deck) => ({ kind: deck.kind, titleRu: deck.titleRu, titleTt: deck.titleTt, total: deck.total })),
  };
}

/** What «Темы» shows: the topics with cards in the checked levels, by number. One D1 call. */
export async function topicLines(repo: Repo, user: Pick<User, "id" | "levels">): Promise<TopicLine[]> {
  return topicLinesOf(await repo.levelsData(user.id, false), user.levels);
}

/**
 * Checks or unchecks a level. `soon`: the catalog has no card of it (or it is no level of the scale); `last`: it is
 * the only level checked. In both cases nothing is written. A chosen topic that has no card in the new set of
 * levels is cleared with the change.
 */
export async function toggleLevel(repo: Repo, user: Pick<User, "id">, no: number): Promise<"ok" | "last" | "soon"> {
  if (!LEVELS.some((l) => l.no === no)) return "soon";
  const r = await repo.toggleLevel(user.id, no);
  return r.changed ? "ok" : r.hasCards ? "last" : "soon";
}

/**
 * Checks a level and never unchecks it: what a button that adds a level does, however many times it is pressed.
 * Returns the set of levels checked after it; the level is not in it when the catalog has no card of it.
 */
export async function addLevel(repo: Repo, user: Pick<User, "id">, no: number): Promise<number> {
  return repo.checkLevel(user.id, no);
}

/** Checks or unchecks the part-of-speech group at bit index `bit`. `last`: it is the only group checked, and nothing is written. */
export async function togglePos(repo: Repo, user: Pick<User, "id">, bit: number): Promise<"ok" | "last"> {
  if (!POS_GROUPS.some((g) => g.bit === bit)) throw new RangeError(`no part-of-speech group at bit ${bit}`);
  return (await repo.togglePosGroup(user.id, bit)) ? "ok" : "last";
}

/** Sets the order of new words. The chosen topic stays: «По частоте» takes no notice of it, the other two give it first. */
export async function setMode(repo: Repo, user: Pick<User, "id">, mode: NewMode): Promise<void> {
  await repo.updateUser(user.id, { newMode: mode });
}

/** Chooses the topic of the new words, or none (null). `empty`: the topic has no card in the checked levels, and nothing is written. */
export async function setTopic(repo: Repo, user: Pick<User, "id">, topicNo: number | null): Promise<"ok" | "empty"> {
  return (await repo.chooseTopic(user.id, topicNo)) ? "ok" : "empty";
}

/** Checks every part-of-speech group. */
export async function addAllPos(repo: Repo, user: Pick<User, "id">): Promise<void> {
  await repo.updateUser(user.id, { posGroups: ALL_POS });
}
