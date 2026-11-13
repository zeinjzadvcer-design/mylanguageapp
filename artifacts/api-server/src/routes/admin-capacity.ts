/**
 * Site capacity, admin only: how many voice calls and how many students in
 * lessons the site takes at once, and how busy it is now.
 *
 * The call limit is still changed through /admin/practice/settings; this
 * gathers both for the one screen that sets them.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { requirePermission } from "../middlewares/auth";
import { countLiveCalls, getMaxConcurrentCalls } from "../services/practice";
import { lessonCapacityStatus, setMaxActiveLearners } from "../services/lesson-load";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/admin/capacity", requirePermission("settings.manage"), async (_req, res): Promise<void> => {
  const [maxConcurrentCalls, liveCalls, lessons] = await Promise.all([
    getMaxConcurrentCalls(),
    countLiveCalls(),
    lessonCapacityStatus(),
  ]);
  res.json({ calls: { maxConcurrentCalls, liveCalls }, lessons });
});

const lessonsSchema = z.object({
  /** Null removes the limit. */
  maxActiveLearners: z.number().int().min(1).max(1_000_000).nullable(),
});

router.patch("/admin/capacity/lessons", requirePermission("settings.manage"), async (req, res): Promise<void> => {
  const parsed = lessonsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "maxActiveLearners must be a whole number of at least 1, or null" });
    return;
  }
  await setMaxActiveLearners(parsed.data.maxActiveLearners);
  logger.info({ by: req.session.userId, ...parsed.data }, "Lesson capacity limit changed");
  res.json(await lessonCapacityStatus());
});

export default router;
