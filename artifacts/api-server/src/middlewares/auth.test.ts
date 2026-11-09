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

import { isUnmeteredCaller } from "./auth";

const requestWith = (role: string | undefined) =>
  ({ session: { userId: 1, role } }) as unknown as Request;

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
