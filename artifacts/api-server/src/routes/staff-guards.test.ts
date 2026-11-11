import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules that keep staff inside their role, exercised through the real
 * routes and guards. Each entry in `results` answers one database lookup, in
 * order; the first is always the guard reading the caller's current role.
 */
const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  update: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  activate: vi.fn(),
  query: vi.fn(),
  session: null as { userId: number; role: string } | null,
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const limit = async () => h.results.shift() ?? [];
  const select = () => ({
    from: () => ({ where: () => ({ limit, orderBy: () => ({ limit }) }) }),
  });
  const db = {
    select,
    update: h.update,
    insert: h.insert,
    // The callback gets the same fake, so writes inside a transaction are
    // seen by the same mocks as writes outside one.
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return {
    ...actual,
    db,
    pool: { query: h.query },
  };
});
vi.mock("../services/session-store", () => ({ destroyUserSessions: vi.fn() }));
vi.mock("../services/subscription-activation", () => ({
  activateSubscription: h.activate,
  rejectSubmission: vi.fn(),
}));

import staffRouter from "./admin-staff";
import paymentsRouter from "./admin-payments";
import subscriptionsRouter from "./subscriptions";
import gradingRouter from "./cms/grading";
import cmsMediaRouter from "./cms/media";
import { resolvePlanCode } from "../services/ai-quota";
import { destroyUserSessions } from "../services/session-store";
import { hashPassword } from "../lib/password";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = h.session ? { ...h.session } : {};
    next();
  });
  app.use(staffRouter, paymentsRouter, subscriptionsRouter, gradingRouter, cmsMediaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  h.results = [];
  h.session = null;
  h.update.mockReset();
  h.update.mockReturnValue({
    set: () => ({ where: () => ({ returning: async () => [{}] }) }),
  });
  h.insert.mockReset();
  h.values.mockReset();
  h.values.mockReturnValue({ onConflictDoNothing: async () => undefined });
  h.insert.mockReturnValue({ values: h.values });
  h.query.mockReset();
  vi.mocked(destroyUserSessions).mockClear();
  h.activate.mockReset();
  h.activate.mockResolvedValue({ ok: true, subscriptionId: 1, alreadyActive: false });
});

/** Act as `role`; `lookups` answer whatever the route reads after the guard. */
function signIn(role: string, userId: number, ...lookups: unknown[][]) {
  h.session = { userId, role };
  h.results = [[{ role }], ...lookups];
}

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as { code?: string } };
}

