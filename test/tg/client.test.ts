import { afterEach, describe, expect, it, vi } from "vitest";
import { TgClient } from "../../src/tg/client";

describe("TgClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the global fetch as a plain function: on Workers, fetch called as a method of another object throws «Illegal invocation»", async () => {
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
    });
    await expect(new TgClient("t").call("sendMessage", { chat_id: 1, text: "x" })).resolves.toEqual({ message_id: 7 });
  });
});
