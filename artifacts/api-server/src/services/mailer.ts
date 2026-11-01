/**
 * Outbound email.
 *
 * Follows the same shape as `services/storage.ts` and `services/ai.ts`: a thin
 * interface with a degraded implementation, rather than a hard dependency that
 * stops the server from starting.
 *
 * Unconfigured, a message is written to the log instead of being sent. That
 * keeps the password-reset flow fully testable in development — the link is in
 * the API output, but only outside production — without pretending mail was
 * delivered.
 *
 * Two HTTP providers are implemented, chosen by `MAIL_PROVIDER`. Both are
 * plain `fetch` calls against a documented JSON endpoint: an SDK for one POST
 * per password reset would be a dependency to audit and update for nothing.
 */

import { logger } from "../lib/logger";

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. Deliberately not HTML: these are short transactional notes. */
  text: string;
}

export interface MailProvider {
  readonly name: string;
  readonly configured: boolean;
  send(message: MailMessage): Promise<void>;
}

/**
 * How long to wait on the provider before giving up.
 *
 * A password reset must not hold the request open indefinitely: the token is
 * already written, so a slow provider should surface as a failed send rather
 * than a hung page.
 */
const SEND_TIMEOUT_MS = parseInt(process.env.MAIL_TIMEOUT_MS ?? "10000", 10);

/** A send that failed. The caller decides whether that is fatal. */
export class MailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendError";
  }
}

/**
 * Writes the message to the log at info level.
 *
 * `configured` is false so callers can tell the difference between "sent" and
 * "logged" — the reset endpoint uses it to decide whether returning the link in
 * the response is acceptable, and it only does so outside production.
 */
class LoggingMailProvider implements MailProvider {
  readonly name = "log";
  readonly configured = false;

  async send(message: MailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      "Email not sent — no mail provider configured. Message written to the log instead.",
    );
  }
}

/** POST JSON with a deadline, and turn a non-2xx into a readable error. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerName: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // The body usually says why — a rejected sender address, an unverified
      // domain — and that is the one detail worth having in the log.
      const detail = await res.text().catch(() => "");
      throw new MailSendError(
        `${providerName} refused the message (${res.status}): ${detail.slice(0, 500)}`,
      );
    }
  } catch (err) {
    if (err instanceof MailSendError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new MailSendError(`${providerName} did not respond within ${SEND_TIMEOUT_MS}ms`);
    }
    throw new MailSendError(
      `${providerName} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Resend — https://resend.com/docs/api-reference/emails/send-email */
class ResendMailProvider implements MailProvider {
  readonly name = "resend";
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    await postJson(
      "https://api.resend.com/emails",
      { authorization: `Bearer ${this.apiKey}` },
      {
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      },
      this.name,
    );
  }
}

/** Brevo — https://developers.brevo.com/reference/sendtransacemail */
class BrevoMailProvider implements MailProvider {
  readonly name = "brevo";
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fromName: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    await postJson(
      "https://api.brevo.com/v3/smtp/email",
      { "api-key": this.apiKey },
      {
        sender: { email: this.from, name: this.fromName },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
      },
      this.name,
    );
  }
}

/**
 * `MAIL_FROM` accepts either a bare address or `Name <address>`; Brevo wants
 * the two parts separately, so split them here rather than asking for the
 * address twice.
 */
function parseFrom(raw: string): { email: string; name: string } {
  const match = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) return { name: match[1] || "لُغتي", email: match[2] };
  return { name: "لُغتي", email: raw.trim() };
}

function createMailer(): MailProvider {
  const provider = (process.env.MAIL_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (process.env.MAIL_API_KEY ?? "").trim();
  const fromRaw = (process.env.MAIL_FROM ?? "").trim();

  if (!provider || provider === "log") return new LoggingMailProvider();

  // A half-configured provider logs instead of throwing: a missing key must not
  // stop the server from starting, and the log line says exactly what is absent.
  if (!apiKey || !fromRaw) {
    logger.warn(
      { provider, hasApiKey: Boolean(apiKey), hasFrom: Boolean(fromRaw) },
      "MAIL_PROVIDER is set but MAIL_API_KEY or MAIL_FROM is missing — falling back to the log provider.",
    );
    return new LoggingMailProvider();
  }

  const from = parseFrom(fromRaw);

  switch (provider) {
    case "resend":
      return new ResendMailProvider(apiKey, fromRaw);
    case "brevo":
      return new BrevoMailProvider(apiKey, from.email, from.name);
    default:
      logger.warn(
        { provider },
        'Unknown MAIL_PROVIDER — falling back to the log provider. Supported: "resend", "brevo", "log".',
      );
      return new LoggingMailProvider();
  }
}

export const mailer: MailProvider = createMailer();
