/**
 * Syriatel Cash SMS parsing — the rules, with no database behind them.
 *
 * Split from wallet-sms.ts for the same reason entitlement-policy.ts is split
 * from entitlements.ts: this parser decides whether a payment is believed, its
 * input is a message format Syriatel can reword without telling anyone, and it
 * should be covered by tests that run anywhere rather than needing a live
 * DATABASE_URL to check a regex.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { envInt } from "../lib/env";

/**
 * How long a student has to submit after the SMS arrived.
 *
 * The operation number's safety rests on only the payer knowing it, and that
 * weakens with time — a forwarded screenshot, a shared handset. A bound costs
 * a student nothing (they submit within minutes) and closes most of the window.
 * Measured from `received_at`, not from when the server was told: a phone
 * offline for an hour must not consume the student's window.
 */
export const SUBMISSION_WINDOW_MS = parseInt(
  process.env.WALLET_SMS_WINDOW_MS ?? String(48 * 3600_000),
  10,
);

/**
 * Rewrite Arabic-Indic and Persian digits as ASCII.
 *
 * A handset may deliver or type either, and the same operation number has to
 * compare equal however it was entered.
 */
export function toAsciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The sender ids a confirmation may come from, from a comma-separated setting. */
export function parseAllowedSenders(raw: string | undefined): string[] {
  return (raw ?? "Syriatel")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Whether a forwarded message really came from the operator.
 *
 * Exact, ignoring case. The filter on the phone is per-app setup that can be
 * missing or mistyped, and without this check anyone could text the merchant
 * SIM a confirmation they wrote themselves and then submit its number. A
 * message with no sender is not trusted: nothing says who wrote it.
 */
export function isTrustedSender(sender: string | null, allowed: readonly string[]): boolean {
  return sender !== null && allowed.includes(sender.trim().toLowerCase());
}

/** The SMS centres a confirmation may arrive through; empty means any. */
export function parseAllowedServiceCenters(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.replace(/[^\d]/g, ""))
    .filter((s) => s.length > 0);
}

/**
 * Whether a message came through a known SMS centre.
 *
 * The sender name alone can be forged: bulk-SMS services let a customer choose
 * it, so a fake confirmation can reach the merchant SIM reading "Syriatel". The
 * SMS centre is a second signal such a message has to match. Off until
 * WALLET_SMS_SERVICE_CENTERS is set, because the real value has to be read off
 * a genuine message first.
 */
export function isTrustedServiceCenter(
  serviceCenter: string | null,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return true;
  return serviceCenter !== null && allowed.includes(serviceCenter.replace(/[^\d]/g, ""));
}

/**
 * How many subscriptions the SMS path may activate in an hour, with nobody
 * looking. Forged or not, a burst past this waits for an admin: a limit on how
 * much a fake confirmation can buy before someone notices.
 */
export const SMS_ACTIVATIONS_PER_HOUR = envInt("WALLET_SMS_AUTO_MAX_PER_HOUR", 30);

/**
 * How the companion app's token is stored: its SHA-256, never the token.
 *
 * Anything holding the token can activate subscriptions, so a database read —
 * a leaked backup, a diagnostic script — must not hand it over. The token is
 * shown once when generated and never needs reading back.
 */
export function ingestTokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/**
 * Whether a presented token matches what is stored.
 *
 * Compares fixed-length digests, so neither length nor position leaks through
 * timing. A value stored before tokens were hashed is still accepted, so the
 * phone keeps working until an admin next generates a token.
 */
export function ingestTokenMatches(presented: string, stored: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  const expected = stored.startsWith("sha256:") ? stored : ingestTokenDigest(stored);
  return timingSafeEqual(digest(ingestTokenDigest(presented)), digest(expected));
}

export interface ParsedSms {
  operationNumber: string | null;
  amountSyp: string | null;
}

/**
 * Pull the amount and operation number out of a confirmation message.
 *
 * Deliberately loose about everything except the two values. The exact wording
 * is Syriatel's and undocumented — they can reword it whenever they like — so
 * this anchors on «مبلغ … » and «رقم العملية … » and tolerates whatever sits
 * between them. A stricter pattern would fail silently on the first rewrite,
 * and silence is the worst failure here: payments would stop activating with
 * nothing to show why.
 *
 * The one thing it is strict about is direction: the message must say money
 * was RECEIVED («استلام مبلغ»). An outgoing transfer or refund also carries an
 * amount and an operation number, and the student on the other end knows that
 * number, so reading it as a payment would activate a subscription for money
 * that left the account. A reworded message therefore stops activating and
 * waits for an admin, which is the safe way round to be wrong.
 *
 * Returns nulls rather than throwing when it cannot read the message. The
 * caller stores that as-is, and a null is itself the signal that the format
 * changed and an admin should look.
 */
export function parseConfirmationSms(text: string): ParsedSms {
  const normalised = toAsciiDigits(text);

  if (!/استلام\s*مبلغ/.test(normalised)) {
    return { operationNumber: null, amountSyp: null };
  }

  // The amount: digits, optionally with a decimal part, after «مبلغ».
  // Thousands separators are stripped before parsing — 25,000 and 25000 are
  // the same payment.
  const amountMatch = normalised.match(/مبلغ\s*([\d.,]+)/);
  const rawAmount = amountMatch?.[1]?.replace(/,/g, "") ?? null;
  const amountSyp =
    rawAmount && Number.isFinite(Number(rawAmount)) ? rawAmount : null;

  // The operation number: the run of digits after «رقم العملية», however the
  // words in between are arranged ("هو", a colon, nothing at all).
  const opMatch = normalised.match(/رقم\s*العملية[^\d]*(\d{4,})/);
  const operationNumber = opMatch?.[1] ?? null;

  return { operationNumber, amountSyp };
}

