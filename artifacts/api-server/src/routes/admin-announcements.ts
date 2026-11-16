/**
 * Announcements to students, admin only.
 *
 * Preview first, then send: the screen shows how many students an audience
 * reaches before anything goes out, because a notification cannot be unsent.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { requirePermission } from "../middlewares/auth";
import {
  audiencePlans,
  countRecipients,
  listAnnouncements,
  sendAnnouncement,
} from "../services/announcements";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const guard = requirePermission("announcements.send");

const audienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({
    kind: z.literal("plans"),
    planCodes: z.array(z.string().min(1).max(60)).min(1, "Choose at least one plan").max(20),
  }),
]);

/** Blank becomes null, so an untranslated field is simply absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const announcementSchema = z
  .object({
    title: optionalText(120),
    titleAr: optionalText(120),
    body: optionalText(1000),
    bodyAr: optionalText(1000),
    /**
     * A path inside the app only. An outside address would let an announcement
     * send students anywhere under the app's name.
     */
    link: z
      .string()
      .trim()
      .max(300)
      .regex(/^\/(?!\/)[^\s]*$/, "The link must be a page in the app, starting with /")
      .nullish()
      .transform((v) => v || null),
    audience: audienceSchema,
  })
  .refine((v) => v.title || v.titleAr, { message: "Write a title", path: ["title"] })
  .refine((v) => v.body || v.bodyAr, { message: "Write a message", path: ["body"] });

router.get("/admin/announcements", guard, async (_req, res): Promise<void> => {
  const [items, plans] = await Promise.all([listAnnouncements(), audiencePlans()]);
  res.json({ items, plans });
});

router.post("/admin/announcements/preview", guard, async (req, res): Promise<void> => {
  const parsed = z.object({ audience: audienceSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid audience" });
    return;
  }
  res.json({ recipients: await countRecipients(parsed.data.audience) });
});

router.post("/admin/announcements", guard, async (req, res): Promise<void> => {
  const parsed = announcementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid announcement" });
    return;
  }

  const result = await sendAnnouncement(parsed.data, req.session.userId!);
  logger.info(
    { by: req.session.userId, announcementId: result.id, recipients: result.recipients, audience: parsed.data.audience },
    "Announcement sent",
  );
  res.status(201).json(result);
});

export default router;
