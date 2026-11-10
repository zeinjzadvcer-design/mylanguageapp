/**
 * The voice-practice report queue: the only place a complaint about another
 * student is answered.
 *
 * WHAT AN ADMINISTRATOR CAN AND CANNOT SEE
 * ─────────────────────────────────────────
 * Practice calls are peer-to-peer and are not recorded, so there is no audio to
 * listen to and there never will be for a call that has already happened. What
 * this queue shows is everything that *is* known: who reported whom, when, how
 * long the call lasted, how it ended, and how many other reports the same
 * student has. That is enough to spot a pattern and not enough to adjudicate a
 * single he-said-she-said — and the screen says so, because an administrator
 * who thinks they have evidence they do not have will act with false
 * confidence.
 *
 * Nothing here happens automatically. Reports do not suspend accounts by
 * threshold: two people can be wrong about the same third person, and an
 * account closed by a script has nobody to appeal to.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  usersTable,
  practiceReportsTable,
  practiceSessionsTable,
  practiceBlocksTable,
} from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { audit } from "../../services/cms-audit";

const router: IRouter = Router();

// ─── The queue ────────────────────────────────────────────────────────────────

/**
 * Open reports, oldest first.
 *
 * Oldest first because a student who reported someone three days ago has been
 * waiting three days, and because a report answered late is a student who
 * stopped using the feature.
 */
router.get("/cms/practice/reports", requirePermission("practice_reports.manage"), async (req, res): Promise<void> => {
  const requested = (req.query.status as string) ?? "open";
  const status: "open" | "reviewed" | "actioned" | "all" =
    requested === "reviewed" || requested === "actioned" || requested === "all"
      ? requested
      : "open";
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10)));

  const reporter = alias(usersTable, "reporter_user");
  const reported = alias(usersTable, "reported_user");
  const reviewer = alias(usersTable, "reviewer_user");

  const items = await db
    .select({
      id: practiceReportsTable.id,
      reason: practiceReportsTable.reason,
      detail: practiceReportsTable.detail,
      status: practiceReportsTable.status,
      createdAt: practiceReportsTable.createdAt,
      reviewedAt: practiceReportsTable.reviewedAt,
      reviewNote: practiceReportsTable.reviewNote,
      reviewerName: reviewer.name,

      reporterId: reporter.id,
      reporterName: reporter.name,
      reportedId: reported.id,
      reportedName: reported.name,
      reportedEmail: reported.email,

      sessionId: practiceSessionsTable.id,
      sessionStartedAt: practiceSessionsTable.startedAt,
      sessionDurationSeconds: practiceSessionsTable.durationSeconds,
      sessionEndReason: practiceSessionsTable.endReason,
    })
    .from(practiceReportsTable)
    .innerJoin(reporter, eq(reporter.id, practiceReportsTable.reporterId))
    .innerJoin(reported, eq(reported.id, practiceReportsTable.reportedId))
    .leftJoin(reviewer, eq(reviewer.id, practiceReportsTable.reviewedBy))
    .leftJoin(
      practiceSessionsTable,
      eq(practiceSessionsTable.id, practiceReportsTable.sessionId),
    )
    .where(status === "all" ? sql`TRUE` : eq(practiceReportsTable.status, status))
    .orderBy(desc(practiceReportsTable.status), practiceReportsTable.createdAt)
    .limit(limit);

  // A single report says little; the same name three times says a lot. Counted
  // in one grouped query rather than one query per row.
  const reportedIds = [...new Set(items.map((i) => i.reportedId))];
  const priors = reportedIds.length
    ? await db
        .select({
          reportedId: practiceReportsTable.reportedId,
          total: sql<number>`count(*)::int`,
        })
        .from(practiceReportsTable)
        .where(inArray(practiceReportsTable.reportedId, reportedIds))
        .groupBy(practiceReportsTable.reportedId)
    : [];

  const blockCounts = reportedIds.length
    ? await db
        .select({
          blockedId: practiceBlocksTable.blockedId,
          blocks: sql<number>`count(*)::int`,
        })
        .from(practiceBlocksTable)
        .where(inArray(practiceBlocksTable.blockedId, reportedIds))
        .groupBy(practiceBlocksTable.blockedId)
    : [];

  const priorByUser = new Map(priors.map((p) => [p.reportedId, p.total]));
  const blocksByUser = new Map(blockCounts.map((b) => [b.blockedId, b.blocks]));

  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(practiceReportsTable)
    .where(eq(practiceReportsTable.status, "open"));

  res.json({
    items: items.map((i) => ({
      ...i,
      totalReportsAgainst: priorByUser.get(i.reportedId) ?? 1,
      totalBlocksAgainst: blocksByUser.get(i.reportedId) ?? 0,
    })),
    counts: { open },
    // Stated in the payload, not only in the UI copy, so any other client that
    // grows on top of this endpoint inherits the caveat rather than inventing
    // a confident one.
    evidenceNote:
      "Practice calls are peer-to-peer and are not recorded. There is no audio for any report.",
  });
});

// ─── Deciding ─────────────────────────────────────────────────────────────────

const reviewSchema = z.object({
  /** reviewed = looked at, nothing to do. actioned = looked at and acted on. */
  status: z.enum(["reviewed", "actioned"]),
  note: z.string().max(2000).optional(),
});

router.post(
  "/cms/practice/reports/:id/review",
  requirePermission("practice_reports.manage"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid report id" });
      return;
    }

    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
      return;
    }

    const [before] = await db
      .select({ status: practiceReportsTable.status })
      .from(practiceReportsTable)
      .where(eq(practiceReportsTable.id, id))
      .limit(1);

    if (!before) {
      res.status(404).json({ error: "Report not found", code: "NOT_FOUND" });
      return;
    }

    const [updated] = await db
      .update(practiceReportsTable)
      .set({
        status: parsed.data.status,
        reviewedBy: req.session.userId!,
        reviewedAt: new Date(),
        reviewNote: parsed.data.note ?? null,
      })
      .where(eq(practiceReportsTable.id, id))
      .returning();

    await audit(
      req.session.userId!,
      "practice_report_review",
      "practice_report",
      id,
      before.status,
      parsed.data.status,
      { note: parsed.data.note ?? null },
    );

    res.json({ report: updated });
  },
);

/** Everything known about one student's practice history, for a hard decision. */
router.get(
  "/cms/practice/students/:id",
  requirePermission("practice_reports.manage"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }

    const reporter = alias(usersTable, "reporter_user");

    const reports = await db
      .select({
        id: practiceReportsTable.id,
        reason: practiceReportsTable.reason,
        detail: practiceReportsTable.detail,
        status: practiceReportsTable.status,
        createdAt: practiceReportsTable.createdAt,
        reporterName: reporter.name,
      })
      .from(practiceReportsTable)
      .innerJoin(reporter, eq(reporter.id, practiceReportsTable.reporterId))
      .where(eq(practiceReportsTable.reportedId, id))
      .orderBy(desc(practiceReportsTable.createdAt))
      .limit(50);

    const [{ blocks }] = await db
      .select({ blocks: sql<number>`count(*)::int` })
      .from(practiceBlocksTable)
      .where(eq(practiceBlocksTable.blockedId, id));

    const [{ calls }] = await db
      .select({ calls: sql<number>`count(*)::int` })
      .from(practiceSessionsTable)
      .where(
        and(
          sql`(${practiceSessionsTable.requesterId} = ${id} OR ${practiceSessionsTable.partnerId} = ${id})`,
          eq(practiceSessionsTable.status, "ended"),
        ),
      );

    res.json({ reports, blocks, calls });
  },
);

export default router;
