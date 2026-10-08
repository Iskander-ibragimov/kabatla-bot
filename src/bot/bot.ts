import { Bot, type Context, GrammyError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { isAdmin, adminStatsText } from "../admin/service";
import { playVoice, sendVoice } from "../content/audio";
import { LlmClient } from "../content/llm";
import { ContentService, MAX_TYPED, typedTranslation } from "../content/service";
import type { Repo, User } from "../db/repo";
import { DAILY_LIMITS, remaining } from "../entitlements/service";
import type { Config } from "../env";
import { dict } from "../i18n";
import { ALL_POS, type NewMode } from "../levels/scale";
import { addAllPos, addLevel, hub, levelLines, setMode, setTopic, toggleLevel, togglePos, topicLines } from "../levels/service";
import { ReviewService, type Screen } from "../review/service";
import type { Rating } from "../srs/ladder";
import { cumulative } from "../stats/service";
import type { TgApi } from "../tg/client";
import { parse as parsePractice, press as pressPractice } from "../tutorial/practice";
import { REMIND_TIMES, TZ_OFFSETS, advanceOnboarding, getOrCreate, langFromTelegram, onLanguageStep, onPracticeStep, setSetting, startOnboarding } from "../users/service";
import {
  learnKeyboard, renderAbout, renderGenPreview, renderHub, renderLevelChecks, renderModes, renderOnboarding, renderPosChecks, renderPractice, renderSettings, renderStats,
  renderTimeZones, renderTopics,
} from "./screens";
import { type Keyboard, type Rendered, addReplyText, esc, hostOf, renderAddPreview, renderCard, renderDone, renderLead } from "./views";

export interface BotDeps {
  config: Config;
  repo: Repo;
  fetch: typeof fetch;
  waitUntil(p: Promise<unknown>): void;
  now(): number;
}

type Ctx = Context & { user: User };
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const isD1Limit = (e: unknown) => /daily row (read|write) limit|exceeded D1/i.test(String((e as Error)?.message ?? e));

export function createBot(deps: BotDeps, botInfo?: UserFromGetMe): Bot<Ctx> {
  const { repo, config } = deps;
  const bot = new Bot<Ctx>(config.botToken, botInfo ? { botInfo } : {});
  const tg: TgApi = { call: <T>(m: string, p: Record<string, unknown>) => (bot.api.raw as unknown as Record<string, (x: unknown) => Promise<T>>)[m]!(p) };
  const content = () => new ContentService(repo, { llm: new LlmClient(config.llmProviders, deps.fetch) }, deps.now());
  const reviews = () => new ReviewService(repo, deps.now());

  const markup = (keyboard: Keyboard) => (keyboard.length ? { inline_keyboard: keyboard } : undefined);
  const send = async (ctx: Ctx, r: Rendered) => ctx.api.sendMessage(ctx.user.chatId, r.text, { ...HTML, reply_markup: markup(r.keyboard) });
  /** Edits a message; if Telegram can’t edit it, sends a new one. Returns the message id shown. */
  const editOrSend = async (ctx: Ctx, messageId: number | undefined, r: Rendered): Promise<number> => {
    if (messageId) {
      try {
        await ctx.api.editMessageText(ctx.user.chatId, messageId, r.text, { ...HTML, reply_markup: markup(r.keyboard) });
        return messageId;
      } catch (e) {
        if (e instanceof GrammyError && /not modified/i.test(e.description)) return messageId;
        if (!(e instanceof GrammyError)) throw e;
      }
    }
    return (await send(ctx, r)).message_id;
  };
  const toast = async (ctx: Ctx, text?: string) => { if (ctx.callbackQuery) await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined); };
  const clickedId = (ctx: Ctx) => ctx.callbackQuery?.message?.message_id;
  /** Shows a screen in the message whose button was pressed, then answers the tap, with `note` when there is something to say. */
  const redraw = async (ctx: Ctx, r: Rendered, note?: string) => { await editOrSend(ctx, clickedId(ctx), r); await toast(ctx, note); };

  /**
   * Shows a review screen. "replace" (after a grade or undo) sends a NEW message and deletes the one that was clicked:
   * Telegram clients keep a spoiler revealed when a message is edited, so every card needs its own message.
   * The tap is answered once, after the card is out, with `note` when there is something to say.
   * With autoplay on, the voice of the card is the last call: it never delays the card (ruling T16a).
   * A hint the screen carries is its first lines: it is never a message of its own.
   */
  const show = async (ctx: Ctx, s: Screen, mode: "replace" | "send", note?: string) => {
    const t = dict(ctx.user.lang);
    if (s.kind === "stale") return toast(ctx, t.staleButton);
    if (s.kind === "noundo") { if (ctx.callbackQuery) return toast(ctx, t.nothingToUndo); await ctx.reply(t.nothingToUndo); return; }
    if (s.kind === "nothing") { await toast(ctx); await send(ctx, { text: t.nothingToLearn, keyboard: [[{ text: t.decksBtn, callback_data: "levels" }]] }); return; }
    const lead = s.lead ? renderLead(s.lead, ctx.user.lang) : "";
    const r = s.kind === "card" ? renderCard(s.view, s.counts, s.intervals, s.canUndo, ctx.user.lang, lead) : renderDone(s.summary, ctx.user.lang, s.empty, lead);
    const cardId = s.kind === "card" ? s.view.cardId : null;
    const chatId = ctx.user.chatId;
    const old = mode === "replace" ? clickedId(ctx) : undefined;
    if (old === undefined) {
      const m = await send(ctx, r);
      await repo.setSessionMessage(ctx.user.id, chatId, m.message_id, cardId);
    } else {
      const m = await ctx.api.sendMessage(chatId, r.text, { ...HTML, reply_markup: markup(r.keyboard), disable_notification: true });
      const oldVoice = await repo.replaceSessionMessage(ctx.user.id, chatId, m.message_id, cardId);
      await Promise.all([
        // Bots can't delete messages older than 48 h; then at least take the buttons off the old card.
        ctx.api.deleteMessage(chatId, old).catch(() => ctx.api.editMessageReplyMarkup(chatId, old).catch(() => undefined)),
        oldVoice ? ctx.api.deleteMessage(chatId, oldVoice).catch(() => undefined) : undefined,
      ]);
    }
    await toast(ctx, note);
    if (s.kind === "card" && ctx.user.autoplay && s.view.hasAudio) await playVoice(repo, tg, ctx.user, s.view.noteId);
  };

  const onError = async (err: { ctx: Ctx; error: unknown }) => {
    const ctx = err.ctx;
    const lang = ctx.user?.lang ?? langFromTelegram(ctx.from?.language_code);
    if (isD1Limit(err.error)) await ctx.reply(dict(lang).maintenance).catch(() => undefined);
    else console.error("handler error", err.error);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
  };
  bot.catch(onError);
  /** Webhooks bypass bot.catch, so every handler lives inside an error boundary (Telegram must always get 200). */
  const c = bot.errorBoundary(onError);

  c.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    const { user } = await getOrCreate(repo, ctx.from.id, ctx.chat.id, ctx.from.language_code, deps.now());
    ctx.user = user;
    await next();
  });

  /*
   * Before a language is chosen, whatever a learner sends is answered with the language screen as a new message: the
   * bot may have just met this learner, whose first move is a button of an old message, /learn or a word as often as
   * /start, and then there is no screen above to point at. Only /start and the two buttons of the screen go on to
   * their handlers.
   */
  c.use(async (ctx, next) => {
    const choice = ctx.callbackQuery?.data === "ob:ru" || ctx.callbackQuery?.data === "ob:tt";
    if (!onLanguageStep(ctx.user) || choice || ctx.hasCommand("start") || !(ctx.message || ctx.callbackQuery)) return next();
    await send(ctx, renderOnboarding({ kind: "lang" }, ctx.user.lang));
    await toast(ctx);
  });

  /*
   * The introduction: the language, the screen about the bot, the practice card and the levels to study follow one
   * another in one message; «Начать» takes the buttons off that message and sends the first card.
   */
  const answerOb = async (ctx: Ctx, answer: string) => {
    const t = dict(ctx.user.lang);
    const screen = await advanceOnboarding(repo, ctx.user, answer, deps.now());
    // Another update has just finished the introduction and sent the first card.
    if (screen.kind === "stale") return toast(ctx, t.staleButton);
    if (screen.kind === "invalid") {
      if (screen.why) return toast(ctx, screen.why === "last" ? t.needLevel : t.levelEmpty);
      // A button of a step already passed, or of the introduction that is gone («Знаю», an hour, a time zone): its message becomes the step the learner stands on.
      return redraw(ctx, renderOnboarding(await startOnboarding(repo, ctx.user), ctx.user.lang), t.chooseAbove);
    }
    if (screen.kind !== "finished") return redraw(ctx, renderOnboarding(screen, answer === "ru" || answer === "tt" ? answer : ctx.user.lang));
    const asked = clickedId(ctx);
    if (asked) await ctx.api.editMessageReplyMarkup(ctx.user.chatId, asked).catch(() => undefined);
    // The first card is a new message through the same path as /learn (it also answers the tap); the row is read again for what the finish stored.
    ctx.user = (await repo.getUser(ctx.user.id))!;
    await show(ctx, await reviews().nextScreen(ctx.user), "send");
  };

  c.command("start", async (ctx) => {
    const t = dict(ctx.user.lang);
    if (!ctx.user.onboardingStep) { await send(ctx, { text: t.alreadySetUp, keyboard: learnKeyboard(ctx.user.lang) }); return; }
    await send(ctx, renderOnboarding(await startOnboarding(repo, ctx.user), ctx.user.lang));
  });
  c.callbackQuery(/^ob:(.+)$/, async (ctx) => {
    // A button of the introduction pressed after it: there is nothing left to answer.
    if (!ctx.user.onboardingStep) return toast(ctx, dict(ctx.user.lang).staleButton);
    await answerOb(ctx, ctx.match[1]!);
  });

  /**
   * Commands other than /start, and «Учить» as a button, only work after the introduction. During it a command is
   * answered with a message and a button in its tap, so the button does not keep spinning.
   */
  const ready = async (ctx: Ctx) => {
    if (!ctx.user.onboardingStep) return true;
    const hint = dict(ctx.user.lang).chooseAbove;
    if (ctx.callbackQuery) await toast(ctx, hint);
    else await ctx.reply(hint);
    return false;
  };

  /*
   * The practice card: a card whose four grade buttons write nothing; each press redraws its message with what the
   * button does. It is a step of the introduction, and /howto («Как это работает») shows it again at any time. Which
   * of the two a press belongs to is decided by where the learner stands, not by the message: on the practice step
   * the card leads on to the levels; for a learner whose introduction is over it is a replay and ends with «Учить»,
   * also when the button is one of the introduction's old card. On another step of the introduction a practice button
   * is a button of a step already passed (or of a card not reached yet), and is answered as the introduction answers
   * those: its message becomes the step the learner stands on. A press reads the user's row and, but for that last
   * case on «Уровни», nothing else.
   */
  const practice = async (ctx: Ctx, mask: number, last: Rating | null) => {
    if (ctx.user.onboardingStep && !onPracticeStep(ctx.user)) {
      return redraw(ctx, renderOnboarding(await startOnboarding(repo, ctx.user), ctx.user.lang), dict(ctx.user.lang).chooseAbove);
    }
    await redraw(ctx, renderPractice(mask, last, ctx.user.lang, !ctx.user.onboardingStep));
  };
  c.command("howto", async (ctx) => { if (await ready(ctx)) await send(ctx, renderAbout(ctx.user.lang, true)); });
  c.callbackQuery("pr:start", async (ctx) => practice(ctx, 0, null));
  c.callbackQuery(/^pr:/, async (ctx) => {
    const pressed = parsePractice(ctx.callbackQuery.data);
    if (!pressed) return toast(ctx, dict(ctx.user.lang).staleButton);
    await practice(ctx, pressPractice(pressed.mask, pressed.rating), pressed.rating);
  });

  /* review */
  c.command("learn", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().nextScreen(ctx.user), "send"); });
  c.callbackQuery("learn", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().nextScreen(ctx.user), "send"); });
  c.callbackQuery(/^g:(\d+):(\d+):([1-4])$/, async (ctx) => {
    const [, id, reps, r] = ctx.match;
    await show(ctx, await reviews().grade(ctx.user, Number(id), Number(reps), Number(r) as Rating), "replace");
  });
  c.callbackQuery("u", async (ctx) => {
    const s = await reviews().undo(ctx.user);
    await show(ctx, s, "replace", s.kind === "card" ? dict(ctx.user.lang).undone : undefined);
  });
  c.command("undo", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().undo(ctx.user), "send"); });
  c.callbackQuery(/^r:(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const note = await repo.visibleNote(ctx.user.id, Number(ctx.match[1]));
    if (!note) return toast(ctx, t.staleButton);
    if (!(await repo.insertReport(ctx.user.id, note.id, deps.now()))) return toast(ctx, t.reportAlready);
    await toast(ctx, t.reportSent);
    const text = `⚑ <b>${esc(note.word)}</b> — ${esc(note.translation)}\n<i>${esc(note.exampleTt)}</i>\n${esc(note.exampleRu)}\n\nnote #${note.id} · user ${ctx.user.tgId}`;
    // The report is already stored; an unreachable admin must not turn into an error for the user.
    await ctx.api.sendMessage(config.adminTgId, text, HTML).catch((e) => console.error("report notification failed", e));
  });
  c.callbackQuery(/^v:(\d+)$/, async (ctx) => {
    // The same rule as for ⚑: the id comes from the button, so the note is read as this user may see it.
    const note = await repo.visibleNote(ctx.user.id, Number(ctx.match[1]));
    if (!note?.audioFileId) return toast(ctx, dict(ctx.user.lang).staleButton);
    await toast(ctx);
    await sendVoice(repo, tg, ctx.user, note.audioFileId);
  });

  /*
   * Levels: /levels is the hub, and its buttons open the checkboxes of the levels and of the parts of speech, the
   * orders of new words and the topics, each in the message of the hub; «Готово» is the hub again. The service
   * changes a setting in one statement and gives no new state, so the user's row is read again before a screen is drawn.
   */
  const hubScreen = async (ctx: Ctx) => renderHub(await hub(repo, ctx.user), ctx.user.lang);
  const reread = async (ctx: Ctx) => { ctx.user = (await repo.getUser(ctx.user.id))!; };
  const levelChecks = async (ctx: Ctx) => renderLevelChecks(await levelLines(repo, ctx.user), ctx.user.lang);
  const topics = async (ctx: Ctx) => renderTopics(await topicLines(repo, ctx.user), ctx.user.topicNo, ctx.user.lang);
  /** A button the learner has no use for any more: the tap says so, and its message becomes the hub. */
  const staleToHub = async (ctx: Ctx) => redraw(ctx, await hubScreen(ctx), dict(ctx.user.lang).staleButton);

  // During the introduction the buttons of the settings screens, every row of /settings among them, change nothing: the tap is answered with the hint.
  // The row «Показать обучение заново» (`tut` after `set:`) is not among them: no screen has it any more, and it is answered as any button the bot no longer has.
  c.callbackQuery(/^(levels$|hub|lv:|ps:|md:|tp:|tz:|fix:|set:(?!tut$))/, async (ctx, next) => {
    if (ctx.user.onboardingStep) return toast(ctx, dict(ctx.user.lang).chooseAbove);
    await next();
  });
  c.command("levels", async (ctx) => { if (await ready(ctx)) await send(ctx, await hubScreen(ctx)); });
  // From the done screen and from the settings the hub is a new message: the screen it was opened from stays.
  c.callbackQuery(["levels", "set:hub"], async (ctx) => { await toast(ctx); await send(ctx, await hubScreen(ctx)); });
  c.callbackQuery("hub", async (ctx) => redraw(ctx, await hubScreen(ctx)));
  // A button of the screen that listed skipped levels: there are no such levels any more.
  c.callbackQuery("lv:skip", staleToHub);

  c.callbackQuery("hub:lv", async (ctx) => redraw(ctx, await levelChecks(ctx)));
  c.callbackQuery(/^lv:t:([1-5])$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const res = await toggleLevel(repo, ctx.user, Number(ctx.match[1]));
    if (res !== "ok") return toast(ctx, res === "last" ? t.needLevel : t.levelEmpty);
    await reread(ctx);
    await redraw(ctx, await levelChecks(ctx));
  });

  c.callbackQuery("hub:pos", async (ctx) => redraw(ctx, renderPosChecks(ctx.user.posGroups, ctx.user.lang)));
  c.callbackQuery(/^ps:t:([0-7])$/, async (ctx) => {
    if ((await togglePos(repo, ctx.user, Number(ctx.match[1]))) !== "ok") return toast(ctx, dict(ctx.user.lang).needPos);
    await reread(ctx);
    await redraw(ctx, renderPosChecks(ctx.user.posGroups, ctx.user.lang));
  });

  c.callbackQuery("hub:mode", async (ctx) => redraw(ctx, renderModes(ctx.user.newMode, ctx.user.lang)));
  c.callbackQuery(/^md:(guided|topic|freq)$/, async (ctx) => {
    const mode = ctx.match[1] as NewMode;
    await setMode(repo, ctx.user, mode);
    ctx.user = { ...ctx.user, newMode: mode };
    // «Сам выбираю тему» gives no new word until a topic is chosen: the list of topics comes at once.
    await redraw(ctx, mode === "topic" && ctx.user.topicNo == null ? await topics(ctx) : renderModes(mode, ctx.user.lang));
  });

  // «Темы» is not offered in «По частоте», which takes no notice of a topic: a button left from another order shows the hub.
  c.callbackQuery(["hub:tp", "fix:topic"], async (ctx) => (ctx.user.newMode === "freq" ? staleToHub(ctx) : redraw(ctx, await topics(ctx))));
  c.callbackQuery(/^tp:(\d{1,2}|none)$/, async (ctx) => {
    if (ctx.user.newMode === "freq") return staleToHub(ctx);
    const res = await setTopic(repo, ctx.user, ctx.match[1] === "none" ? null : Number(ctx.match[1]));
    await reread(ctx);
    // A topic that has no card in the checked levels any more is not on the list: the list as it is now says so.
    await redraw(ctx, await topics(ctx), res === "ok" ? undefined : dict(ctx.user.lang).staleButton);
  });

  /*
   * The buttons of the done screen that mend the settings when they give no new word: the setting is changed and the
   * next card is shown in the same update. The user's row is not read again: the change is known.
   */
  c.callbackQuery(/^fix:lv:([1-5])$/, async (ctx) => {
    // The level is added and never taken away: a second tap on the button leaves it checked.
    ctx.user = { ...ctx.user, levels: await addLevel(repo, ctx.user, Number(ctx.match[1])) };
    await show(ctx, await reviews().nextScreen(ctx.user), "replace");
  });
  c.callbackQuery("fix:pos", async (ctx) => {
    await addAllPos(repo, ctx.user);
    ctx.user = { ...ctx.user, posGroups: ALL_POS };
    await show(ctx, await reviews().nextScreen(ctx.user), "replace");
  });

  /* AI decks */
  c.command("gen", async (ctx) => {
    if (!(await ready(ctx))) return;
    const t = dict(ctx.user.lang);
    const topic = String(ctx.match ?? "").trim().slice(0, 100);
    if (!topic) { await ctx.reply(t.genUsage, HTML); return; }
    const m = await ctx.reply(t.genWorking(esc(topic)), HTML);
    const user = ctx.user;
    deps.waitUntil((async () => {
      try {
        const res = await content().generateDeck(user, topic, 20);
        const r: Rendered = res.kind === "limit" ? { text: t.genLimit, keyboard: [] }
          : res.kind === "failed" ? { text: t.genFailed, keyboard: [] }
          : renderGenPreview(res.topic, res.items, await remaining((await repo.getUser(user.id))!, "gen", deps.now()), res.previewId, user.lang);
        await editOrSend(ctx, m.message_id, r);
      } catch (e) {
        await editOrSend(ctx, m.message_id, { text: isD1Limit(e) ? t.maintenance : t.genFailed, keyboard: [] }).catch(() => undefined);
      }
    })());
  });
  c.callbackQuery(/^gen:(ok|no):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const id = Number(ctx.match[2]);
    if (ctx.match[1] === "no") { await content().cancel(ctx.user, id); await editOrSend(ctx, clickedId(ctx), { text: t.genCancelled, keyboard: [] }); return toast(ctx); }
    try {
      const d = await content().confirmDeck(ctx.user, id);
      await editOrSend(ctx, clickedId(ctx), { text: t.genAdded(esc(d.title), d.count), keyboard: learnKeyboard(ctx.user.lang) });
    } catch { await editOrSend(ctx, clickedId(ctx), { text: t.previewExpired, keyboard: [] }); }
    await toast(ctx);
  });

  /* custom words */
  c.callbackQuery(/^add:skip:(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    // ✖️ under a request for a translation. A request the bot no longer waits on (answered, expired, replaced by a later one) is a stale button.
    if (!(await content().cancelManual(ctx.user, Number(ctx.match[1])))) return toast(ctx, t.staleButton);
    await editOrSend(ctx, clickedId(ctx), { text: t.notAdded, keyboard: [] });
    await toast(ctx);
  });
  c.callbackQuery(/^add:(ok|edit|no):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const id = Number(ctx.match[2]);
    const svc = content();
    if (ctx.match[1] === "no") { await svc.cancel(ctx.user, id); await editOrSend(ctx, clickedId(ctx), { text: t.notAdded, keyboard: [] }); return toast(ctx); }
    if (ctx.match[1] === "edit") {
      const items = await svc.startEdit(ctx.user, id);
      await toast(ctx);
      await ctx.reply(items ? t.editAsk(esc(items[0]!.word)) : t.previewExpired, HTML);
      return;
    }
    try {
      const r = await svc.confirmAdd(ctx.user, id);
      await editOrSend(ctx, clickedId(ctx), { text: t.added(r.words.map((w) => `<b>${esc(w)}</b>`).join(", ")), keyboard: learnKeyboard(ctx.user.lang) });
    } catch { await editOrSend(ctx, clickedId(ctx), { text: t.previewExpired, keyboard: [] }); }
    await toast(ctx);
  });

  /* settings, stats, help */
  c.command("settings", async (ctx) => { if (await ready(ctx)) await send(ctx, renderSettings(ctx.user)); });
  // Two rows are gone, and their buttons in old messages are buttons the bot no longer has: «Нагрузка» (`set:ret`) left with the
  // scheduler it tuned, «Показать обучение заново» (and the screens it opened) with /howto, which took its place.
  c.callbackQuery(/^set:(lang|new|rem|dir|auto)$/, async (ctx) => {
    const u = ctx.user;
    const cycle = <T>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!;
    switch (ctx.match[1]) {
      case "lang": await setSetting(repo, u.id, "lang", u.lang === "ru" ? "tt" : "ru", deps.now()); break;
      case "new": await setSetting(repo, u.id, "newPerDay", cycle([5, 10, 20] as const, u.newPerDay as 5), deps.now()); break;
      case "rem": await setSetting(repo, u.id, "remindAt", cycle(REMIND_TIMES, u.remindAt as (typeof REMIND_TIMES)[number]), deps.now()); break;
      case "dir": await setSetting(repo, u.id, "direction", cycle(["tt_ru", "ru_tt", "both"] as const, u.direction), deps.now()); break;
      case "auto": await setSetting(repo, u.id, "autoplay", !u.autoplay, deps.now()); break;
    }
    const updated = (await repo.getUser(u.id))!;
    ctx.user = updated;
    await editOrSend(ctx, clickedId(ctx), renderSettings(updated));
    await toast(ctx);
  });
  c.callbackQuery("set:tz", async (ctx) => redraw(ctx, renderTimeZones(deps.now(), ctx.user.tzOffsetMin, ctx.user.lang)));
  c.callbackQuery("set:back", async (ctx) => redraw(ctx, renderSettings(ctx.user)));
  c.callbackQuery(/^tz:(\d+)$/, async (ctx) => {
    const offset = Number(ctx.match[1]);
    if (!TZ_OFFSETS.includes(offset)) return toast(ctx, dict(ctx.user.lang).staleButton);
    await setSetting(repo, ctx.user.id, "tzOffsetMin", offset, deps.now());
    await reread(ctx);
    await redraw(ctx, renderSettings(ctx.user));
  });
  c.command("stats", async (ctx) => { if (await ready(ctx)) await ctx.reply(renderStats(await cumulative(repo, ctx.user, deps.now()), ctx.user.lang), HTML); });
  c.command("help", async (ctx) => { await ctx.reply(dict(ctx.user.lang).help, HTML); });
  c.callbackQuery("help:add", async (ctx) => { await toast(ctx); await ctx.reply(dict(ctx.user.lang).helpAdd, HTML); });

  /* admin */
  c.command("admin", async (ctx) => {
    if (!isAdmin(ctx.user, config)) return;
    await ctx.reply(await adminStatsText(repo, deps.now()), HTML);
  });

  /* free text: manual translations, custom words */
  c.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const t = dict(ctx.user.lang);
    if (text.startsWith("/")) { await ctx.reply(t.unknownCommand); return; }
    // No step of the introduction takes a typed answer.
    if (ctx.user.onboardingStep) { await ctx.reply(t.chooseAbove); return; }
    const svc = content();
    const pending = svc.pendingKind(ctx.user);
    if (pending === "manual") {
      // The text is a translation typed by hand. One that is too long is not stored; the bot keeps waiting for a shorter one.
      if (typedTranslation(text) === null) { await ctx.reply(t.tooLong(MAX_TYPED.translation)); return; }
      const word = await svc.completeManual(ctx.user, text);
      if (word) { await send(ctx, { text: t.added(`<b>${esc(word)}</b>`), keyboard: learnKeyboard(ctx.user.lang) }); return; }
    }
    if (pending === "preview") {
      const r = await svc.editPreviewTranslation(ctx.user, text);
      if (r.kind === "too-long") { await ctx.reply(t.tooLong(MAX_TYPED.translation)); return; }
      if (r.kind === "edited") { await send(ctx, renderAddPreview(r.items, r.previewId, ctx.user.lang)); return; }
      // The preview that was being edited is gone and the state is dropped: the text is a message with words like any other.
      ctx.user = { ...ctx.user, pendingEdit: null };
    }
    // Over the daily limit of messages with words: one answer, and nothing is looked up. `prepareAdd` counts the message.
    if ((await remaining(ctx.user, "add", deps.now())) === 0) { await ctx.reply(t.addLimit(DAILY_LIMITS.add)); return; }
    const m = await ctx.reply(t.searching);
    const user = ctx.user;
    const entities = (ctx.message.entities ?? []).map((e) => ({ type: e.type, offset: e.offset, length: e.length, url: "url" in e ? (e as { url?: string }).url : undefined }));
    deps.waitUntil((async () => {
      try {
        const res = await svc.prepareAdd(user, text, entities);
        let r: Rendered;
        if (res.kind === "ask-words") r = { text: t.askWords(esc(hostOf(res.url))), keyboard: [] };
        else if (res.kind === "empty") r = { text: t.helpAdd, keyboard: [] };
        else if (res.kind === "too-long") r = { text: t.tooLong(res.max), keyboard: [] };
        else if (res.kind === "limit") r = { text: t.addLimit(res.max), keyboard: [] };
        else {
          const keyboard = res.kind === "preview" ? renderAddPreview(res.items, res.previewId, user.lang).keyboard
            : res.kind === "duplicates-only" ? learnKeyboard(user.lang)
            : [[{ text: t.cancel, callback_data: `add:skip:${res.at}` }]]; // the request for a translation by hand can be dismissed
          r = { text: addReplyText(res, user.lang), keyboard };
        }
        await editOrSend(ctx, m.message_id, r);
      } catch (e) {
        console.error("add words failed", e);
        await editOrSend(ctx, m.message_id, { text: isD1Limit(e) ? t.maintenance : t.genFailed, keyboard: [] }).catch(() => undefined);
      }
    })());
  });

  // A button of a screen the bot no longer has: the tap is answered, so the button does not keep spinning.
  c.on("callback_query:data", (ctx) => toast(ctx, dict(ctx.user.lang).staleButton));

  return bot;
}
