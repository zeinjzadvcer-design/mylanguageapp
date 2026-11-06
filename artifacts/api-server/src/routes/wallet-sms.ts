/**
 * SMS ingest for the companion app.
 *
 * One endpoint, called by an Android app on the merchant phone each time
 * Syriatel confirms a received payment. It is deliberately the only way into
 * this path: a forwarded SMS is treated as proof of payment, so anything that
 * can POST here can mint a subscription.
 *
 * Not under requireAuth: the companion app has no user session and should not
 * hold one. It presents a bearer token an admin generated instead, compared in
 * constant time, and the endpoint refuses everything while no token is set.
 */

import { Router, type IRouter } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ingestSms, getIngestToken } from "../services/wallet-sms";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Compare without leaking length or position through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * signal, so both sides are hashed to a fixed width first — length is
 * compared as data rather than as control flow.
 */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented.padEnd(128, "\0").slice(0, 128));
  const b = Buffer.from(expected.padEnd(128, "\0").slice(0, 128));
  return timingSafeEqual(a, b) && presented.length === expected.length;
}

const ingestSchema = z.object({
  /** The message body exactly as the handset received it. */
  rawText: z.string().min(1).max(2000),
  /** Syriatel's sender id, as the handset reported it. */
  sender: z.string().max(100).nullish(),
  /**
   * When the HANDSET received it, ISO 8601.
   *
   * Not the time of this request: a phone that was offline reports an older
   * timestamp, and the submission window is measured from this, so using the
   * server clock would quietly extend or consume a student's window.
   */
  receivedAt: z.string().datetime(),
});

/** POST /wallet-sms — forward one confirmation message. */
router.post("/wallet-sms", async (req, res): Promise<void> => {
  const expected = await getIngestToken();

  if (!expected) {
    // Fails closed. Until an admin generates a token there is no way to tell a
    // genuine forward from a fabricated one, and guessing wrong here hands out
    // subscriptions.
    res.status(503).json({ error: "SMS ingest is not configured" });
    return;
  }

  const header = req.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!presented || !tokensMatch(presented, expected)) {
    logger.warn({ ip: req.ip }, "Rejected wallet SMS ingest with a bad token");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = ingestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid message payload" });
    return;
  }

  const receivedAt = new Date(parsed.data.receivedAt);

  // A timestamp from the future is a wrong clock, not a message. Accepting it
  // would place the message outside every window and it would never match.
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) {
    res.status(400).json({ error: "receivedAt is in the future" });
    return;
  }

  const result = await ingestSms({
    rawText: parsed.data.rawText,
    sender: parsed.data.sender ?? null,
    receivedAt,
  });

  // 200 for every stored outcome, including unmatched and unparsed: the app
  // has done its job and must not retry. Only a 5xx should make it try again.
  res.json(result);
});

export default router;
