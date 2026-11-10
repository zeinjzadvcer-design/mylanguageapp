import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { eq, and, isNull, lt, gt, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "../lib/password";
import { randomBytes, createHash } from "node:crypto";
import {
  db, usersTable, studentProfilesTable, passwordResetTokensTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { permissionsOf, roleDefinition } from "../services/access-policy";
import { getDefaultCurriculumId } from "../services/learning";
import { validate, registerSchema, passwordSchema } from "../lib/validate";
import { mailer } from "../services/mailer";
import { destroyUserSessions } from "../services/session-store";
import { rememberDevice } from "../lib/known-device";
import { envInt } from "../lib/env";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

/**
 * Sign this request in as `user`, under a NEW session id.
 *
 * Reusing whatever id the request arrived with is session fixation: someone who
 * got a session id into the victim's browser before they logged in would hold
 * the victim's signed-in session afterwards. Regenerating discards that id.
 */
async function signIn(
  req: Request,
  res: Response,
  user: Pick<typeof usersTable.$inferSelect, "id" | "role" | "name" | "email">,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  req.session.email = user.email;
  rememberDevice(res, user.email);
}

/**
 * The signed-in user as the client sees them.
 *
 * Permissions rather than leaving the client to work them out from the role, so
 * the frontend holds no copy of which role may do what.
 */
function authUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: permissionsOf(user.role),
    // A role this version no longer defines holds no permissions; it is shown
    // the student app rather than sent back to the sign-in page with no reason.
    usesStudentApp: roleDefinition(user.role)?.usesStudentApp ?? true,
    preferredLanguage: user.preferredLanguage,
    country: user.country,
    createdAt: user.createdAt,
  };
}

router.post("/auth/register", async (req, res): Promise<void> => {
  const body = validate(res, registerSchema, req.body);
  if (!body) return; // response already sent (400 with details)
  const { name, email, password, preferredLanguage, country, referralSource, referralDetail } = body;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(usersTable).values({
    name,
    email: email.toLowerCase(),
    passwordHash,
    preferredLanguage: preferredLanguage ?? "ar",
    country: country ?? "SY",
    referralSource,
    referralDetail: referralSource === "other" ? referralDetail ?? null : null,
    role: "student",
  }).returning();

  // Enroll student in the default curriculum (null if none exists yet)
  const curriculumId = await getDefaultCurriculumId();

  await db.insert(studentProfilesTable).values({
    userId: user.id,
    curriculumId: curriculumId ?? undefined,
    currentLevelId: undefined, // assigned after placement test
    streakDays: 0,
    totalXp: 0,
    placementCompleted: false,
  });

  await signIn(req, res, user);

  res.status(201).json({
    user: authUser(user),
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  await signIn(req, res, user);

  res.json({
    user: authUser(user),
  });
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }
  res.json(authUser(user));
});

// ─── Password reset ───────────────────────────────────────────────────────────

/** How long a reset link stays valid. Short: it is a password, emailed. */
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * How soon after one reset link another may be sent to the same address.
 *
 * Every request retires the previous link, so without this anyone could keep a
 * user from ever finishing a reset — and flood their inbox while doing it —
 * from as many addresses as they like. Within the cooldown the request is
 * answered exactly like any other, and the link already sent stays good.
 */
const RESET_COOLDOWN_MS = envInt("RESET_COOLDOWN_MS", 120_000);

/**
 * Reset emails one address may be sent in a day.
 *
 * The cooldown alone still allows one every two minutes — 720 a day to one
 * inbox, and Resend's free tier is 100 a day for everyone. Past this the
 * request is answered the same way and nothing is sent; the last link sent is
 * still good.
 */
const RESET_DAILY_MAX = envInt("RESET_DAILY_MAX", 5);

/** The token travels in the URL; only this hash is ever stored. */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const forgotSchema = z.object({ email: z.string().min(1, "Email is required") });
const resetSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: passwordSchema,
});

/**
 * Start a reset.
 *
 * Always answers 200, whether or not the address exists. Saying "no such
 * account" would turn this endpoint into a way to discover who has registered.
 */
