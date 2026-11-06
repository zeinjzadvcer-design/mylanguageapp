/**
 * Syriatel Cash SMS parsing — the rules, with no database behind them.
 *
 * Split from wallet-sms.ts for the same reason entitlement-policy.ts is split
 * from entitlements.ts: this parser decides whether a payment is believed, its
 * input is a message format Syriatel can reword without telling anyone, and it
 * should be covered by tests that run anywhere rather than needing a live
 * DATABASE_URL to check a regex.
 */

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
 * Returns nulls rather than throwing when it cannot read the message. The
 * caller stores that as-is, and a null is itself the signal that the format
 * changed and an admin should look.
 */
export function parseConfirmationSms(text: string): ParsedSms {
  // Arabic-Indic digits (٠-٩) alongside ASCII: a handset may deliver either,
  // and the same message can mix them.
  const normalised = text.replace(/[٠-٩]/g, (d) =>
    String(d.charCodeAt(0) - 0x0660),
  );

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

