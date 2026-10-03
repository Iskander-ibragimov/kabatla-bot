/** Telegram's limit for the text of one message, counted after the HTML is parsed. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** The length Telegram counts: the text without its tags, every entity as the one character it stands for. */
export const visibleLength = (html: string): number => html.replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot);/g, "x").length;
