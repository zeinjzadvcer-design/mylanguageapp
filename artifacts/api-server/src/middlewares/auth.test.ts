import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<{ role: string }>, select: vi.fn() }));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  h.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => h.rows }) }),
  }));
  return { ...actual, db: { select: h.select } };
});

import { isUnmeteredCaller, requirePermission } from "./auth";

const requestWith = (role: string | undefined) =>
  ({ session: { userId: 1, role } }) as unknown as Request;

describe("requirePermission", () => {
  const run = async (req: Request, ...permissions: Parameters<typeof requirePermission>) => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    await requirePermission(...permissions)(req, res as never, next);
    return { status: res.status.mock.calls[0]?.[0], passed: next.mock.calls.length === 1 };
  };

  beforeEach(() => {
    h.rows = [];
  });

  it("answers 401 with no session", async () => {
    const result = await run({ session: {} } as unknown as Request, "content.view");
    expect(result).toEqual({ status: 401, passed: false });
  });

  it("answers 403 without the permission", async () => {
    h.rows = [{ role: "payments_manager" }];
    expect(await run(requestWith("payments_manager"), "content.view")).toEqual({ status: 403, passed: false });
  });

  it("passes with any one of the permissions", async () => {
    h.rows = [{ role: "content_manager" }];
    expect(await run(requestWith("content_manager"), "payments.review", "content.view")).toEqual({
      status: undefined,
      passed: true,
    });
  });

  it("goes by the database, not the role the session remembers", async () => {
    h.rows = [{ role: "student" }];
    expect(await run(requestWith("admin"), "staff.manage")).toEqual({ status: 403, passed: false });
  });
});

describe("isUnmeteredCaller", () => {
  beforeEach(() => {
    h.select.mockClear();
    h.rows = [];
  });

  it("answers for a student without touching the database", async () => {
    await expect(isUnmeteredCaller(requestWith("student"))).resolves.toBe(false);
    expect(h.select).not.toHaveBeenCalled();
  });

  it("confirms staff against the database", async () => {
    h.rows = [{ role: "admin" }];
    await expect(isUnmeteredCaller(requestWith("admin"))).resolves.toBe(true);
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it("does not exempt someone demoted since they signed in", async () => {
    h.rows = [{ role: "student" }];
    await expect(isUnmeteredCaller(requestWith("admin"))).resolves.toBe(false);
  });
});
