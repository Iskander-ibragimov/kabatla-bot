import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { playVoice } from "../../src/content/audio";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);

describe("audio", () => {
  it("voice button sends by file id and deletes the previous voice", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 2 });
    await repo.setNoteAudio(noteIds[0]!, "FILE0");
    await repo.setNoteAudio(noteIds[1]!, "FILE1");
    await repo.saveSession({ userId: user.id, chatId: 1, messageId: 50, cardId: null, stale: false, lastVoiceMessageId: null });
    const tg = fakeTelegram();
    const first = await playVoice(repo, tg, user, noteIds[0]!);
    expect(first).toBe(true);
    await playVoice(repo, tg, user, noteIds[1]!);
    expect(tg.of("sendVoice").map((c) => c.payload.voice)).toEqual(["FILE0", "FILE1"]);
    expect(tg.of("deleteMessage")[0]!.payload).toMatchObject({ chat_id: 1, message_id: 100 });
    expect((await repo.getSession(user.id))!.lastVoiceMessageId).toBe(101);
  });

  it("does not play a note the user cannot see: another learner's own word", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const other = await seedUser(env.DB, { now: T, words: 1, tgId: 2 });
    const [secret] = await repo.insertNotes(await repo.customDeck(other.user.id, T), [{ word: "серсүз", transcription: null, pos: "", translation: "тайна", exampleTt: "", exampleRu: "", audioFileId: "SECRET" }]);
    const tg = fakeTelegram();
    expect(await playVoice(repo, tg, user, secret!)).toBe(false);
    expect(tg.calls).toHaveLength(0);
    // Its owner hears it.
    expect(await playVoice(repo, tg, other.user, secret!)).toBe(true);
    expect(tg.of("sendVoice").map((c) => [c.payload.chat_id, c.payload.voice])).toEqual([[2, "SECRET"]]);
  });

  it("voice button without audio does nothing", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const tg = fakeTelegram();
    expect(await playVoice(repo, tg, user, noteIds[0]!)).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });
});
