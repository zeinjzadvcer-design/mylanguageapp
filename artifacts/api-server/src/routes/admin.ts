import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import {
  db, usersTable, studentSubscriptionsTable, lessonProgressTable, subscriptionPlansTable,
  lessonsTable, levelsTable, studentProfilesTable, placementResultsTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/auth";
import { invalidate, invalidatePrefix, CK } from "../services/cache";
import { setStudentLevel, getProgressionHistory } from "../services/progression";

const router: IRouter = Router();

router.get("/admin/stats", requirePermission("students.manage"), async (req, res): Promise<void> => {
  // Counted in the database. This loaded every user and every progress row
  // into memory to count them, which grows with every student and every lesson
  // they take.
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [[studentCounts], [subscriptionCounts], [progressCounts]] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        newThisWeek: sql<number>`count(*) filter (where ${usersTable.createdAt} >= ${weekAgo})::int`,
      })
      .from(usersTable)
      .where(eq(usersTable.role, "student")),
    // Counted by track, not by plan code. These matched the literal codes
    // "general_english" / "professional_english" and silently fell to zero when
    // the plans became general_basic/general_plus and pro_basic/pro_plus. A
    // plan's track is what "general" and "professional" actually mean, and it
    // survives the next plan being added or renamed.
    db
      .select({
        total: sql<number>`count(*)::int`,
        general: sql<number>`count(*) filter (where ${subscriptionPlansTable.lessonTrack} = 'general')::int`,
        professional: sql<number>`count(*) filter (where ${subscriptionPlansTable.lessonTrack} = 'professional')::int`,
      })
      .from(studentSubscriptionsTable)
      .leftJoin(
        subscriptionPlansTable,
        sql`${subscriptionPlansTable.code} = ${studentSubscriptionsTable.planCode}`,
      )
      .where(eq(studentSubscriptionsTable.status, "active")),
    db
      .select({
        passed: sql<number>`count(*) filter (where ${lessonProgressTable.passed})::int`,
        avgScore: sql<number | null>`avg(${lessonProgressTable.bestScore})::float`,
      })
      .from(lessonProgressTable),
  ]);

  const generalCount = subscriptionCounts?.general ?? 0;
  const proCount = subscriptionCounts?.professional ?? 0;
  const newStudents = studentCounts?.newThisWeek ?? 0;
  const passedCount = progressCounts?.passed ?? 0;
  const avgScore = progressCounts?.avgScore ?? 0;

  res.json({
    totalStudents: studentCounts?.total ?? 0,
    activeSubscriptions: subscriptionCounts?.total ?? 0,
    lessonsCompleted: passedCount,
    avgScore: Math.round(avgScore * 10) / 10,
    generalPlanCount: generalCount,
    professionalPlanCount: proCount,
    newStudentsThisWeek: newStudents,
  });
});

router.get("/admin/students", requirePermission("students.manage"), async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "20", 10)));
  const offset = (page - 1) * limit;

  const referralSource = (req.query.referralSource as string | undefined)?.trim();

  // Paginate in SQL: this used to select every student and slice in memory.
  const where = referralSource
    ? and(eq(usersTable.role, "student"), eq(usersTable.referralSource, referralSource))
    : eq(usersTable.role, "student");

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(usersTable).where(where)
      .orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(usersTable).where(where),
  ]);

  res.json({
    students: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      preferredLanguage: u.preferredLanguage,
      country: u.country,
      referralSource: u.referralSource,
      referralDetail: u.referralDetail,
      createdAt: u.createdAt,
    })),
    total: count,
    page,
    limit,
  });
});

/** Signup counts per referral channel, for the admin dashboard. */
router.get("/admin/referrals", requirePermission("students.manage"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      source: usersTable.referralSource,
      count: sql<number>`count(*)::int`,
    })
    .from(usersTable)
    .where(eq(usersTable.role, "student"))
    .groupBy(usersTable.referralSource)
    .orderBy(desc(sql`count(*)`));

  res.json({
    // Accounts created before the question existed report as "unknown".
    items: rows.map((r) => ({ source: r.source ?? "unknown", count: r.count })),
    total: rows.reduce((sum, r) => sum + r.count, 0),
  });
});

