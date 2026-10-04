import type { DirectionSetting, Lang, Repo, User } from "../db/repo";
import { type LevelLine, levelLines, toggleLevel } from "../levels/service";
import { HINT } from "../tutorial/hints";

const MIN = 60_000;
const DAY = 86_400_000;
const DAY_START_MIN = 4 * 60;

/** Local calendar day with the Anki-style 04:00 boundary, as YYYY-MM-DD. */
export function localDay(offsetMin: number, now: number): string {
  return new Date(now + (offsetMin - DAY_START_MIN) * MIN).toISOString().slice(0, 10);
}

/** Minutes since local midnight. */
export function localMinutes(offsetMin: number, now: number): number {
  const d = new Date(now + offsetMin * MIN);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Next UTC moment (strictly after `after`) when the user's local clock shows hh:mm. */
export function nextOccurrence(offsetMin: number, hhmm: string, after: number): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const localMidnight = Math.floor((after + offsetMin * MIN) / DAY) * DAY - offsetMin * MIN;
  let t = localMidnight + (h * 60 + m) * MIN;
  if (t <= after) t += DAY;
  return t;
}

export const EVENING_AT = "20:00";

export interface Window { dayStartMs: number; dayEndMs: number; today: string }

export function dayWindow(offsetMin: number, now: number): Window {
  const shifted = now + (offsetMin - DAY_START_MIN) * MIN;
  const dayStartMs = Math.floor(shifted / DAY) * DAY - (offsetMin - DAY_START_MIN) * MIN;
  return { dayStartMs, dayEndMs: dayStartMs + DAY, today: localDay(offsetMin, now) };
}


/** Interface language from Telegram's language code: Tatar for `tt`, Russian for everything else. */
export function langFromTelegram(code?: string): Lang {
  return code?.split(/[-_]/)[0]!.toLowerCase() === "tt" ? "tt" : "ru";
}

export async function getOrCreate(repo: Repo, tgId: number, chatId: number, tgLang: string | undefined, now: number): Promise<{ user: User; created: boolean }> {
  const existing = await repo.getUserByTg(tgId);
  if (existing) return { user: existing, created: false };
  await repo.insertUser({ tgId, chatId, lang: langFromTelegram(tgLang), now });
  return { user: (await repo.getUserByTg(tgId))!, created: true };
}

export type SettingKey = "lang" | "retention" | "newPerDay" | "remindAt" | "direction" | "autoplay" | "tzOffsetMin";
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const RETENTIONS = [0.85, 0.9, 0.95] as const;
export const NEW_PER_DAY = [5, 10, 20] as const;
export const REMIND_TIMES = ["08:00", "09:00", "12:00", "19:00", "21:00"] as const;
/** The time zones the settings offer, as minutes east of UTC: UTC+2 … UTC+12 by the hour. */
export const TZ_OFFSETS: readonly number[] = Array.from({ length: 11 }, (_, i) => 120 + i * 60);

export async function setSetting(repo: Repo, userId: number, key: SettingKey, value: unknown, now = Date.now()): Promise<void> {
  const bad = () => { throw new Error(`invalid ${key}: ${String(value)}`); };
  switch (key) {
    case "lang": if (value !== "ru" && value !== "tt") bad(); break;
    case "retention": if (!RETENTIONS.includes(value as never)) bad(); break;
    case "newPerDay": if (!NEW_PER_DAY.includes(value as never)) bad(); break;
    case "remindAt": if (typeof value !== "string" || !HHMM.test(value)) bad(); break;
    case "direction": if (!["tt_ru", "ru_tt", "both"].includes(value as string)) bad(); break;
    case "autoplay": if (typeof value !== "boolean") bad(); break;
    case "tzOffsetMin": if (!TZ_OFFSETS.includes(value as number)) bad(); break;
  }
  const patch = { [key]: value } as Partial<User>;
  // The reminders are kept as moments: a new hour or a new clock moves the next one.
  if (key === "remindAt" || key === "tzOffsetMin") {
    const u = await repo.getUser(userId);
    if (u) {
      const after = { ...u, ...patch };
      patch.nextDailyAt = nextOccurrence(after.tzOffsetMin, after.remindAt, now);
      if (key === "tzOffsetMin") {
        patch.nextEveningAt = nextOccurrence(after.tzOffsetMin, EVENING_AT, now);
        // On a clock moved back the day of the last study may lie ahead of today, and the next grade would count the
        // streak as broken: that day becomes today. Moved forward it is at most yesterday, which keeps the streak.
        const today = localDay(after.tzOffsetMin, now);
        if (u.lastStudyDay != null && u.lastStudyDay > today) patch.lastStudyDay = today;
        // The daily limits count by the local day (entitlements/service.ts): what was taken today is taken today on
        // the new clock too, or a change of the zone across the start of the day would give the day's units again.
        const was = localDay(u.tzOffsetMin, now);
        if (u.gensDay === was) patch.gensDay = today;
        if (u.addsDay === was) patch.addsDay = today;
      }
    }
  }
  await repo.updateUser(userId, patch);
}

