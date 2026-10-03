import type { Repo, User } from "../db/repo";
import type { TgApi, TgMessage } from "../tg/client";

/** 🔊 button: sends the word's voice and removes the previous one so the chat stays clean. */
export async function playVoice(repo: Repo, tg: TgApi, user: User, noteId: number): Promise<boolean> {
  const note = await repo.getNote(noteId);
  if (!note?.audioFileId) return false;
  const session = await repo.getSession(user.id);
  if (session?.lastVoiceMessageId) {
    await tg.call("deleteMessage", { chat_id: user.chatId, message_id: session.lastVoiceMessageId }).catch(() => undefined);
  }
  const msg = await tg.call<TgMessage>("sendVoice", { chat_id: user.chatId, voice: note.audioFileId, disable_notification: true });
  await repo.saveSession({
    userId: user.id, chatId: user.chatId, messageId: session?.messageId ?? null, cardId: session?.cardId ?? null,
    stale: session?.stale ?? false, lastVoiceMessageId: msg.message_id,
  });
  return true;
}
