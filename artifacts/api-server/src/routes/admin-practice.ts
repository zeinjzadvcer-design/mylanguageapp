/**
 * Voice practice settings, admin only.
 *
 * Kept in the database rather than the environment so that changing how many
 * calls the site carries at once needs no deploy.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAdmin } from "../middlewares/auth";
import {
  countLiveCalls,
  getMaxConcurrentCalls,
  setMaxConcurrentCalls,
} from "../services/practice";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/admin/practice/settings", requireAdmin, async (_req, res): Promise<void> => {
  const [maxConcurrentCalls, liveCalls] = await Promise.all([
    getMaxConcurrentCalls(),
    countLiveCalls(),
  ]);
  res.json({ maxConcurrentCalls, liveCalls });
});

const settingsSchema = z.object({
  /** Null removes the limit. */
  maxConcurrentCalls: z.number().int().min(1).max(100_000).nullable(),
});

router.patch("/admin/practice/settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }

  await setMaxConcurrentCalls(parsed.data.maxConcurrentCalls);
  logger.info({ by: req.session.userId, ...parsed.data }, "Concurrent call limit changed");
  res.json(parsed.data);
});

export default router;
