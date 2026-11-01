import { Router, type IRouter } from "express";
import { eq, and, isNull, lt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import {
  db, usersTable, studentProfilesTable, curriculaTable, passwordResetTokensTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { validate, registerSchema, passwordSchema } from "../lib/validate";
import { mailer } from "../services/mailer";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

/** Look up the default curriculum (first active one by id) */
async function getDefaultCurriculumId(): Promise<number | null> {
  const [curriculum] = await db
    .select({ id: curriculaTable.id })
    .from(curriculaTable)
    .where(eq(curriculaTable.isActive, true))
    .orderBy(curriculaTable.id)
    .limit(1);
  return curriculum?.id ?? null;
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

  const passwordHash = await bcrypt.hash(password, 10);
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

  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  req.session.email = user.email;

  res.status(201).json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      preferredLanguage: user.preferredLanguage,
      country: user.country,
      createdAt: user.createdAt,
    },
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

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  req.session.email = user.email;

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      preferredLanguage: user.preferredLanguage,
      country: user.country,
      createdAt: user.createdAt,
    },
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
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    preferredLanguage: user.preferredLanguage,
    country: user.country,
    createdAt: user.createdAt,
  });
});

// ─── Password reset ───────────────────────────────────────────────────────────

/** How long a reset link stays valid. Short: it is a password, emailed. */
const RESET_TTL_MS = 60 * 60 * 1000;

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

  const passwordHash = await bcrypt.hash(body.password, 10);

  await db.update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, row.userId));

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