router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const body = validate(res, forgotSchema, req.body);
  if (!body) return;

  const email = body.email.toLowerCase().trim();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);

  // The generic answer, sent on every path.
  const ok = { message: "If that email is registered, a reset link has been sent." };

  if (!user) { res.json(ok); return; }

  const [recent] = await db
    .select({ id: passwordResetTokensTable.id })
    .from(passwordResetTokensTable)
    .where(and(
      eq(passwordResetTokensTable.userId, user.id),
      isNull(passwordResetTokensTable.usedAt),
      gt(passwordResetTokensTable.createdAt, new Date(Date.now() - RESET_COOLDOWN_MS)),
    ))
    .limit(1);
  if (recent) { res.json(ok); return; }

  const [{ sentToday }] = await db
    .select({ sentToday: sql<number>`count(*)::int` })
    .from(passwordResetTokensTable)
    .where(and(
      eq(passwordResetTokensTable.userId, user.id),
      gt(passwordResetTokensTable.createdAt, new Date(Date.now() - 24 * 3_600_000)),
    ));
  if (sentToday >= RESET_DAILY_MAX) {
    logger.warn({ userId: user.id }, "Password reset not sent: daily limit for this address reached");
    res.json(ok);
    return;
  }

  // Expire outstanding tokens: requesting a new link should retire the old one.
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(and(
      eq(passwordResetTokensTable.userId, user.id),
      isNull(passwordResetTokensTable.usedAt),
    ));

  const token = randomBytes(32).toString("hex");
  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });

  const base = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const link = `${base}/reset-password?token=${token}`;

  // A provider outage must not turn into a 500: the token is already written,
  // and this endpoint deliberately answers the same way whether or not the
  // address exists, so leaking a failure here would also leak which addresses
  // are registered. Logged for the operator, invisible to the caller.
  await mailer
    .send({
      to: user.email,
      subject: "إعادة تعيين كلمة المرور",
      text:
        `مرحباً ${user.name}،

` +
        `لإعادة تعيين كلمة المرور، افتح الرابط التالي:
${link}

` +
        `الرابط صالح لمدة ساعة واحدة ويُستخدم مرة واحدة فقط.
` +
        `إذا لم تطلب هذا، تجاهل هذه الرسالة.`,
    })
    .catch((err) => {
      logger.error({ err, userId: user.id }, "Password-reset email could not be sent");
    });

  // With no mail provider the message only reached the log, so a developer
  // would otherwise have no way to continue. Never returned once mail is real.
  if (!mailer.configured && process.env.NODE_ENV !== "production") {
    res.json({ ...ok, devResetLink: link });
    return;
  }

  res.json(ok);
});

/** Spend a token and set the new password. */
router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const body = validate(res, resetSchema, req.body);
  if (!body) return;

  const [row] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, hashToken(body.token)))
    .limit(1);

  // Unknown, spent and expired all answer alike — a precise error would let
  // someone probe which tokens exist.
  const invalid = () =>
    res.status(400).json({
      error: "This reset link is invalid or has expired. Request a new one.",
      code: "RESET_TOKEN_INVALID",
    });

  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) { invalid(); return; }

  const passwordHash = await hashPassword(body.password);

  await db.update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, row.userId));

  // A reset is often how someone takes their account back. Any session opened
  // with the old password — including one a thief holds — ends here. Before the
  // token is spent: if the session store is unreachable this throws, and the
  // student can use the same link again rather than being left with old
  // sessions alive and a link that no longer works.
  await destroyUserSessions(req.sessionStore, row.userId);

  await db.update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokensTable.id, row.id));

  // Housekeeping, not security: spent and expired rows have no further use.
  await db.delete(passwordResetTokensTable)
    .where(lt(passwordResetTokensTable.expiresAt, new Date(Date.now() - RESET_TTL_MS)));

  logger.info({ userId: row.userId }, "Password reset completed");

  res.json({ message: "Your password has been changed. You can now sign in." });
});

export default router;
