/**
 * The signed-in user's own notifications. Every query is scoped to the session's
 * user id, so one account can never read or mark another's.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth";
import {
  getReminderSetting,
  listNotifications,
  markAllRead,
  markRead,
  setReminderSetting,
  unreadCount,
} from "../services/notifications";
import { validate } from "../lib/validate";

const router: IRouter = Router();

router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "30"), 10) || 30));
  const { items, unread } = await listNotifications(req.session.userId!, limit);
  res.json({
    items: items.map((n) => ({
      ...n,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    unread,
  });
});

/** For the badge, polled; cheaper than the list. */
router.get("/notifications/unread-count", requireAuth, async (req, res): Promise<void> => {
  res.json({ unread: await unreadCount(req.session.userId!) });
});

router.post("/notifications/read-all", requireAuth, async (req, res): Promise<void> => {
  await markAllRead(req.session.userId!);
  res.json({ success: true });
});

router.post("/notifications/:id/read", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid notification id" });
    return;
  }
  // Someone else's id answers like a missing one.
  if (!(await markRead(req.session.userId!, id))) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  res.json({ success: true });
});

router.get("/notifications/settings", requireAuth, async (req, res): Promise<void> => {
  res.json({ lessonReminders: await getReminderSetting(req.session.userId!) });
});

const settingsSchema = z.object({ lessonReminders: z.boolean() });

router.put("/notifications/settings", requireAuth, async (req, res): Promise<void> => {
  const body = validate(res, settingsSchema, req.body);
  if (!body) return;
  if (!(await setReminderSetting(req.session.userId!, body.lessonReminders))) {
    res.status(404).json({ error: "This account has no student profile to remind" });
    return;
  }
  res.json({ lessonReminders: body.lessonReminders });
});

export default router;
