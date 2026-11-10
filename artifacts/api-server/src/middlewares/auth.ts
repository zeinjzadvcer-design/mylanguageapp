import { type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hasPermission, type Permission } from "../services/access-policy";
import { isUnmeteredRole } from "../services/entitlement-policy";

type Role = NonNullable<Request["session"]["role"]>;

/**
 * The caller's role as the database has it now, not as it was at login.
 *
 * The session copies the role when someone signs in and keeps it for as long
 * as the session lives — and with `rolling` cookies that is as long as they
 * keep using the app. Without this, demoting a staff member, or deleting their
 * account, changed nothing until they happened to log out. One primary-key
 * lookup, run only by the role-gated routes below and the few others that
 * branch on role; the student hot path (`requireAuth`) does not pay for it.
 *
 * Returns null when the account no longer exists, and ends that session.
 */
export async function currentRole(req: Request): Promise<Role | null> {
  const userId = req.session?.userId;
  if (!userId) return null;

  const [user] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    return null;
  }
  if (req.session.role !== user.role) req.session.role = user.role;
  return user.role;
}

/**
 * Whether the caller is staff, and so exempt from the limits placed on students.
 *
 * A student costs no extra query. A session's claim to be staff is confirmed
 * against the database, because it can outlive a demotion.
 */
export async function isUnmeteredCaller(req: Request): Promise<boolean> {
  if (!isUnmeteredRole(req.session?.role)) return false;
  return isUnmeteredRole((await currentRole(req)) ?? undefined);
}

/** Answer 401/403 unless the caller's current role satisfies `allowed`. */
function requireCaller(allowed: (role: Role) => boolean, deniedMessage: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const role = await currentRole(req);
    if (!role) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!allowed(role)) {
      res.status(403).json({ error: deniedMessage });
      return;
    }
    next();
  };
}

/** Any authenticated user (all roles). */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

/**
 * Answer 401/403 unless the caller's current role grants one of `permissions`.
 *
 * What each role holds is defined in services/access-policy.ts. Routes ask for
 * a permission rather than naming roles, so adding a role touches no route.
 */
export function requirePermission(...permissions: Permission[]) {
  return requireCaller(
    (role) => permissions.some((permission) => hasPermission(role, permission)),
    "You do not have permission to do this",
  );
}

/**
 * Student only.
 *
 * Guards buying a plan, which staff have no use for. It used to guard the
 * learning endpoints as well, which meant an admin or
 * content manager could not walk the student flow to check their own content —
 * the level page listed nothing and answering a question returned 403. Those
 * routes now use `requireAuth` and resolve the caller's own curriculum context,
 * answering 403 when there is none. That turns a role with no student profile
 * away on the data rather than on its name.
 *
 * Reach for this only where being a student is genuinely the point — something
 * that must never apply to staff at all, rather than something staff have no
 * data for.
 */
export const requireStudent = requireCaller((role) => role === "student", "Student access required");
