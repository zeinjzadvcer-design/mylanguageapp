import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Against a real Valkey, because what matters is that checking for a free seat
 * and taking it happen as one step on the server. Skipped unless REDIS_URL is set.
 */
const enabled = Boolean(process.env.REDIS_URL);

describe.skipIf(!enabled)("seats in lessons (Valkey)", async () => {
  const { takeSeatInRedis } = await import("./lesson-seats");
  const { redis, isRedisAvailable } = await import("./redis");
  const key = `test:lessons:active:${process.pid}:${Date.now()}`;
  const NOW = Date.now();
  const SINCE = NOW - 600_000;

  beforeAll(async () => {
    for (let i = 0; i < 100 && !isRedisAvailable(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isRedisAvailable()).toBe(true);
  });

  afterAll(async () => {
    await redis?.del(key);
    await redis?.quit();
  });

  const take = (userId: number, max: number | null, now = NOW) =>
    takeSeatInRedis(redis!, key, userId, now, SINCE, max);

  it("a crowd arriving together never takes more seats than the limit", async () => {
    await redis!.del(key);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => take(i + 1, 10)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await redis!.zcard(key)).toBe(10);
  });

  it("a student with a seat keeps it when lessons are full", async () => {
    const seated = Number((await redis!.zrange(key, "0", "0"))[0]);
    expect(await take(seated, 10, NOW + 1)).toBe(true);
    expect(Number(await redis!.zscore(key, String(seated)))).toBe(NOW + 1);
  });

  it("seats not used within the window are freed", async () => {
    await redis!.del(key);
    await redis!.zadd(key, SINCE - 1, "1");
    expect(await take(2, 1)).toBe(true);
    expect(await redis!.zscore(key, "1")).toBeNull();
  });

  it("with no limit, every student is seated", async () => {
    await redis!.del(key);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => take(i + 1, null)));
    expect(results.every(Boolean)).toBe(true);
  });
});