/**
 * What a new learner studies with until it is changed in the settings; the step «Уровни» of the introduction says so,
 * and its finish stores it. The levels are the learner's own choice on that step, A1 to begin with.
 */
export const DEFAULTS = { newPerDay: 10, remindAt: "09:00", tzOffsetMin: 180 } as const;

/**
 * The introduction, `users.onboarding_step`: the language, two screens about the bot, the levels to study; NULL once
 * it is finished. Nothing else is asked: the rest is `DEFAULTS`.
 */
const STEPS = ["lang", "intro1", "intro2", "levels"] as const;
type Step = (typeof STEPS)[number];
/** The step a learner stands on. A stored step the introduction does not have is its first one, so nobody is left on a step that takes no answer. */
const stepOf = (user: Pick<User, "onboardingStep">): Step => STEPS.find((s) => s === user.onboardingStep) ?? "lang";

export type OnboardingScreen =
  | { kind: "lang" }
  | { kind: "intro"; n: 1 | 2 }
  /** The levels of the scale, to check and uncheck. */
  | { kind: "levels"; lines: LevelLine[] }
  /** The introduction is over: the first card comes next. */
  | { kind: "finished" }
  /**
   * The step does not take this answer; nothing was written. `why`: the answer was a level that cannot be flipped —
   * `last`, the only one checked; `soon`, one without cards.
   */
  | { kind: "invalid"; step: string; why?: "last" | "soon" }
  /** The answer came after the introduction was finished; nothing was written. */
  | { kind: "stale" };

/** The screen of the step the learner stands on (shown on /start, and in place of a screen the introduction no longer has). */
export async function startOnboarding(repo: Repo, user: User): Promise<OnboardingScreen> {
  switch (stepOf(user)) {
    case "intro1": return { kind: "intro", n: 1 };
    case "intro2": return { kind: "intro", n: 2 };
    case "levels": return { kind: "levels", lines: await levelLines(repo, user) };
    default: return { kind: "lang" };
  }
}

/**
 * Applies one answer and returns the next screen. The answers: `ru` / `tt` on the language step; `n1` on the first
 * screen and `n2` on the second — each screen has its own, so a second tap on «Дальше» of the first, which arrives
 * when the learner already stands on the second, does not pass the second; on «Уровни», `lv:<n>` flips the level n
 * and `go` finishes. Any other answer is invalid and keeps the step.
 */
export async function advanceOnboarding(repo: Repo, user: User, answer: string, now: number): Promise<OnboardingScreen> {
  if (user.onboardingStep == null) return { kind: "stale" };
  const invalid = { kind: "invalid", step: user.onboardingStep } as const;
  switch (stepOf(user)) {
    case "lang":
      if (answer !== "ru" && answer !== "tt") return invalid;
      await repo.updateUser(user.id, { lang: answer, onboardingStep: "intro1" });
      return { kind: "intro", n: 1 };
    case "intro1":
      if (answer !== "n1") return invalid;
      await repo.updateUser(user.id, { onboardingStep: "intro2" });
      return { kind: "intro", n: 2 };
    case "intro2":
      if (answer !== "n2") return invalid;
      await repo.updateUser(user.id, { onboardingStep: "levels" });
      return { kind: "levels", lines: await levelLines(repo, user) };
    case "levels": {
      const level = answer.match(/^lv:([1-5])$/);
      if (level) {
        // The same rules as in the settings: one statement that looks at the stored set and changes it.
        const res = await toggleLevel(repo, user, Number(level[1]));
        if (res !== "ok") return { ...invalid, why: res };
        // The statement gives no new set, and another tap may have changed it too: the row is read again.
        return { kind: "levels", lines: await levelLines(repo, (await repo.getUser(user.id))!) };
      }
      if (answer !== "go") return invalid;
      // Two «Начать» may arrive together, or one after the learner has studied: the write is guarded on the step, so only the first finishes.
      const finished = await repo.finishOnboarding(user.id, {
        ...DEFAULTS, onboardingStep: null, onboardingData: null, hintsSeen: HINT.update,
        nextDailyAt: nextOccurrence(DEFAULTS.tzOffsetMin, DEFAULTS.remindAt, now), nextEveningAt: nextOccurrence(DEFAULTS.tzOffsetMin, EVENING_AT, now),
      });
      return finished ? { kind: "finished" } : { kind: "stale" };
    }
  }
}

export type { DirectionSetting };
