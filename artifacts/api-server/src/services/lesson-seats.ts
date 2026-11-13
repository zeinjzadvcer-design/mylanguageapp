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

export async function takeSeatInRedis(
  r: Redis,
  key: string,
  userId: number,
  now: number,
  since: number,
  max: number | null,
): Promise<boolean> {
  const taken = await r.eval(TAKE_SEAT, 1, key, since, now, String(userId), max ?? -1);
  return taken === 1;
}
