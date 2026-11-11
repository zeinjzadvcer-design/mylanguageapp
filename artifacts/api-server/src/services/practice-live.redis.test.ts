import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PracticeSession } from "@workspace/db";

/**
 * Against a real Valkey, because the point is the order of commands on the
 * server. Skipped unless REDIS_URL is set; nothing here touches Postgres.
 */
const enabled = Boolean(process.env.REDIS_URL);

describe.skipIf(!enabled)("setup messages and the end of a call", async () => {
  const { pushSignal, forgetCall, readStoredSignals } = await import("./practice-live");
  const { redis, isRedisAvailable } = await import("./redis");

  // forgetCall does nothing until the client reports itself connected, so a
  // test that starts first would pass or fail on timing.
  beforeAll(async () => {
    for (let i = 0; i < 100 && !isRedisAvailable(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isRedisAvailable()).toBe(true);
  });

  // Ids well clear of anything a real call would use.
  let next = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const call = () =>
    ({ id: next++, requesterId: 1, partnerId: 2, status: "active" }) as unknown as PracticeSession;

  afterAll(async () => {
    await redis?.quit();
  });

  it("a message sent before the call ends is deleted with it", async () => {
    const session = call();
    await pushSignal(session.id, 1, 2, "offer", { sdp: "x" });
    expect(await readStoredSignals(session.id, 2, 0)).toHaveLength(1);
    await forgetCall(session);
    expect(await redis!.exists(`practice:sig:${session.id}:2`)).toBe(0);
  });

  it("a message that lands after the call ended does not stay behind", async () => {
    const session = call();
    await forgetCall(session);
    // The sender checked the call was live just before it ended.
    await pushSignal(session.id, 1, 2, "ice", { candidate: "x" });
    expect(await redis!.exists(`practice:sig:${session.id}:2`)).toBe(0);
    expect(await redis!.exists(`practice:sigseq:${session.id}`)).toBe(0);
  });

  it("messages in a call still being set up are kept", async () => {
    const session = call();
    await pushSignal(session.id, 1, 2, "offer", { sdp: "x" });
    await pushSignal(session.id, 1, 2, "ice", { candidate: "y" });
    expect((await readStoredSignals(session.id, 2, 0)).map((s) => s.kind)).toEqual(["offer", "ice"]);
    await forgetCall(session);
  });
});
