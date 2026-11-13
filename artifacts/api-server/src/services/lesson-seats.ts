/**
 * Seats in lessons, kept in Valkey so every API instance counts the same
 * students. The same rule as takeLocalSeat (lesson-load-policy.ts), done in one
 * script so that checking for a free seat and taking it cannot be split by
 * another student's request.
 */

import type { redis } from "./redis";

type Redis = NonNullable<typeof redis>;

// KEYS[1] the sorted set of seats (member: user id, score: last seen, ms)
// ARGV[1] free seats last seen before this · ARGV[2] now · ARGV[3] user id
// ARGV[4] the limit, or -1 for none
// Returns 1 when the student has a seat, 0 when lessons are full.
const TAKE_SEAT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
local max = tonumber(ARGV[4])
if max >= 0 and not redis.call('ZSCORE', KEYS[1], ARGV[3]) and redis.call('ZCARD', KEYS[1]) >= max then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return 1
`;

/**
 * Registered once per client, so each call sends the script's hash (EVALSHA)
 * rather than its source; ioredis falls back to the source when Valkey has
 * lost its script cache, after a restart for example.
 */
const registered = new WeakSet<Redis>();
type WithSeatCommand = Redis & {
  takeLessonSeat(key: string, since: number, now: number, userId: string, max: number): Promise<number>;
};

export async function takeSeatInRedis(
  r: Redis,
  key: string,
  userId: number,
  now: number,
  since: number,
  max: number | null,
): Promise<boolean> {
  if (!registered.has(r)) {
    r.defineCommand("takeLessonSeat", { numberOfKeys: 1, lua: TAKE_SEAT });
    registered.add(r);
  }
  const taken = await (r as WithSeatCommand).takeLessonSeat(key, since, now, String(userId), max ?? -1);
  return taken === 1;
}
