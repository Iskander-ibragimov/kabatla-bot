import { Bot, type Context, GrammyError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { isAdmin, adminStatsText } from "../admin/service";
import { playVoice } from "../content/audio";
import { LlmClient } from "../content/llm";
import { ContentService, MAX_TYPED, typedTranslation } from "../content/service";
import type { Repo, User } from "../db/repo";
import { remaining } from "../entitlements/service";
import type { Config } from "../env";
import { dict } from "../i18n";
import { ReviewService, type Screen } from "../review/service";
import type { Rating } from "../srs/fsrs";
import { cumulative, levelsView } from "../stats/service";
import type { TgApi } from "../tg/client";
import { REMIND_TIMES, RETENTIONS, advanceOnboarding, getOrCreate, langFromTelegram, setSetting, startOnboarding } from "../users/service";
import { learnKeyboard, renderGenPreview, renderLevels, renderOnboarding, renderSettings, renderStats } from "./screens";
import { type Keyboard, type Rendered, addReplyText, esc, hostOf, renderAddPreview, renderCard, renderDone, renderLevelUp } from "./views";

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

  /**
   * Shows a review screen. "replace" (after a grade or undo) sends a NEW message and deletes the one that was clicked:
   * Telegram clients keep a spoiler revealed when a message is edited, so every card needs its own message.
   * The tap is answered once, after the card is out, with `note` when there is something to say.
   * With autoplay on, the voice of the card is the last call: it never delays the card (ruling T16a).
   */
  const show = async (ctx: Ctx, s: Screen, mode: "replace" | "send", note?: string) => {
    const t = dict(ctx.user.lang);
    if (s.kind === "stale") return toast(ctx, t.staleButton);
    if (s.kind === "noundo") { if (ctx.callbackQuery) return toast(ctx, t.nothingToUndo); await ctx.reply(t.nothingToUndo); return; }
    if (s.kind === "nothing") { await toast(ctx); await send(ctx, { text: t.nothingToLearn, keyboard: [[{ text: t.decksBtn, callback_data: "levels" }]] }); return; }
    // The news about a level opens the same message: a separate one would not fit the Telegram budget of an update.
    // A card takes it as its lead, so that the two together are fitted into one message.
    const lead = s.levelUp ? renderLevelUp(s.levelUp, ctx.user.lang) : "";
    const r = s.kind === "card"
      ? renderCard(s.view, s.counts, s.intervals, s.canUndo, ctx.user.lang, lead)
      : renderDone(s.summary, ctx.user.lang);
    if (lead && s.kind === "done") r.text = `${lead}\n\n${r.text}`;
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

  /* onboarding */
  const answerOb = async (ctx: Ctx, answer: string, messageId?: number) => {
    const screen = await advanceOnboarding(repo, ctx.user, answer, deps.now());
    if (screen.kind === "invalid") { if (ctx.callbackQuery) return toast(ctx, dict(ctx.user.lang).chooseAbove); await ctx.reply(dict(ctx.user.lang).chooseAbove); return; }
    // Another update has just finished onboarding and sent the first card: a second tap is a stale button, a second typed time gets no answer.
    if (screen.kind === "stale") return toast(ctx, dict(ctx.user.lang).staleButton);
    const lang = screen.kind === "placement" && screen.index === 0 && (answer === "ru" || answer === "tt") ? answer : ctx.user.lang;
    await editOrSend(ctx, messageId, renderOnboarding(screen, lang));
    if (screen.kind !== "finished") return toast(ctx);
    // The first card is a new message through the same path as /learn (it also answers the callback);
    // the user row is re-read for the new time zone and level.
    ctx.user = (await repo.getUser(ctx.user.id))!;
    await show(ctx, await reviews().nextScreen(ctx.user), "send");
  };

  c.command("start", async (ctx) => {
    const t = dict(ctx.user.lang);
    if (!ctx.user.onboardingStep) { await send(ctx, { text: t.alreadySetUp, keyboard: learnKeyboard(ctx.user.lang) }); return; }
    await send(ctx, renderOnboarding(startOnboarding(ctx.user, deps.now()), ctx.user.lang));
  });
  c.callbackQuery(/^ob:(.+)$/, async (ctx) => {
    if (!ctx.user.onboardingStep) return toast(ctx);
    await answerOb(ctx, ctx.match[1]!, clickedId(ctx));
  });

  /** Commands other than /start only work after onboarding. */
  const ready = async (ctx: Ctx) => {
    if (!ctx.user.onboardingStep) return true;
    await ctx.reply(dict(ctx.user.lang).chooseAbove);
    return false;
  };

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
  c.callbackQuery(/^v:(\d+)$/, async (ctx) => { await toast(ctx); await playVoice(repo, tg, ctx.user, Number(ctx.match[1])); });

  /* levels */
  const levels = async (ctx: Ctx) => renderLevels(await levelsView(repo, ctx.user), ctx.user.lang);
  c.command("levels", async (ctx) => { if (await ready(ctx)) await send(ctx, await levels(ctx)); });
  c.callbackQuery("levels", async (ctx) => { await toast(ctx); await send(ctx, await levels(ctx)); });
  c.callbackQuery("lv:skip", async (ctx) => {
    if (ctx.user.onboardingStep) return toast(ctx);
    await repo.openSkippedLevels(ctx.user.id, deps.now());
    await editOrSend(ctx, clickedId(ctx), await levels(ctx));
    await toast(ctx);
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
  c.callbackQuery(/^add:(ok|edit|no):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const id = Number(ctx.match[2]);
    const svc = content();
    if (ctx.match[1] === "no") { await svc.cancel(ctx.user, id); await editOrSend(ctx, clickedId(ctx), { text: t.notAdded, keyboard: [] }); return toast(ctx); }
    if (ctx.match[1] === "edit") {
      const items = await svc.startEdit(ctx.user, id);
      await toast(ctx);
      await ctx.reply(items ? t.editAsk(esc(items[0]!.word)) : t.previewExpired);
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
  c.callbackQuery(/^set:(lang|ret|new|rem|dir|auto)$/, async (ctx) => {
    const u = ctx.user;
    const cycle = <T>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!;
    switch (ctx.match[1]) {
      case "lang": await setSetting(repo, u.id, "lang", u.lang === "ru" ? "tt" : "ru", deps.now()); break;
      case "ret": await setSetting(repo, u.id, "retention", cycle(RETENTIONS, u.retention as (typeof RETENTIONS)[number]), deps.now()); break;
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
  c.command("stats", async (ctx) => { if (await ready(ctx)) await ctx.reply(renderStats(await cumulative(repo, ctx.user, deps.now()), ctx.user.lang), HTML); });
  c.command("help", async (ctx) => { await ctx.reply(dict(ctx.user.lang).help, HTML); });
  c.callbackQuery("help:add", async (ctx) => { await toast(ctx); await ctx.reply(dict(ctx.user.lang).helpAdd, HTML); });

  /* admin */
  c.command("admin", async (ctx) => {
    if (!isAdmin(ctx.user, config)) return;
    await ctx.reply(await adminStatsText(repo, deps.now()), HTML);
  });

  /* free text: onboarding answers, manual translations, custom words */
  c.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const t = dict(ctx.user.lang);
    if (text.startsWith("/")) { await ctx.reply(t.unknownCommand); return; }
    if (ctx.user.onboardingStep) {
      if (ctx.user.onboardingStep === "tz") return answerOb(ctx, text);
      await ctx.reply(t.chooseAbove);
      return;
    }
    const svc = content();
    const pending = svc.pendingKind(ctx.user);
    // The text is a translation typed by hand. One that is too long is not stored; the bot keeps waiting for a shorter one.
    if (pending && typedTranslation(text) === null) { await ctx.reply(t.tooLong(MAX_TYPED.translation)); return; }
    if (pending === "manual") {
      const word = await svc.completeManual(ctx.user, text);
      if (word) { await send(ctx, { text: t.added(`<b>${esc(word)}</b>`), keyboard: learnKeyboard(ctx.user.lang) }); return; }
    }
    if (pending === "preview") {
      try {
        const r = await svc.editPreviewTranslation(ctx.user, text);
        await send(ctx, renderAddPreview(r.items, r.previewId, ctx.user.lang));
      } catch { await ctx.reply(t.previewExpired); }
      return;
    }
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
        else {
          const keyboard = res.kind === "preview" ? renderAddPreview(res.items, res.previewId, user.lang).keyboard : res.kind === "duplicates-only" ? learnKeyboard(user.lang) : [];
          r = { text: addReplyText(res, user.lang), keyboard };
        }
        await editOrSend(ctx, m.message_id, r);
      } catch (e) {
        console.error("add words failed", e);
        await editOrSend(ctx, m.message_id, { text: isD1Limit(e) ? t.maintenance : t.genFailed, keyboard: [] }).catch(() => undefined);
      }
    })());
  });

  return bot;
}