describe("staff management", () => {
  it("refuses anyone not signed in", async () => {
    expect((await call("GET", "/admin/staff")).status).toBe(401);
  });

  it.each(["content_manager", "payments_manager", "student"])(
    "refuses %s",
    async (role) => {
      signIn(role, 2);
      expect((await call("GET", "/admin/staff")).status).toBe(403);
    },
  );

  it.each(["admin", "student", "constructor"])("will not create a %s here", async (role) => {
    signIn("admin", 1);
    const r = await call("POST", "/admin/staff", {
      name: "X",
      email: "x@example.test",
      role,
      password: "Longenough1",
    });
    expect(r.status).toBe(400);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("will not change an administrator", async () => {
    signIn("admin", 1, [{ id: 9, role: "admin" }]);
    const r = await call("POST", "/admin/staff/9/revoke");
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("NOT_EDITABLE");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("can still remove an account left on the retired reviewer role", async () => {
    signIn("admin", 1, [{ id: 9, role: "content_reviewer" }]);
    h.insert.mockReturnValue({ values: () => ({ onConflictDoNothing: async () => undefined }) });
    expect((await call("POST", "/admin/staff/9/revoke")).status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("will not reset an administrator's password", async () => {
    signIn("admin", 1, [{ id: 9, role: "admin" }]);
    const r = await call("POST", "/admin/staff/9/password", { password: "Longenough1" });
    expect(r.status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("will not let you change your own access", async () => {
    signIn("admin", 1);
    const r = await call("PATCH", "/admin/staff/1", { role: "content_manager" });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("SELF");
  });
});

describe("staff changes take effect", () => {
  it("setting a password ends sessions and retires emailed reset links", async () => {
    signIn("admin", 1, [{ id: 9, role: "content_manager" }]);
    const r = await call("POST", "/admin/staff/9/password", { password: "Longenough1" });
    expect(r.status).toBe(200);
    // The password itself, then the outstanding reset tokens.
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(vi.mocked(destroyUserSessions).mock.calls[0]?.[1]).toBe(9);
  });

  it("revoking gives the account a student profile and ends its sessions", async () => {
    signIn("admin", 1, [{ id: 9, role: "content_manager" }], []);
    expect((await call("POST", "/admin/staff/9/revoke")).status).toBe(200);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(destroyUserSessions).mock.calls[0]?.[1]).toBe(9);
  });
});

describe("CMS media is curriculum only", () => {
  const CURRICULUM = "owner_user_id IS NULL AND purpose = 'curriculum'";

  it("lists only curriculum material", async () => {
    signIn("content_manager", 2);
    h.query.mockResolvedValue({ rows: [{ count: "0" }], rowCount: 0 });
    expect((await call("GET", "/cms/media")).status).toBe(200);
    for (const [sql] of h.query.mock.calls) expect(sql).toContain(CURRICULUM);
  });

  it.each([
    "payments/receipt/7/1700000000000-ab12cd34.jpg",
    "recordings/7/2026-11/0b6c.webm",
    "curriculum/../payments/receipt/7/x.jpg",
  ])("will not register the private key %s", async (key) => {
    signIn("content_manager", 2);
    const r = await call("POST", "/cms/media", { key, mimeType: "image/jpeg" });
    expect(r.status).toBe(400);
    expect(r.data.code).toBe("INVALID_KEY");
    expect(h.query).not.toHaveBeenCalled();
  });

  it("will not register a key that is already in use", async () => {
    signIn("content_manager", 2);
    h.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    const r = await call("POST", "/cms/media", { key: "audio/a.mp3", mimeType: "audio/mpeg" });
    expect(r.status).toBe(409);
  });

  it("registers a new curriculum key", async () => {
    signIn("content_manager", 2);
    h.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const r = await call("POST", "/cms/media", { key: "audio/a.mp3", mimeType: "audio/mpeg" });
    expect(r.status).toBe(201);
  });

  it("will not delete anything that is not curriculum material", async () => {
    signIn("content_manager", 2);
    h.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await call("DELETE", "/cms/media/3")).status).toBe(404);
    expect(h.query.mock.calls[0][0]).toContain(CURRICULUM);
  });

  it("is closed to payments staff", async () => {
    signIn("payments_manager", 2);
    expect((await call("GET", "/cms/media")).status).toBe(403);
  });
});

describe("marking", () => {
  it.each(["content_manager", "payments_manager", "student"])(
    "is closed to %s",
    async (role) => {
      signIn(role, 2);
      expect((await call("GET", "/cms/grading/queue")).status).toBe(403);
      signIn(role, 2);
      expect((await call("POST", "/cms/grading/sweep", {})).status).toBe(403);
    },
  );
});

describe("plans are for students", () => {
  it.each(["admin", "content_manager", "payments_manager"])(
    "will not start a plan for %s",
    async (role) => {
      signIn(role, 2);
      expect((await call("POST", "/subscription", {})).status).toBe(403);
    },
  );

  it("lets a student through to validation", async () => {
    signIn("student", 2);
    expect((await call("POST", "/subscription", {})).status).toBe(400);
  });
});

describe("the AI plan staff are held to", () => {
  it.each(["admin", "content_manager"])("gives %s the admin limits", async (role) => {
    h.results = [[{ role }]];
    await expect(resolvePlanCode(1)).resolves.toBe("admin");
  });

  it("leaves payments staff on the plan they hold", async () => {
    h.results = [[{ role: "payments_manager" }], []];
    await expect(resolvePlanCode(1)).resolves.toBe("free");
  });
});

describe("payment settings", () => {
  it.each([
    ["walletQrMediaId", null],
    ["walletAccountName", "x"],
    ["walletAccountNumber", "x"],
    ["walletInstructionsAr", "x"],
    ["walletMerchantPhone", "x"],
    ["cryptoWalletAddress", null],
    ["cryptoQrMediaId", null],
  ])("keeps %s from payments staff", async (field, value) => {
    signIn("payments_manager", 2);
    const r = await call("PATCH", "/admin/payment-settings", { [field]: value });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("PAYMENT_SETTING_FORBIDDEN");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses a save that mixes pricing with a restricted field", async () => {
    signIn("payments_manager", 2);
    const r = await call("PATCH", "/admin/payment-settings", {
      sypRateAuto: false,
      walletAccountNumber: "x",
    });
    expect(r.status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("lets payments staff change pricing", async () => {
    signIn("payments_manager", 2);
    expect((await call("PATCH", "/admin/payment-settings", { sypRateAuto: false })).status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("keeps the SMS token from payments staff", async () => {
    signIn("payments_manager", 2);
    expect((await call("POST", "/admin/payment-settings/ingest-token")).status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("does not show payments staff the crypto wallet at all", async () => {
    signIn("payments_manager", 2, [
      { cryptoWalletAddress: WALLET, cryptoQrMediaId: 9, cryptoUpdatedBy: 1, cryptoUpdatedAt: new Date() },
    ]);
    const r = await call("GET", "/admin/payment-settings");
    expect(r.status).toBe(200);
    const body = r.data as Record<string, unknown>;
    expect(body.cryptoWalletAddress).toBeNull();
    expect(body.cryptoQrMediaId).toBeNull();
    expect(body.cryptoUpdatedAt).toBeNull();
    expect(body.cryptoUpdatedByName).toBeNull();
  });

  it("shows an administrator the crypto wallet", async () => {
    signIn("admin", 1, [{ cryptoWalletAddress: WALLET, cryptoUpdatedBy: 1 }], [{ name: "Boss" }]);
    const r = await call("GET", "/admin/payment-settings");
    const body = r.data as Record<string, unknown>;
    expect(body.cryptoWalletAddress).toBe(WALLET);
    expect(body.cryptoUpdatedByName).toBe("Boss");
  });

  it("keeps the change history from payments staff", async () => {
    signIn("payments_manager", 2);
    expect((await call("GET", "/admin/payment-settings/history")).status).toBe(403);
  });
});

const WALLET = "0x" + "ab".repeat(20);

describe("changing the crypto wallet", () => {
  let passwordHash = "";
  beforeAll(async () => {
    passwordHash = await hashPassword("right-password");
  });

  it.each([
    ["cryptoWalletAddress", WALLET],
    ["cryptoWalletAddress", null],
    ["cryptoQrMediaId", null],
  ])("asks an administrator for their password to change %s", async (field, value) => {
    signIn("admin", 1, [{ passwordHash }]);
    const r = await call("PATCH", "/admin/payment-settings", { [field]: value });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("PASSWORD_REQUIRED");
    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses the wrong password", async () => {
    signIn("admin", 1, [{ passwordHash }]);
    const r = await call("PATCH", "/admin/payment-settings", {
      cryptoWalletAddress: WALLET,
      currentPassword: "wrong-password",
    });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("WRONG_PASSWORD");
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("saves with the right password, and records the change without the address", async () => {
    signIn(
      "admin",
      1,
      [{ passwordHash }],
      [{ cryptoWalletAddress: "0x" + "cd".repeat(20) }],
      [{ cryptoWalletAddress: WALLET }],
    );
    const r = await call("PATCH", "/admin/payment-settings", {
      cryptoWalletAddress: WALLET,
      currentPassword: "right-password",
    });
    expect(r.status).toBe(200);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.values).toHaveBeenCalledTimes(1);
    const entry = h.values.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      userId: 1,
      action: "settings",
      changes: [{ field: "cryptoWalletAddress", change: "changed" }],
    });
    expect(JSON.stringify(entry)).not.toMatch(/abab|cdcd/);
  });

  it("needs no password for pricing", async () => {
    signIn("admin", 1, [{ sypRateAuto: true }], [{}]);
    const r = await call("PATCH", "/admin/payment-settings", { sypRateAuto: false });
    expect(r.status).toBe(200);
    expect(h.values.mock.calls[0][0]).toMatchObject({
      action: "settings",
      changes: [{ field: "sypRateAuto", change: "changed" }],
    });
  });

  it("records nothing when a save changes nothing", async () => {
    signIn("admin", 1, [{ sypRateAuto: false }], [{}]);
    expect((await call("PATCH", "/admin/payment-settings", { sypRateAuto: false })).status).toBe(200);
    expect(h.values).not.toHaveBeenCalled();
  });
});

describe("approving a payment", () => {
  it("refuses payments staff their own", async () => {
    signIn("payments_manager", 5, [{ userId: 5 }]);
    const r = await call("POST", "/admin/payment-submissions/1/approve", {});
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("SELF_APPROVAL");
    expect(h.activate).not.toHaveBeenCalled();
  });

  it("lets payments staff approve someone else's", async () => {
    signIn("payments_manager", 5, [{ userId: 6 }]);
    expect((await call("POST", "/admin/payment-submissions/1/approve", {})).status).toBe(200);
    expect(h.activate).toHaveBeenCalledTimes(1);
  });

  it("lets an administrator approve their own", async () => {
    signIn("admin", 1, [{ userId: 1 }]);
    expect((await call("POST", "/admin/payment-submissions/1/approve", {})).status).toBe(200);
  });
});
