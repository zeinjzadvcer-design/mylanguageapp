import { useGetMe, type AuthUser, type Permission } from "@workspace/api-client-react";

/**
 * The frontend asks what someone may do, never which role they hold. The server
 * sends the permissions, so a new role needs no change here.
 */
export function useCan(): (permission: Permission) => boolean {
  const { data: user } = useGetMe();
  return (permission) => (user ? holds(user, permission) : false);
}

/**
 * Tolerates an API that does not send permissions yet. The web app and the API
 * deploy separately, and either can go live first.
 */
export function holds(user: AuthUser, permission: Permission): boolean {
  return user.permissions?.includes(permission) ?? false;
}

/** Missing counts as yes, for the same reason: students must keep working. */
export function usesStudentApp(user: AuthUser): boolean {
  return user.usesStudentApp !== false;
}

interface StaffPanel {
  /** Must be the permission that guards `href`, or a refused page could loop. */
  permission: Permission;
  href: string;
  /** Key of the label in `t.nav`. */
  nav: "admin" | "contentPanel" | "payments";
  /** Whether signing in goes straight here rather than to the student dashboard. */
  landHere: boolean;
}

/** Each staff area. Someone holding several gets the first, which links onward. */
const STAFF_PANELS: readonly StaffPanel[] = [
  { permission: "students.manage", href: "/admin", nav: "admin", landHere: false },
  { permission: "content.view", href: "/cms", nav: "contentPanel", landHere: true },
  { permission: "payments.review", href: "/admin/payments", nav: "payments", landHere: true },
];

export function staffPanel(user: AuthUser): StaffPanel | undefined {
  return STAFF_PANELS.find((panel) => holds(user, panel.permission));
}

/** Where to go after signing in. */
export function landingPath(user: AuthUser): string {
  const panel = staffPanel(user);
  return panel?.landHere ? panel.href : "/dashboard";
}

/** Where to send someone from a page they may not open. */
export function refusedPath(user: AuthUser): string {
  return staffPanel(user)?.href ?? (usesStudentApp(user) ? "/dashboard" : "/login");
}
