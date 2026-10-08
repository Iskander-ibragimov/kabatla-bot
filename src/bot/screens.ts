import type { User } from "../db/repo";
import { type Dict, dict } from "../i18n";
import { ALL_POS, NEW_MODES, type NewMode, POS_GROUPS, levelCode } from "../levels/scale";
import type { Hub, LevelLine, TopicLine } from "../levels/service";
import { formatInterval } from "../srs/interval";
import { type Lang, RUNGS, type Rating } from "../srs/ladder";
import type { Cumulative } from "../stats/service";
import { ALL, PRACTICE_WORD, newWordIntervals, press, tried } from "../tutorial/practice";
import type { OnboardingScreen } from "../users/service";
import { TZ_OFFSETS } from "../users/service";
import type { Button, Keyboard, PreviewItem, Rendered } from "./views";
import { esc, fitMessage, gradeRows, previewLines } from "./views";

const btn = (text: string, data: string, style?: Button["style"]): Button => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const checkbox = (on: boolean) => (on ? "☑" : "☐");
const tzLabel = (min: number) => `UTC${min >= 0 ? "+" : "−"}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? ":" + String(Math.abs(min) % 60).padStart(2, "0") : ""}`;

/**
 * The screen about the bot; «Попробовать» goes on to the practice card. In the introduction that is an answer of the
 * step (`ob:n1`); shown again by /howto (`replay`) it only opens the card (`pr:start`).
 */
export function renderAbout(lang: Lang, replay: boolean): Rendered {
  const t = dict(lang);
  return { text: t.intro1, keyboard: [[btn(t.tryBtn, replay ? "pr:start" : "ob:n1")]] };
}

/** After «Хорошо» a new word stands on rung 2; the sentence about that button names the three rungs above it. */
const RUNGS_AFTER_GOOD = RUNGS.slice(2, 5);

/**
 * The practice card: a card with one word whose grade buttons change nothing, so the learner may press all four and
 * read what each does. `mask`: the buttons tried (tutorial/practice.ts); `last`: the one just pressed, whose
 * explanation stands above the word, or null on a card that follows no press. The buttons are those of a real card
 * with a new word, and each carries the buttons tried, so the next press needs nothing stored. Once all four are
 * tried the card is the final screen: the explanation of the fourth button, then the words that end the practice.
 * The last row leaves the practice: in the introduction it answers the step (`ob:n2`: «Пропустить», after the four
 * buttons «Дальше»); in a replay it is «Учить».
 */
export function renderPractice(mask: number, last: Rating | null, lang: Lang, replay: boolean): Rendered {
  const t = dict(lang);
  const ms = newWordIntervals();
  const words = (interval: number, form: "plain" | "after" = "plain") => formatInterval(interval, lang, form);
  // In the message an interval is escaped like any text that is not the bot's own. The Russian sentences have it
  // after «через», all but that of «Трудно», where it follows «это».
  const explained = last && {
    1: () => t.practiceAgain(esc(words(ms[1], "after"))),
    2: () => t.practiceHard(esc(words(ms[2]))),
    3: () => t.practiceGood(esc(words(ms[3], "after")), esc(RUNGS_AFTER_GOOD.map((rung) => words(rung, "after")).join(", "))),
    4: () => t.practiceEasy(esc(words(ms[4], "after"))),
  }[last]();
  const leave = replay ? learnKeyboard(lang) : [[btn(mask === ALL ? t.nextBtn : t.skipBtn, "ob:n2")]];
  if (mask === ALL) return { text: [...(explained ? [explained, ""] : []), t.practiceDone].join("\n"), keyboard: leave };

  const n = tried(mask);
  const lines = [t.practiceTitle(n), t.practiceNote, ""];
  if (explained) lines.push(explained, t.practiceLeft(4 - n), "");
  lines.push(
    // The word and its hidden translation, as a real card shows them.
    `<b>${esc(PRACTICE_WORD.word)}</b>`, `<tg-spoiler><b>${esc(PRACTICE_WORD.translation)}</b></tg-spoiler>`, "",
    t.practiceTask, "",
    t.practiceLadder(esc(RUNGS.map((rung) => words(rung)).join(" → "))),
  );
  const grades = gradeRows({ 1: words(ms[1]), 2: words(ms[2]), 3: words(ms[3]), 4: words(ms[4]) }, (r) => `pr:${mask}:${r}`, lang, (r) => (press(mask, r) === mask ? "✅ " : ""));
  return { text: lines.join("\n"), keyboard: [...grades, ...leave] };
}

