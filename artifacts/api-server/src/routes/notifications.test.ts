import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The notification routes, with the service replaced: what is checked here is
 * that every call is scoped to the signed-in user and that input is validated.
 * The service's SQL is covered by notifications.db.test.ts against a database.
 */
const h = vi.hoisted(() => ({
  session: null as { userId: number; role: string } | null,
  list: vi.fn(),
  unread: vi.fn(),
  markRead: vi.fn(),
  markAll: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../services/notifications", () => ({
  listNotifications: h.list,
  unreadCount: h.unread,
  markRead: h.markRead,
  markAllRead: h.markAll,
  getReminderSetting: h.getSetting,
  setReminderSetting: h.setSetting,
}));

import router from "./notifications";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = h.session ? { ...h.session } : {};
    next();
  });
  app.use(router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  h.session = { userId: 7, role: "student" };
  for (const fn of [h.list, h.unread, h.markRead, h.markAll, h.getSetting, h.setSetting]) fn.mockReset();
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json()) as { items: Array<{ createdAt: string }> } };
}

describe("notification routes", () => {
  it.each([
    ["GET", "/notifications"],
    ["GET", "/notifications/unread-count"],
    ["POST", "/notifications/read-all"],
    ["POST", "/notifications/1/read"],
    ["GET", "/notifications/settings"],
    ["PUT", "/notifications/settings"],
  ])("refuses %s %s when signed out", async (method, path) => {
    h.session = null;
    expect((await call(method, path, method === "PUT" ? { lessonReminders: true } : undefined)).status).toBe(401);
  });

  it("lists the caller's own notifications, with the limit capped", async () => {
    const createdAt = new Date("2026-11-13T10:00:00Z");
    h.list.mockResolvedValue({
      items: [{ id: 1, kind: "quiz_available", data: {}, link: "/quizzes", readAt: null, createdAt }],
      unread: 1,
    });
    const r = await call("GET", "/notifications?limit=500");
    expect(r.status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(7, 100);
    expect(r.data.items[0].createdAt).toBe(createdAt.toISOString());
  });

  it("marks only the caller's own notification read", async () => {
    h.markRead.mockResolvedValue(true);
    expect((await call("POST", "/notifications/5/read")).status).toBe(200);
    expect(h.markRead).toHaveBeenCalledWith(7, 5);
  });

  it("answers 404 for a notification that is not the caller's", async () => {
    h.markRead.mockResolvedValue(false);
    expect((await call("POST", "/notifications/5/read")).status).toBe(404);
  });

  it("refuses an id that is not a number", async () => {
    expect((await call("POST", "/notifications/abc/read")).status).toBe(400);
    expect(h.markRead).not.toHaveBeenCalled();
  });

  it("marks all of the caller's notifications read", async () => {
    expect((await call("POST", "/notifications/read-all")).status).toBe(200);
    expect(h.markAll).toHaveBeenCalledWith(7);
  });

  it("refuses a setting that is not true or false", async () => {
    expect((await call("PUT", "/notifications/settings", { lessonReminders: "yes" })).status).toBe(400);
    expect(h.setSetting).not.toHaveBeenCalled();
  });

  it("saves the caller's own setting", async () => {
    h.setSetting.mockResolvedValue(true);
    const r = await call("PUT", "/notifications/settings", { lessonReminders: false });
    expect(r.status).toBe(200);
    expect(h.setSetting).toHaveBeenCalledWith(7, false);
  });

  it("answers 404 for an account with no student profile", async () => {
    h.setSetting.mockResolvedValue(false);
    expect((await call("PUT", "/notifications/settings", { lessonReminders: false })).status).toBe(404);
  });
});
