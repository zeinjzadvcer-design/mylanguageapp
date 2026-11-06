/**
 * The visitor's address, for keying rate limits.
 *
 * Express's `req.ip` is the last `X-Forwarded-For` entry once TRUST_PROXY hops
 * are peeled off. That is right behind a plain load balancer, but some
 * platforms put their own ingress address there and the visitor's somewhere
 * else — DigitalOcean App Platform documents `do-connecting-ip` as the header
 * holding the client. Keyed on the ingress address, every signed-out visitor
 * shares one bucket, and one busy minute locks everyone out of login.
 *
 * CLIENT_IP_HEADER names that header. Unset, this is `req.ip`, as before.
 *
 * ONLY set it for a platform that overwrites the header on every request. If
 * the platform passes a visitor's own value through, the visitor chooses their
 * own address and the limits stop meaning anything — check with
 * scripts/check-client-ip.mjs after deploying.
 */

import { isIP } from "node:net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

export function clientIp(
  req: Pick<Request, "get" | "ip">,
  header: string | undefined = process.env.CLIENT_IP_HEADER,
): string {
  const name = header?.trim().toLowerCase();
  // First entry only: a header that arrives as a list is a forwarded chain.
  const fromHeader = name ? req.get(name)?.split(",")[0]?.trim() : undefined;
  // Anything that is not an address is ignored rather than used as a key, so
  // a malformed header cannot make up buckets of its own.
  const ip = fromHeader && isIP(fromHeader) ? fromHeader : req.ip;
  // ipKeyGenerator groups an IPv6 address by its /56, which is what one
  // household or phone is usually given — otherwise each of the addresses in
  // it would be a separate bucket.
  return ipKeyGenerator(ip ?? "");
}