/**
 * Override a student's level (spec section 2: "The administrator must be able
 * to review/override the placement").
 *
 * A note is required. An unexplained level change is indistinguishable from a
 * mistake six months later, and this is the one endpoint that can move a
 * student without them having earned it.
 */
router.post("/admin/students/:userId/level", requirePermission("students.manage"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const studentId = parseInt(raw as string, 10);
  const { levelId, note } = req.body ?? {};

  if (isNaN(studentId)) {
    res.status(400).json({ error: "Invalid student ID" }); return;
  }
  if (typeof levelId !== "number" || !Number.isInteger(levelId)) {
    res.status(400).json({ error: "levelId is required" }); return;
  }
  if (typeof note !== "string" || note.trim().length === 0) {
    res.status(400).json({ error: "A note explaining the override is required" }); return;
  }

  const [student] = await db.select().from(usersTable)
    .where(eq(usersTable.id, studentId)).limit(1);
  if (!student || student.role !== "student") {
    res.status(404).json({ error: "Student not found" }); return;
  }

  const [level] = await db.select().from(levelsTable)
    .where(eq(levelsTable.id, levelId)).limit(1);
  if (!level) {
    res.status(404).json({ error: "Level not found" }); return;
  }

  // Moving a student to a level in a curriculum they are not enrolled in would
  // leave them with a level their lessons query can never match. Reject it
  // rather than stranding them on an empty dashboard.
  const [profile] = await db.select().from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, studentId)).limit(1);

  if (profile?.curriculumId && profile.curriculumId !== level.curriculumId) {
    res.status(409).json({
      error: "That level belongs to a different curriculum than the student is enrolled in",
      code: "CURRICULUM_MISMATCH",
    });
    return;
  }

  const result = await setStudentLevel({
    userId: studentId,
    curriculumId: level.curriculumId,
    toLevelId: levelId,
    reason: "admin_override",
    decidedByUserId: req.session.userId!,
    note: note.trim(),
  });

  res.json({
    studentId,
    fromLevelId: result?.fromLevelId ?? null,
    toLevelId: levelId,
    toLevelCode: level.code,
    toLevelName: level.name,
    toLevelNameAr: level.nameAr,
  });
});

/**
 * Everything needed to review a placement (spec section 2).
 *
 * The per-skill breakdown is the point: an administrator asked to confirm or
 * override a level cannot judge "58%" but can judge "reading 80, grammar 35".
 * The computed level is shown alongside the assigned one so an AI adjustment is
 * visible rather than silently baked in.
 */
router.get("/admin/students/:userId/placement", requirePermission("students.manage"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const studentId = parseInt(raw as string, 10);
  if (isNaN(studentId)) {
    res.status(400).json({ error: "Invalid student ID" }); return;
  }

  const [result] = await db
    .select()
    .from(placementResultsTable)
    .where(eq(placementResultsTable.userId, studentId))
    .orderBy(desc(placementResultsTable.completedAt))
    .limit(1);

  const [profile] = await db
    .select({
      currentLevelId: studentProfilesTable.currentLevelId,
      curriculumId: studentProfilesTable.curriculumId,
      placementCompleted: studentProfilesTable.placementCompleted,
    })
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, studentId))
    .limit(1);

  // Only levels from the student's own curriculum: offering an override to a
  // level in a different curriculum would strand them, and the override
  // endpoint rejects it anyway.
  const levels = profile?.curriculumId
    ? await db
        .select({
          id: levelsTable.id,
          code: levelsTable.code,
          name: levelsTable.name,
          nameAr: levelsTable.nameAr,
        })
        .from(levelsTable)
        .where(eq(levelsTable.curriculumId, profile.curriculumId))
        .orderBy(levelsTable.order)
    : [];

  res.json({
    placement: result
      ? {
          completedAt: result.completedAt,
          score: result.score,
          total: result.total,
          percentage: result.percentage,
          assignedLevelCode: result.assignedLevelCode,
          computedLevelCode: result.computedLevelCode,
          adjustmentReason: result.adjustmentReason,
          skillScores: result.skillScores,
          strengths: result.strengths,
          weaknesses: result.weaknesses,
          analysisAr: result.analysisAr,
          writingSample: result.writingSample,
          writingScore: result.writingScore,
        }
      : null,
    currentLevelId: profile?.currentLevelId ?? null,
    placementCompleted: profile?.placementCompleted ?? false,
    levels,
    history: await getProgressionHistory(studentId),
  });
});

