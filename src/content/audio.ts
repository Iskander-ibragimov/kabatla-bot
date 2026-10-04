import type { Repo, User } from "../db/repo";
import type { TgApi, TgMessage } from "../tg/client";

/** Sends a voice by its Telegram file id and removes the previous voice message, so the chat stays clean. */
export async function sendVoice(repo: Repo, tg: TgApi, user: User, fileId: string): Promise<void> {
  const session = await repo.getSession(user.id);
  if (session?.lastVoiceMessageId) {
    await tg.call("deleteMessage", { chat_id: user.chatId, message_id: session.lastVoiceMessageId }).catch(() => undefined);
  }
  const msg = await tg.call<TgMessage>("sendVoice", { chat_id: user.chatId, voice: fileId, disable_notification: true });
  await repo.saveSession({
    userId: user.id, chatId: user.chatId, messageId: session?.messageId ?? null, cardId: session?.cardId ?? null,
    stale: session?.stale ?? false, lastVoiceMessageId: msg.message_id,
  });
}

/**
 * Sends the voice of a word. False, with nothing sent, when the word has no voice or the user cannot see the note
 * (`Repo.visibleNote`): the id of a note comes from a button, and another learner's own word is not this user's to hear.
 */
export async function playVoice(repo: Repo, tg: TgApi, user: User, noteId: number): Promise<boolean> {
  const note = await repo.visibleNote(user.id, noteId);
  if (!note?.audioFileId) return false;
  await sendVoice(repo, tg, user, note.audioFileId);
  return true;
}