/** A level on its button of the step «Уровни»: «☑ A1 · 400 слов · ≈45 % текста», or «☐ A2 · скоро» for a level without cards. */
function levelChoice(l: LevelLine, t: Dict): string {
  const head = `${checkbox(l.checked)} ${l.code}`;
  if (l.total === 0) return `${head} · ${t.levelSoon}`;
  return `${head} · ${t.levelWords(l.total)}${l.coveragePct == null ? "" : ` · ${t.levelCoverage(l.coveragePct)}`}`;
}

/** The screen of a step of the introduction. A screen that is no step (the finish, a refused answer) has nothing to show. */
export function renderOnboarding(s: OnboardingScreen, lang: Lang): Rendered {
  const t = dict(lang);
  switch (s.kind) {
    case "lang":
      return { text: t.welcome, keyboard: [[btn("Русский", "ob:ru"), btn("Татарча", "ob:tt")]] };
    case "intro":
      return renderAbout(lang, false);
    case "practice":
      return renderPractice(0, null, lang, false);
    case "levels":
      return { text: t.obLevels, keyboard: [...s.lines.map((l) => [btn(levelChoice(l, t), `ob:lv:${l.no}`)]), [btn(t.obGoBtn, "ob:go", "primary")]] };
    default:
      return { text: t.chooseAbove, keyboard: [] };
  }
}

/** A button of a list where one option is in use: that one carries the mark. */
const option = (on: boolean, text: string, data: string) => btn(on ? `✅ ${text}` : text, data);
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The buttons in rows of `n`. */
const inRows = (buttons: Button[], n: number): Keyboard => Array.from({ length: Math.ceil(buttons.length / n) }, (_, i) => buttons.slice(i * n, i * n + n));
const topicTitle = (topic: TopicLine, lang: Lang) => (lang === "ru" ? topic.titleRu : topic.titleTt);

/**
 * A level with its checkbox: «☑ A1 · 137 из 400», or «☐ A2 · скоро» for a level without cards. `whole` adds what the
 * hub says besides: «(будет 500)» while the level holds fewer cards than its size, and the coverage when the level has one.
 */
function levelLine(l: LevelLine, t: Dict, whole: boolean): string {
  const head = `${checkbox(l.checked)} ${l.code}`;
  if (l.total === 0) return `${head} · ${t.levelSoon}`;
  // A counter above the cards of its level is the level started whole.
  let line = `${head} · ${t.outOf(Math.min(l.started, l.total), l.total)}`;
  if (whole && l.total < l.size) line += ` ${t.levelWillBe(l.size)}`;
  if (whole && l.coveragePct != null) line += ` · ${t.levelCoverage(l.coveragePct)}`;
  return line;
}

/**
 * /levels: the five levels, the order of new words with the topic they come from, the parts of speech when not all
 * are checked, the own decks; a button for each list and «Учить». «Темы» is not offered in «По частоте», which takes
 * no notice of a topic.
 */
export function renderHub(h: Hub, lang: Lang): Rendered {
  const t = dict(lang);
  const lines = [t.levelsTitle, ...h.levels.map((l) => levelLine(l, t, true)), ""];
  const topic = h.topic ? `«${esc(topicTitle(h.topic, lang))}»: ${t.outOf(h.topic.started, h.topic.total)}` : null;
  // After the name of the order, the topic the new words come from: none in «По частоте», none to name when the guided order has no word left.
  const from = h.mode === "freq" ? null : h.mode === "topic" ? topic ?? t.hubNoTopic : topic && t.hubTopicNow(topic);
  lines.push(`🧭 ${t.modeName(h.mode)}${from ? ` · ${from}` : ""}`);
  if ((h.posGroups & ALL_POS) !== ALL_POS) lines.push(t.hubPos(POS_GROUPS.filter((g) => h.posGroups & (1 << g.bit)).map((g) => t.posGroupName(g.key)).join(", ")));
  // The title of an AI deck already starts with 🤖.
  for (const d of h.own) lines.push(`${d.kind === "custom" ? "📝 " : ""}${esc(lang === "ru" ? d.titleRu : d.titleTt)} · ${d.total}`);
  const second = [btn(t.hubModeBtn, "hub:mode")];
  if (h.mode !== "freq") second.push(btn(t.hubTopicsBtn, "hub:tp"));
  // The last row goes on to the cards: the hub is also where the done screen sends a learner to mend the settings.
  return { text: lines.join("\n"), keyboard: [[btn(t.hubLevelsBtn, "hub:lv"), btn(t.hubPosBtn, "hub:pos")], second, ...learnKeyboard(lang)] };
}

