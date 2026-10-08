import type { Dict } from "../../src/i18n/ru";

/**
 * The commands of the bot's menu, in menu order; the texts live in the interface dictionaries. Kept apart from
 * scripts/set-webhook.ts, which talks to Telegram as soon as it is loaded, so that a test can read the list.
 */
export const commands = (t: Dict): { command: string; description: string }[] =>
  ([["start", t.cmdStart], ["learn", t.cmdLearn], ["levels", t.cmdLevels], ["howto", t.cmdHowto], ["gen", t.cmdGen], ["stats", t.cmdStats], ["settings", t.cmdSettings], ["undo", t.cmdUndo], ["help", t.cmdHelp]] as const)
    .map(([command, description]) => ({ command, description }));
