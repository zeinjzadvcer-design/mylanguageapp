/**
 * Who may do what — the one place that answers it.
 *
 * A route asks for a permission, never for a role. A role is only a named set
 * of permissions, defined below. So:
 *
 *   - A new kind of staff member is one entry in `ROLES` (and its name in
 *     `USER_ROLES`, lib/db). Routes, the admin panel and the sidebar all follow
 *     from its permissions, and it appears in the staff screen by itself.
 *   - A new area of the product is a new entry in `PERMISSIONS`, asked for by
 *     the routes that guard it and listed in the `Permission` schema in
 *     openapi.yaml so the frontend can test for it.
 *
 * No database behind it, so every rule can be tested directly. The type-only
 * import keeps it that way: @workspace/db opens a pool when really imported.
 */

import type { UserRole } from "@workspace/db";

export const PERMISSIONS = [
  /** Read lessons, quizzes, vocabulary, media and the content audit log. */
  "content.view",
  /** Create, edit, delete and submit content for review. */
  "content.edit",
  /** Approve or reject submitted lessons and quizzes. */
  "content.review",
  /** Publish, unpublish and archive, and edit what is already published. */
  "content.publish",
  /** The marking queue: see students' answers and recordings, and mark them. */
  "grading.manage",
  /** Languages, curricula and levels: the structure content hangs from. */
  "catalog.manage",
  /** Reports students file about peer practice calls. */
  "practice_reports.manage",
  /** Work the payment queue: read receipts, approve and reject. */
  "payments.review",
  /** Approve a payment made from your own account. */
  "payments.approve_own",
  /** See the payment settings, and change prices and the exchange rate options. */
  "payments.settings",
  /** Change the Syriatel Cash QR code and account details. */
  "payments.wallet",
  /** Change the crypto wallet address and QR code. */
  "payments.crypto",
  /** Issue the token the SMS forwarder uses, which can activate subscriptions. */
  "payments.sms_token",
  /** Student records, signup figures and placement overrides. */
  "students.manage",
  /** AI providers and limits, and voice practice capacity. */
  "settings.manage",
  /** Create staff accounts and change what they can do. */
  "staff.manage",
  /** Send an announcement to students. */
  "announcements.send",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface RoleDefinition {
  permissions: readonly Permission[];
  /**
   * Whether the staff screen can hand this role out. `admin` is deliberately
   * not: anyone holding `staff.manage` could otherwise mint administrators, and
   * an administrator could be locked out by another.
   */
  assignable: boolean;
  /**
   * Whether the account has a use for the student app. When false the student
   * pages redirect to the staff panel instead of showing an empty course.
   */
  usesStudentApp: boolean;
  /**
   * Exempt from plan quotas and level locks. For people who must walk the real
   * student flow to check content, so it is a choice per role and not a
   * consequence of being staff: someone reviewing payments has no such need.
   */
  unmetered: boolean;
  /** What the staff screen calls it. Kept here so a new role needs no UI work. */
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
}

export const ROLES: Record<UserRole, RoleDefinition> = {
  student: {
    permissions: [],
    assignable: false,
    usesStudentApp: true,
    unmetered: false,
    label: "Student",
    labelAr: "طالب",
    description: "Learns on the platform.",
    descriptionAr: "يتعلّم على المنصة.",
  },
  admin: {
    permissions: PERMISSIONS,
    assignable: false,
    usesStudentApp: true,
    unmetered: true,
    label: "Administrator",
    labelAr: "مدير",
    description: "Full access to everything.",
    descriptionAr: "صلاحيات كاملة على كل شيء.",
  },
  content_manager: {
    permissions: ["content.view", "content.edit"],
    assignable: true,
    usesStudentApp: true,
    unmetered: true,
    label: "Content manager",
    labelAr: "مسؤول المحتوى",
    description:
      "Creates and edits lessons, quizzes, vocabulary, placement questions and media, and submits them for review. Cannot publish.",
    descriptionAr:
      "ينشئ ويعدّل الدروس والاختبارات والمفردات وأسئلة تحديد المستوى والوسائط، ويرسلها للمراجعة. لا يمكنه النشر.",
  },
  payments_manager: {
    // To hand over more later, add "payments.wallet", "payments.crypto" or
    // "payments.sms_token" here. The screen and the API both follow.
    permissions: ["payments.review", "payments.settings"],
    assignable: true,
    usesStudentApp: false,
    unmetered: false,
    label: "Payments manager",
    labelAr: "مسؤول المدفوعات",
    description:
      "Reviews payment receipts, activates subscriptions, and sets prices. Sees the receiving accounts but cannot change them, the crypto wallet or the SMS forwarder token. No access to lessons or students.",
    descriptionAr:
      "يراجع إيصالات الدفع ويفعّل الاشتراكات ويحدد الأسعار. يرى حسابات الاستلام دون تعديلها، ولا يمكنه تعديل المحفظة الرقمية أو رمز تحويل الرسائل. لا يصل إلى الدروس أو الطلاب.",
  },
};

/**
 * Which permission each field of the payment settings needs.
 *
 * The settings screen saves through one endpoint, so the route alone cannot
 * tell a price change from a new wallet address.
 */
const PAYMENT_SETTING_PERMISSIONS = new Map<string, Permission>([
  ["sypRateAuto", "payments.settings"],
  ["sypUnit", "payments.settings"],
  ["walletQrMediaId", "payments.wallet"],
  ["walletAccountName", "payments.wallet"],
  ["walletAccountNumber", "payments.wallet"],
  ["walletInstructionsAr", "payments.wallet"],
  ["walletMerchantPhone", "payments.wallet"],
  ["cryptoWalletAddress", "payments.crypto"],
  ["cryptoQrMediaId", "payments.crypto"],
]);

/**
 * May this role change this payment setting?
 *
 * A field missing from the list above is refused for everyone, administrators
 * included, so a new setting cannot go live without someone deciding who owns it.
 */
export function canChangePaymentSetting(role: string | undefined, field: string): boolean {
  const permission = PAYMENT_SETTING_PERMISSIONS.get(field);
  return permission !== undefined && hasPermission(role, permission);
}

/**
 * A Map rather than indexing `ROLES`, so that a role string from outside can
 * never resolve to something inherited, like `constructor`.
 */
const definitions = new Map<string, RoleDefinition>(Object.entries(ROLES));

/** The role's definition; undefined for a name this version does not know. */
export function roleDefinition(role: string | undefined): RoleDefinition | undefined {
  return definitions.get(role ?? "");
}

/** An unknown role holds no permissions, so it fails closed. */
export function permissionsOf(role: string | undefined): readonly Permission[] {
  return roleDefinition(role)?.permissions ?? [];
}

export function hasPermission(role: string | undefined, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}

export interface LessonChangeDenial {
  code: "LESSON_PUBLISHED" | "LESSON_IN_REVIEW" | "NOT_LESSON_AUTHOR";
  error: string;
  errorAr: string;
}

/** Why an editor cannot change a lesson that has left draft, by status. */
const LOCKED_STATUS: Record<string, LessonChangeDenial> = {
  published: {
    code: "LESSON_PUBLISHED",
    error: "This lesson is published, so only an admin can change it.",
    errorAr: "هذا الدرس منشور، لذا يستطيع المدير فقط تعديله.",
  },
  archived: {
    code: "LESSON_PUBLISHED",
    error: "This lesson is archived, so only an admin can change it.",
    errorAr: "هذا الدرس مؤرشف، لذا يستطيع المدير فقط تعديله.",
  },
  in_review: {
    code: "LESSON_IN_REVIEW",
    error: "This lesson is in review. It can be changed again once it is returned to draft.",
    errorAr: "هذا الدرس قيد المراجعة، ويمكن تعديله بعد إعادته إلى مسودة.",
  },
  approved: {
    code: "LESSON_IN_REVIEW",
    error: "This lesson has been approved, so only an admin can change it.",
    errorAr: "هذا الدرس معتمد، لذا يستطيع المدير فقط تعديله.",
  },
};

/**
 * Why this caller may not change this lesson, or null when they may.
 *
 * Whoever may publish (an admin) may change any lesson. A lesson editor may
 * change only lessons they created, and only while they are drafts: once
 * submitted, what the reviewer read is what gets approved and published, and
 * one editor cannot rewrite another's work. Reading is not restricted here;
 * this is only about changes. A lesson with no recorded author predates
 * authorship and is left to admins.
 */
export function lessonChangeDenial(
  caller: { role: string | undefined; userId: number | undefined },
  lesson: { status: string; createdBy: number | null },
): LessonChangeDenial | null {
  if (hasPermission(caller.role, "content.publish")) return null;
  const locked = LOCKED_STATUS[lesson.status];
  if (locked) return { ...locked };
  if (lesson.createdBy === null || lesson.createdBy !== caller.userId) {
    return {
      code: "NOT_LESSON_AUTHOR",
      error: "You can only change lessons you created.",
      errorAr: "يمكنك تعديل الدروس التي أنشأتها فقط.",
    };
  }
  return null;
}

export function isAssignableRole(role: string): role is UserRole {
  return roleDefinition(role)?.assignable === true;
}

/**
 * Whether the staff screen may change or remove an account holding `role`.
 *
 * A role this version no longer defines counts as manageable, so an account
 * left holding one (such as the retired content_reviewer) can still be moved
 * to a current role or have its access removed. It holds no permissions meanwhile.
 */
export function isManageableRole(role: string): boolean {
  const definition = roleDefinition(role);
  return definition ? definition.assignable : true;
}

/** The roles the staff screen offers, in the order they are defined above. */
export function assignableRoles() {
  return (Object.entries(ROLES) as [UserRole, RoleDefinition][])
    .filter(([, definition]) => definition.assignable)
    .map(([role, definition]) => ({
      role,
      label: definition.label,
      labelAr: definition.labelAr,
      description: definition.description,
      descriptionAr: definition.descriptionAr,
    }));
}
