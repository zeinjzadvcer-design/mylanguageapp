/**
 * Staff accounts: creating them and deciding what they can do.
 *
 * Only roles marked `assignable` in services/access-policy.ts can be handed out
 * or taken back here. Administrators are out of reach of this file in both
 * directions, so nobody can be made one, or removed as one, from the panel.
 *
 * Every change of role ends that person's sessions, because several student
 * routes read the role a session was opened with.
 */

import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import {
  db, passwordResetTokensTable, studentProfilesTable, usersTable, type User, type UserRole,
} from "@workspace/db";
import { requirePermission } from "../middlewares/auth";
import { assignableRoles, isManageableRole, roleDefinition } from "../services/access-policy";
import { getDefaultCurriculumId } from "../services/learning";
import { destroyUserSessions } from "../services/session-store";
import { isUniqueViolation } from "../lib/db-errors";
import { passwordSchema, validate } from "../lib/validate";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const guard = requirePermission("staff.manage");

const roleSchema = z.enum(assignableRoles().map((r) => r.role) as [UserRole, ...UserRole[]]);

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().toLowerCase().email("That is not a valid email address").max(200),
  role: roleSchema,
  /** Required for a new account. Ignored when promoting one that already exists. */
  password: passwordSchema.optional(),
  /**
   * Confirms that an email already registered as a student should become staff.
   * Never implied: without it, a typo in the email would promote a stranger.
   */
  promoteExisting: z.boolean().optional(),
});

const updateSchema = z.object({ role: roleSchema });

const passwordBodySchema = z.object({ password: passwordSchema });

function toStaffMember(user: Pick<User, "id" | "name" | "email" | "role" | "createdAt">) {
  const definition = roleDefinition(user.role);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    roleLabel: definition?.label ?? user.role,
    roleLabelAr: definition?.labelAr ?? user.role,
    editable: isManageableRole(user.role),
    createdAt: user.createdAt,
  };
}

/**
 * End an account's sessions and change its role.
 *
 * In that order: if the session store is unreachable this throws with nothing
 * changed, and the admin can simply try again. The other way round, a revoked
 * account is no longer staff, so a retry could not find it to end its sessions.
 */
async function setRole(req: Request, userId: number, role: UserRole) {
  await destroyUserSessions(req.sessionStore, userId);
  const [updated] = await db
    .update(usersTable)
    .set({ role })
    .where(eq(usersTable.id, userId))
    .returning();
  logger.info({ adminId: req.session.userId, userId, role }, "Staff role changed");
  return updated;
}

/** Every account that is not a student, and the roles that can be handed out. */
router.get("/admin/staff", guard, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(ne(usersTable.role, "student"))
    .orderBy(desc(usersTable.createdAt));

  res.json({ staff: rows.map(toStaffMember), roles: assignableRoles() });
});

router.post("/admin/staff", guard, async (req, res): Promise<void> => {
  const body = validate(res, createSchema, req.body);
  if (!body) return;

  const [existing] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.email, body.email))
    .limit(1);

  if (existing) {
    if (existing.role !== "student") {
      res.status(409).json({ error: "That email already belongs to a staff account", code: "ALREADY_STAFF" });
      return;
    }
    if (!body.promoteExisting) {
      res.status(409).json({ error: "That email belongs to a student account", code: "EMAIL_IS_STUDENT" });
      return;
    }
    res.json(toStaffMember(await setRole(req, existing.id, body.role)));
    return;
  }

  if (!body.password) {
    res.status(400).json({ error: "A password is required for a new account", code: "PASSWORD_REQUIRED" });
    return;
  }

  try {
    const [created] = await db
      .insert(usersTable)
      .values({
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        role: body.role,
        preferredLanguage: "en",
      })
      .returning();

    // No student_profiles row, for the reason given in bootstrap-admin.ts: an
    // invented enrolment would put a fake student in every progress query.
    logger.info({ adminId: req.session.userId, userId: created.id, role: created.role }, "Staff account created");
    res.status(201).json(toStaffMember(created));
  } catch (err) {
    // Two submissions at once: the unique index decides, and the loser is told
    // the same thing it would have been told a moment later.
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "That email already belongs to an account", code: "ALREADY_STAFF" });
      return;
    }
    throw err;
  }
});

/**
 * The account an admin is allowed to change, or null having answered.
 *
 * Yourself is refused even when your role is assignable, so that a future role
 * holding `staff.manage` cannot move itself to a different set of permissions.
 */
async function loadEditable(req: Request, res: import("express").Response) {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid staff id" });
    return null;
  }
  if (id === req.session.userId) {
    res.status(403).json({ error: "You cannot change your own access", code: "SELF" });
    return null;
  }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target || target.role === "student") {
    res.status(404).json({ error: "Staff account not found" });
    return null;
  }
  if (!isManageableRole(target.role)) {
    res.status(403).json({ error: "This account cannot be changed here", code: "NOT_EDITABLE" });
    return null;
  }
  return target;
}

router.patch("/admin/staff/:id", guard, async (req, res): Promise<void> => {
  const body = validate(res, updateSchema, req.body);
  if (!body) return;
  const target = await loadEditable(req, res);
  if (!target) return;

  res.json(toStaffMember(await setRole(req, target.id, body.role)));
});

/**
 * Take away staff access. The account stays, as a student, because deleting it
 * would have to rewrite who reviewed which payment and who wrote which lesson.
 * They can be given a role again by adding the same email.
 */
router.post("/admin/staff/:id/revoke", guard, async (req, res): Promise<void> => {
  const target = await loadEditable(req, res);
  if (!target) return;

  // Staff accounts are created without a profile, and a student needs one to
  // take the placement test. A promoted student keeps the one they have.
  const curriculumId = await getDefaultCurriculumId();
  await db
    .insert(studentProfilesTable)
    .values({ userId: target.id, curriculumId: curriculumId ?? undefined })
    .onConflictDoNothing();

  await setRole(req, target.id, "student");
  res.json({ success: true });
});

/** Set a new password for someone who cannot use the emailed reset link. */
router.post("/admin/staff/:id/password", guard, async (req, res): Promise<void> => {
  const body = validate(res, passwordBodySchema, req.body);
  if (!body) return;
  const target = await loadEditable(req, res);
  if (!target) return;

  await db
    .update(usersTable)
    .set({ passwordHash: await bcrypt.hash(body.password, 10) })
    .where(eq(usersTable.id, target.id));
  // A reset link already emailed would otherwise still replace this password.
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokensTable.userId, target.id), isNull(passwordResetTokensTable.usedAt)));
  await destroyUserSessions(req.sessionStore, target.id);

  logger.info({ adminId: req.session.userId, userId: target.id }, "Staff password reset");
  res.json({ success: true });
});

export default router;
