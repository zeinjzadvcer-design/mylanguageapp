/**
 * The first administrator.
 *
 * An empty database has no way in. Registration hard-codes `role: "student"`,
 * the staff screen cannot grant `admin`, and the seed script creates no users — so
 * without this the only way to get an administrator is to open psql and edit a
 * row by hand.
 *
 * The credentials come from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, which come from
 * `.env` (copied from `.env.example`). Locally that means `docker compose up`
 * gives a working login with no extra command; for a deployment you put
 * different values in that deployment's `.env` and nothing else changes.
 *
 * WHY IT NEVER CREATES A SECOND ONE
 * ──────────────────────────────────
 * If any administrator already exists, nothing happens. Not "if this email
 * exists" — *any* administrator. Someone who promoted their own account and
 * deleted the default must not have the default quietly reappear on the next
 * restart.
 */

import { hashPassword } from "../lib/password";
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { passwordSchema } from "../lib/validate";
import { logger } from "../lib/logger";

/**
 * The documented defaults, also in `.env.example`.
 *
 * Deliberately the same in both places: a default that only exists in code is
 * a default nobody can look up.
 */
export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_ADMIN_PASSWORD = "admin@1234";

export type BootstrapSkipReason =
  | "ADMIN_EXISTS"
  | "EMAIL_TAKEN"
  | "INVALID_EMAIL"
  | "WEAK_PASSWORD"
  | "DEFAULT_CREDENTIALS";

export type BootstrapDecision =
  | { action: "create"; email: string; password: string }
  | { action: "skip"; reason: BootstrapSkipReason; message: string };

export interface BootstrapInput {
  /** How many users already have the admin role. */
  adminCount: number;
  /** Whether any user already holds the configured email. */
  emailTaken: boolean;
  email: string;
  password: string;
  /** NODE_ENV is production: the documented defaults are refused. */
  production?: boolean;
}

/**
 * Whether to create the first administrator, and why not when the answer is no.
 *
 * Pure, and separate from the writing, so each rule can be tested without
 * starting a server and watching what happens to a database.
 */
export function decideBootstrapAdmin(input: BootstrapInput): BootstrapDecision {
  // Any administrator at all, not just this email. Someone who promoted their
  // own account and removed the default must not have it come back.
  if (input.adminCount > 0) {
    return {
      action: "skip",
      reason: "ADMIN_EXISTS",
      message: "An administrator already exists — nothing to do.",
    };
  }

  if (input.emailTaken) {
    return {
      action: "skip",
      reason: "EMAIL_TAKEN",
      message:
        `${input.email} is already registered, as a non-administrator. ` +
        "Promote that account, or set ADMIN_EMAIL to a different address.",
    };
  }

  // The defaults are printed in .env.example, the compose file and the deploy
  // docs. Locally that is the point; on a public URL it is an administrator
  // login anyone can look up. Either half being the default is refused: a
  // known email plus a known password is the whole credential.
  if (
    input.production &&
    (input.email === DEFAULT_ADMIN_EMAIL || input.password === DEFAULT_ADMIN_PASSWORD)
  ) {
    return {
      action: "skip",
      reason: "DEFAULT_CREDENTIALS",
      message:
        "ADMIN_EMAIL and ADMIN_PASSWORD must both be set to non-default values in production. " +
        "No administrator was created.",
    };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    return {
      action: "skip",
      reason: "INVALID_EMAIL",
      message: `ADMIN_EMAIL is not a valid email address: "${input.email}".`,
    };
  }

  // The same rules registration applies. An administrator held to a weaker
  // standard than a student is the wrong way round — and a password the login
  // form would refuse to set is one worth catching at start rather than at the
  // login screen.
  const strength = passwordSchema.safeParse(input.password);
  if (!strength.success) {
    return {
      action: "skip",
      reason: "WEAK_PASSWORD",
      message:
        `ADMIN_PASSWORD is rejected: ${strength.error.errors[0]?.message ?? "too weak"}. ` +
        "No administrator was created.",
    };
  }

  return { action: "create", email: input.email, password: input.password };
}

/** What the environment is asking for, with the documented defaults filled in. */
export function readBootstrapConfig(env: NodeJS.ProcessEnv = process.env): {
  email: string;
  password: string;
  production: boolean;
} {
  return {
    // Lowercased because that is how login looks an account up.
    email: (env.ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL).toLowerCase(),
    password: env.ADMIN_PASSWORD?.trim() || DEFAULT_ADMIN_PASSWORD,
    production: env.NODE_ENV === "production",
  };
}

/**
 * Create the first administrator if there is not one already.
 *
 * Never throws. A server that will not start because it could not create a
 * convenience account is worse than a server without the account.
 */
export async function ensureBootstrapAdmin(): Promise<BootstrapDecision | null> {
  try {
    const config = readBootstrapConfig();

    const [{ admins }] = await db
      .select({ admins: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));

    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, config.email))
      .limit(1);

    const decision = decideBootstrapAdmin({
      ...config,
      adminCount: admins,
      emailTaken: existing !== undefined,
    });

    if (decision.action === "skip") {
      // ADMIN_EXISTS is the steady state and says nothing useful on the
      // hundredth restart. The rest are misconfiguration the operator needs
      // to see.
      if (decision.reason === "ADMIN_EXISTS") {
        logger.debug({ reason: decision.reason }, decision.message);
      } else {
        logger.warn({ reason: decision.reason }, decision.message);
      }
      return decision;
    }

    const passwordHash = await hashPassword(decision.password);

    await db.insert(usersTable).values({
      name: "Administrator",
      email: decision.email,
      passwordHash,
      role: "admin",
      // The CMS and admin screens are in English; the student app is Arabic.
      preferredLanguage: "en",
    });

    // No student_profiles row on purpose. An administrator is not a learner,
    // /dashboard already handles a user without a profile, and inventing an
    // enrolment would put a fake student in every progress query.

    logger.info(
      { email: decision.email },
      "Created the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD.",
    );

    return decision;
  } catch (err) {
    // Two API instances starting together: one insert wins, the other hits the
    // unique email index. That is the constraint doing its job, not a fault.
    logger.warn({ err }, "Could not create the bootstrap administrator — carrying on");
    return null;
  }
}