/** «Уровни»: a checkbox for every level of the scale; a tap flips it. */
export function renderLevelChecks(lines: LevelLine[], lang: Lang): Rendered {
  const t = dict(lang);
  return { text: `${t.levelsTitle}\n${t.levelChecksHint}`, keyboard: [...lines.map((l) => [btn(levelLine(l, t, false), `lv:t:${l.no}`)]), [btn(t.doneBtn, "hub")]] };
}

/** «Части речи»: a checkbox for every group of the mask `mask`; a tap flips it. */
export function renderPosChecks(mask: number, lang: Lang): Rendered {
  const t = dict(lang);
  const boxes = POS_GROUPS.map((g) => btn(`${checkbox((mask & (1 << g.bit)) !== 0)} ${capitalized(t.posGroupName(g.key))}`, `ps:t:${g.bit}`));
  return { text: `${t.posTitle}\n${t.posChecksHint}`, keyboard: [...inRows(boxes, 2), [btn(t.doneBtn, "hub")]] };
}

/** «Порядок слов»: what each of the three orders does, and a button for each; the one in use is marked. */
export function renderModes(mode: NewMode, lang: Lang): Rendered {
  const t = dict(lang);
  return {
    text: [t.modesTitle, ...NEW_MODES.map((m) => `<b>${t.modeName(m)}</b> — ${t.modeAbout(m)}`)].join("\n\n"),
    keyboard: [...NEW_MODES.map((m) => [option(m === mode, t.modeName(m), `md:${m}`)]), [btn(t.doneBtn, "hub")]],
  };
}

/**
 * «Темы»: a button for every topic of `lines` with the words started of those it has; the chosen one is marked, and
 * «Не выбирать» is while there is none. The text of a button is not HTML, so a title stands in it as it is.
 */
export function renderTopics(lines: TopicLine[], chosen: number | null, lang: Lang): Rendered {
  const t = dict(lang);
  return {
    text: t.topicsText,
    keyboard: [
      ...lines.map((l) => [option(l.no === chosen, `${topicTitle(l, lang)} · ${t.outOf(l.started, l.total)}`, `tp:${l.no}`)]),
      [option(chosen == null, t.noTopicBtn, "tp:none"), btn(t.doneBtn, "hub")],
    ],
  };
}

/** «Часовой пояс»: the zones UTC+2 … UTC+12, each with the time it is there at `now`; the zone `current` is marked. */
export function renderTimeZones(now: number, current: number, lang: Lang): Rendered {
  const t = dict(lang);
  const zones = TZ_OFFSETS.map((offset) => option(offset === current, `${new Date(now + offset * 60_000).toISOString().slice(11, 16)} · ${tzLabel(offset)}`, `tz:${offset}`));
  return { text: t.tzText, keyboard: [...inRows(zones, 2), [btn(t.doneBtn, "set:back")]] };
}

export function renderSettings(u: User): Rendered {
  const t = dict(u.lang);
  return {
    text: t.settingsTitle,
    keyboard: [
      [btn(t.setLang, "set:lang")], [btn(t.setNew(u.newPerDay), "set:new")],
      [btn(t.setRemind(u.remindAt), "set:rem")], [btn(t.setTz(tzLabel(u.tzOffsetMin)), "set:tz")], [btn(t.setDir(u.direction), "set:dir")],
      [btn(t.setAuto(u.autoplay), "set:auto")], [btn(t.setHub, "set:hub")],
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