/** Every level change this student has been through, newest first. */
router.get("/admin/students/:userId/progression", requirePermission("students.manage"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const studentId = parseInt(raw as string, 10);
  if (isNaN(studentId)) {
    res.status(400).json({ error: "Invalid student ID" }); return;
  }
  res.json({ history: await getProgressionHistory(studentId) });
});

router.get("/admin/lessons", requirePermission("content.publish"), async (req, res): Promise<void> => {
  const lessons = await db.select().from(lessonsTable);
  res.json(lessons.map((l) => ({
    id: l.id,
    levelId: l.levelId,
    title: l.title,
    titleAr: l.titleAr,
    description: l.description ?? null,
    descriptionAr: l.descriptionAr ?? null,
    order: l.order,
    lessonType: l.lessonType,
    estimatedMinutes: l.estimatedMinutes,
    isPublished: l.isPublished,
    xpReward: l.xpReward,
    passingScore: l.passingScore,
  })));
});

router.post("/admin/lessons", requirePermission("content.publish"), async (req, res): Promise<void> => {
  const { levelId, title, titleAr, lessonType, estimatedMinutes, order, description, descriptionAr, isPublished, xpReward, passingScore } = req.body;

  if (!levelId || !title || !titleAr || !lessonType || !order) {
    res.status(400).json({ error: "levelId, title, titleAr, lessonType, and order are required" });
    return;
  }

  const publishFlag = isPublished ?? false;
  const [lesson] = await db.insert(lessonsTable).values({
    levelId,
    title,
    titleAr,
    description: description ?? null,
    descriptionAr: descriptionAr ?? null,
    order,
    lessonType,
    estimatedMinutes: estimatedMinutes ?? 35,
    isPublished: publishFlag,
    status: publishFlag ? "published" : "draft",
    xpReward: xpReward ?? 50,
    passingScore: passingScore ?? 75,
  }).returning();

  // Invalidate: level's lesson list may be cached inside lesson content bundles
  // and the levels metadata cache includes lesson counts
  await Promise.all([
    invalidate(CK.lessonContent(lesson.id)),
    invalidatePrefix(`v1:levels:c:`),         // all level caches (lesson counts changed)
    invalidatePrefix(`v1:vocab:lesson:`),      // just in case vocab was pre-cached
  ]);

  res.status(201).json({
    id: lesson.id,
    levelId: lesson.levelId,
    title: lesson.title,
    titleAr: lesson.titleAr,
    description: lesson.description ?? null,
    descriptionAr: lesson.descriptionAr ?? null,
    order: lesson.order,
    lessonType: lesson.lessonType,
    estimatedMinutes: lesson.estimatedMinutes,
    isPublished: lesson.isPublished,
    xpReward: lesson.xpReward,
    passingScore: lesson.passingScore,
  });
});

router.patch("/admin/lessons/:lessonId", requirePermission("content.publish"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const allowed = ["title", "titleAr", "description", "descriptionAr", "order", "lessonType", "estimatedMinutes", "isPublished", "xpReward", "passingScore"];
  const update: Record<string, unknown> = {};
  for (const f of allowed) {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  }
  // Keep status in sync with isPublished so both sources of truth agree
  if (req.body.isPublished !== undefined) {
    update.status = req.body.isPublished ? "published" : "draft";
  }

  const [lesson] = await db.update(lessonsTable).set(update).where(eq(lessonsTable.id, lessonId)).returning();
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Invalidate the specific lesson's content cache and affected level caches
  await Promise.all([
    invalidate(CK.lessonContent(lessonId)),
    invalidatePrefix(`v1:levels:c:`),
    invalidate(CK.vocabByLesson(lessonId)),
  ]);

  res.json({
    id: lesson.id,
    levelId: lesson.levelId,
    title: lesson.title,
    titleAr: lesson.titleAr,
    description: lesson.description ?? null,
    descriptionAr: lesson.descriptionAr ?? null,
    order: lesson.order,
    lessonType: lesson.lessonType,
    estimatedMinutes: lesson.estimatedMinutes,
    isPublished: lesson.isPublished,
    xpReward: lesson.xpReward,
    passingScore: lesson.passingScore,
  });
});

export default router;
