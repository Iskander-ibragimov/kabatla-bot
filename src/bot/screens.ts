import type { User } from "../db/repo";
import { dict } from "../i18n";
import { levelCode } from "../levels/scale";
import { type Hub, coverageOf } from "../levels/service";
import type { Lang } from "../srs/fsrs";
import type { Cumulative } from "../stats/service";
import type { OnboardingScreen } from "../users/service";
import { REMIND_TIMES } from "../users/service";
import type { Button, Keyboard, PreviewItem, Rendered } from "./views";
import { esc, fitMessage, previewLines } from "./views";

const btn = (text: string, data: string, style?: Button["style"]): Button => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const tzLabel = (min: number) => `UTC${min >= 0 ? "+" : "−"}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? ":" + String(Math.abs(min) % 60).padStart(2, "0") : ""}`;

export function renderOnboarding(s: OnboardingScreen, lang: Lang): Rendered {
  const t = dict(lang);
  switch (s.kind) {
    case "lang":
      return { text: t.welcome, keyboard: [[btn("Русский", "ob:ru"), btn("Татарча", "ob:tt")]] };
    case "placement":
      return { text: t.placementQ(s.index + 1, esc(s.word)), keyboard: [[btn(t.knowBtn, "ob:1", "success"), btn(t.dontKnowBtn, "ob:0")]] };
    case "goal":
      return { text: t.goalQ(s.level), keyboard: [[btn(t.goalBtn(5), "ob:5"), btn(t.goalBtn(10), "ob:10", "primary"), btn(t.goalBtn(20), "ob:20")]] };
    case "remind":
      return { text: t.remindQ, keyboard: [REMIND_TIMES.slice(0, 3).map((x) => btn(x, `ob:${x}`)), REMIND_TIMES.slice(3).map((x) => btn(x, `ob:${x}`))] };
    case "tz":
      return { text: t.tzQ, keyboard: [s.options.slice(0, 3).map((o) => btn(o.label, `ob:${o.offset}`)), s.options.slice(3).map((o) => btn(o.label, `ob:${o.offset}`))] };
    case "finished":
      return { text: `${t.finished(s.remindAt, tzLabel(s.tzOffsetMin))}\n\n${t.easyHint}`, keyboard: [] };
    default:
      return { text: t.chooseAbove, keyboard: [] };
  }
}

/**
 * A stand-in until the levels screen proper is built: the numbers of the hub in the texts the bot has. A line for
 * every checked level that has cards, with the words started of it; the own decks; the coverage of the levels started whole.
 */
export function renderLevels(h: Hub, lang: Lang): Rendered {
  const t = dict(lang);
  const lines = [t.levelsTitle];
  for (const l of h.levels) if (l.checked && l.total > 0) lines.push(t.levelProgress(l.no, l.started, l.total));
  // The title of an AI deck already starts with 🤖.
  for (const d of h.own) lines.push(`${d.kind === "custom" ? "📝 " : ""}${esc(lang === "ru" ? d.titleRu : d.titleTt)} · ${d.total}`);
  const coverage = coverageOf(h.levels);
  if (coverage != null) lines.push(t.levelsCoverage(coverage));
  return { text: lines.join("\n"), keyboard: [] };
}

export function renderSettings(u: User): Rendered {
  const t = dict(u.lang);
  return {
    text: t.settingsTitle,
    keyboard: [
      [btn(t.setLang, "set:lang")], [btn(t.setMode(u.retention), "set:ret")], [btn(t.setNew(u.newPerDay), "set:new")],
      [btn(t.setRemind(u.remindAt), "set:rem")], [btn(t.setDir(u.direction), "set:dir")], [btn(t.setAuto(u.autoplay), "set:auto")],
    ],
  };
}

export function renderStats(s: Cumulative, lang: Lang): string {
  const t = dict(lang);
  return t.statsText({
    levels: s.levels.map(levelCode).join(", "), coverage: s.coveragePct, streak: s.streak, learned: s.learned, known: s.known, learning: s.learning, fresh: s.fresh, memory: s.memory, total: s.total, r30: s.r30,
    retention: s.retention30 == null ? "—" : `${Math.round(s.retention30 * 100)}%`, forecast: s.forecast7.join(" · "),
  });
}

/** The preview of an AI deck. Its translations are the model's, so it ends with the AI note. */
export function renderGenPreview(topic: string, items: PreviewItem[], left: number, previewId: number, lang: Lang): Rendered {
  const t = dict(lang);
  const text = fitMessage((fit) => {
    const lines = [t.genTitle(esc(topic), items.length), "", ...previewLines(items, lang, fit), "", t.genLeft(left)];
    if (items.some((i) => i.ai)) lines.push(t.aiNote);
    return lines.join("\n");
  });
  return { text, keyboard: [[btn(t.addDeckGenBtn, `gen:ok:${previewId}`, "primary"), btn(t.cancel, `gen:no:${previewId}`)]] };
}

export const learnKeyboard = (lang: Lang): Keyboard => [[btn(dict(lang).learnBtn, "learn", "primary")]];
