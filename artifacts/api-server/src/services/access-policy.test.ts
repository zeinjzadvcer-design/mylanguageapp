import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLES,
  assignableRoles,
  canChangePaymentSetting,
  hasPermission,
  isAssignableRole,
  isManageableRole,
  permissionsOf,
  type Permission,
} from "./access-policy";

/** Everything each staff role may do. A change here is a change of who can do what. */
const EXPECTED: Record<string, Permission[]> = {
  content_manager: ["content.view", "content.edit"],
  payments_manager: ["payments.review", "payments.settings"],
};

describe("role definitions", () => {
  it("gives an administrator every permission", () => {
    expect([...permissionsOf("admin")].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("gives a student none", () => {
    expect(permissionsOf("student")).toEqual([]);
  });

  it.each(Object.entries(EXPECTED))("gives %s exactly its permissions", (role, permissions) => {
    expect([...permissionsOf(role)].sort()).toEqual([...permissions].sort());
  });

  it("keeps content staff out of payments, students, settings and staff", () => {
    for (const role of ["content_manager"]) {
      for (const permission of [
        "payments.review",
        "payments.settings",
        "students.manage",
        "settings.manage",
        "staff.manage",
        "catalog.manage",
        "content.publish",
      ] as const) {
        expect(hasPermission(role, permission)).toBe(false);
      }
    }
  });

  it("keeps payments staff out of content, and off the unmetered list", () => {
    expect(hasPermission("payments_manager", "content.view")).toBe(false);
    expect(hasPermission("payments_manager", "students.manage")).toBe(false);
    expect(ROLES.payments_manager.unmetered).toBe(false);
    expect(ROLES.payments_manager.usesStudentApp).toBe(false);
  });
});

describe("payment settings", () => {
  const PRICING = ["sypRateAuto", "sypUnit"];
  const RECEIVING = [
    "walletQrMediaId",
    "walletAccountName",
    "walletAccountNumber",
    "walletInstructionsAr",
    "walletMerchantPhone",
    "cryptoWalletAddress",
    "cryptoQrMediaId",
  ];

  it("lets payments staff change pricing", () => {
    for (const field of PRICING) {
      expect(canChangePaymentSetting("payments_manager", field)).toBe(true);
    }
  });

  it("keeps where the money goes away from payments staff", () => {
    for (const field of RECEIVING) {
      expect(canChangePaymentSetting("payments_manager", field)).toBe(false);
    }
    expect(hasPermission("payments_manager", "payments.sms_token")).toBe(false);
  });

  it("lets an administrator change all of it", () => {
    for (const field of [...PRICING, ...RECEIVING]) {
      expect(canChangePaymentSetting("admin", field)).toBe(true);
    }
    expect(hasPermission("admin", "payments.sms_token")).toBe(true);
  });

  it("refuses a field nobody has been given", () => {
    expect(canChangePaymentSetting("admin", "somethingNew")).toBe(false);
    expect(canChangePaymentSetting("admin", "constructor")).toBe(false);
  });
});

describe("unknown roles fail closed", () => {
  it.each([undefined, "", "superuser", "constructor", "__proto__"])("%s holds nothing", (role) => {
    expect(permissionsOf(role)).toEqual([]);
    expect(hasPermission(role, "content.view")).toBe(false);
  });
});

describe("handing out roles", () => {
  it("never offers admin or student", () => {
    expect(isAssignableRole("admin")).toBe(false);
    expect(isAssignableRole("student")).toBe(false);
    expect(assignableRoles().map((r) => r.role)).not.toContain("admin");
  });

  it("offers each staff role, labelled in both languages", () => {
    const offered = assignableRoles();
    expect(offered.map((r) => r.role).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const role of offered) {
      expect(role.label).toBeTruthy();
      expect(role.labelAr).toBeTruthy();
      expect(role.descriptionAr).toBeTruthy();
    }
  });

  it("lets an account on a retired role be moved, but never an admin", () => {
    expect(isManageableRole("content_reviewer")).toBe(true);
    expect(permissionsOf("content_reviewer")).toEqual([]);
    expect(isManageableRole("admin")).toBe(false);
    expect(isManageableRole("student")).toBe(false);
  });

  it("refuses names that are not roles", () => {
    expect(isAssignableRole("constructor")).toBe(false);
    expect(isAssignableRole("")).toBe(false);
  });
});
