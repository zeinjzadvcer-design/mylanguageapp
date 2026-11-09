import { Router, type IRouter } from "express";
import { eq, and, asc, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  lessonsTable,
  levelsTable,
  contentBlocksTable,
  exercisesTable,
  exerciseOptionsTable,
  lessonProgressTable,
  lessonBlockProgressTable,
  learningActivityAttemptsTable,
  vocabularyTable,
  studentProfilesTable,
} from "@workspace/db";
import { isUnmeteredCaller, requireAuth } from "../middlewares/auth";
import { cached, CK, TTL } from "../services/cache";
import {
  getCompletedLessonIds,
  getCompletedBlockIds,
  deriveLessonStateWithOrders,
  getStudentCurriculumContext,
  getCurriculumLevels,
  deriveLessonScore,
  getMissingRequiredBlockIds,
  maybeAdvanceLevel,
  findNextLesson,
  publishedLessonFilter,
} from "../services/learning";
import { assertUsableRecording, MediaValidationError } from "../services/media";
import {
  getEntitlement,
  countLessonsStarted,
  checkLessonAccess,
  isLessonInTrack,
  lessonTrackFilter,
  previousLessonInTrack,
  DENIAL_MESSAGES,
  type LessonDenial,
} from "../services/entitlements";
import { gradeLessonActivity } from "../services/grading-runner";
import {
  toStudentContentBlocks,
  isRecordingBlock,
  type StudentContentBlock,
} from "../services/lesson-content";
import { jobs } from "../services/jobs";

const router: IRouter = Router();

/**
 * How many times one block may be answered in a lesson.
 *
 * Three is enough for the retry the spec's 75% pass gate assumes a student
 * will make, and the cost model's 1.4x retry factor already prices. Beyond
 * that it stops being practice: the student is guessing at a grader, and every
 * guess is an AI call against an allowance they will want later.
 *
 * Environment-tunable because the right number is a teaching judgement, not a
 * technical one, and it should not need a deploy to change.
 */
const MAX_BLOCK_ATTEMPTS = parseInt(process.env.MAX_BLOCK_ATTEMPTS ?? "3", 10);

// ─── GET /lessons ─────────────────────────────────────────────────────────────
// Returns lessons in the caller's curriculum with authoritative state values.
//
// requireAuth rather than requireStudent, here and on every lesson route below.
// Taking a lesson is not student-only: an admin or content manager needs to walk
// the real student flow to check their own content, and refusing them left the
// level page listing nothing at all. Every handler resolves the caller's own
// curriculum context and answers 403 when there is none, so a role without a
// student profile is turned away by the data rather than by the role check.
router.get("/lessons", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const levelId = req.query.levelId ? parseInt(req.query.levelId as string, 10) : undefined;

  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx) {
    res.status(403).json({ error: "No curriculum assigned. Complete placement test first." });
    return;
  }

  // Determine current level order for state derivation
  let currentLevelOrder: number | null = null;
  if (ctx.currentLevelId) {
    const [lvl] = await db
      .select({ order: levelsTable.order })
      .from(levelsTable)
      .where(eq(levelsTable.id, ctx.currentLevelId))
      .limit(1);
    currentLevelOrder = lvl?.order ?? null;
  }

  // Only show lessons from the student's curriculum
  const levelIds = await db
    .select({ id: levelsTable.id, order: levelsTable.order })
    .from(levelsTable)
    .where(eq(levelsTable.curriculumId, ctx.curriculumId));

  const allowedLevelIds = levelIds.map((l) => l.id);
  const levelOrderMap = new Map(levelIds.map((l) => [l.id, l.order]));

  if (allowedLevelIds.length === 0) {
    res.json([]);
    return;
  }

  // Lessons outside the student's track are filtered out entirely rather than
  // returned locked: the general and professional tracks are alternatives, not
  // tiers, so a professional lesson is not something a general subscriber can
  // unlock by upgrading. Showing it would advertise content that no purchase on
  // this plan makes available.
  const entitlement = await getEntitlement(userId, req.session.role);

  // Staff get no filter: they see both tracks.
  const trackFilter = lessonTrackFilter(entitlement);

  const whereFilter = levelId
    ? and(
        eq(lessonsTable.levelId, levelId),
        inArray(lessonsTable.levelId, allowedLevelIds),
        trackFilter,
        publishedLessonFilter(),
      )
    : and(
        inArray(lessonsTable.levelId, allowedLevelIds),
        trackFilter,
        publishedLessonFilter(),
      );

  const [lessons, completedIds, progressRows] = await Promise.all([
    db.select().from(lessonsTable).where(whereFilter).orderBy(asc(lessonsTable.order)),
    getCompletedLessonIds(userId),
    db
      .select()
      .from(lessonProgressTable)
      .where(eq(lessonProgressTable.userId, userId)),
  ]);

  // Quota lock, applied over the curriculum's own unlock logic below. Lessons
  // already started stay open — a free student who closes the tab must be able
  // to reopen the one lesson they were given.
  const startedLessonIds = new Set(
    progressRows.filter((p) => p.startedAt !== null).map((p) => p.lessonId),
  );
  // Only lessons started in the CURRENT period count against the allowance,
  // so a monthly quota resets rather than accumulating for all time.
  const periodStart = entitlement.periodStartedAt;
  const startedThisPeriod = progressRows.filter(
    (p) => p.startedAt !== null && (!periodStart || p.startedAt >= periodStart),
  ).length;
  const quotaSpent =
    entitlement.lessonQuota !== null && startedThisPeriod >= entitlement.lessonQuota;

  // Group lessons by level for sequential unlock calculation
  const lessonsByLevel = new Map<number, typeof lessons>();
  for (const lesson of lessons) {
    const arr = lessonsByLevel.get(lesson.levelId) ?? [];
    arr.push(lesson);
    lessonsByLevel.set(lesson.levelId, arr);
  }

  const result = lessons.map((lesson) => {
    const levelOrder = levelOrderMap.get(lesson.levelId) ?? 999;
    const levelLessons = (lessonsByLevel.get(lesson.levelId) ?? []).sort(
      (a, b) => a.order - b.order,
    );
    const idx = levelLessons.findIndex((l) => l.id === lesson.id);
    const prevLessonId = previousLessonInTrack(levelLessons, idx);
    const progressRow = progressRows.find((p) => p.lessonId === lesson.id);
    const curriculumState = deriveLessonStateWithOrders(
      lesson,
      levelOrder,
      currentLevelOrder,
      completedIds,
      prevLessonId,
      progressRow?.status,
      entitlement.unlimited,
    );

    // The plan can only ever lock further, never unlock: a lesson the
    // curriculum has not reached stays LOCKED whatever the plan says.
    const lockedByQuota = quotaSpent && !startedLessonIds.has(lesson.id);
    const state = lockedByQuota ? "LOCKED" : curriculumState;

    return {
      id: lesson.id,
      levelId: lesson.levelId,
      title: lesson.title,
      titleAr: lesson.titleAr,
      description: lesson.description ?? null,
      descriptionAr: lesson.descriptionAr ?? null,
      order: lesson.order,
      lessonType: lesson.lessonType,
      estimatedMinutes: lesson.estimatedMinutes,
      state,
      /**
       * Why this lesson is locked, when the reason is the plan rather than the
       * curriculum. Lets the UI show an upgrade prompt instead of the usual
       * "finish the previous lesson" message.
       */
      lockedReason: lockedByQuota ? "quota_exhausted" : null,
      // Legacy compatibility
      isUnlocked: state !== "LOCKED",
      isCompleted: state === "COMPLETED",
      bestScore: progressRow?.bestScore ?? null,
      xpReward: lesson.xpReward,
    };
  });

  res.json(result);
});

// ─── Lesson content bundle (cached) ──────────────────────────────────────────

interface LessonContentBundle {
  lesson: {
    id: number;
    levelId: number;
    title: string;
    titleAr: string;
    description: string | null;
    descriptionAr: string | null;
    order: number;
    lessonType: string;
    /** Which plan track sells this lesson. See lib/db schema `lessons.track`. */
    track: string;
    estimatedMinutes: number;
    xpReward: number;
    passingScore: number;
    contentVersion: number;
    objectives: string[] | null;
    objectivesAr: string[] | null;
  };
  levelCode: string;
  levelOrder: number;
  levelId: number;
  levelCurriculumId: number;
  contentBlocks: StudentContentBlock[];
}

async function loadLessonContent(lessonId: number): Promise<LessonContentBundle | null> {
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
    .limit(1);
  if (!lesson) return null;

  const [level, blocks, exercises, vocab] = await Promise.all([
    db
      .select()
      .from(levelsTable)
      .where(eq(levelsTable.id, lesson.levelId))
      .limit(1)
      .then((r) => r[0]),
    db
      .select()
      .from(contentBlocksTable)
      .where(and(eq(contentBlocksTable.lessonId, lessonId), eq(contentBlocksTable.isActive, true)))
      .orderBy(asc(contentBlocksTable.order)),
    // Ordered so a question keeps its position for the student across saves.
    db.select().from(exercisesTable).where(eq(exercisesTable.lessonId, lessonId))
      .orderBy(asc(exercisesTable.ordering), asc(exercisesTable.id)),
    db.select().from(vocabularyTable).where(eq(vocabularyTable.lessonId, lessonId)),
  ]);

  const exerciseIds = exercises.map((e) => e.id);
  const allOptions =
    exerciseIds.length > 0
      ? await db
          .select()
          .from(exerciseOptionsTable)
          .where(inArray(exerciseOptionsTable.exerciseId, exerciseIds))
      : [];

  const contentBlocks = toStudentContentBlocks(blocks, exercises, allOptions, vocab);

  return {
    lesson: {
      id: lesson.id,
      levelId: lesson.levelId,
      title: lesson.title,
      titleAr: lesson.titleAr,
      description: lesson.description ?? null,
      descriptionAr: lesson.descriptionAr ?? null,
      order: lesson.order,
      lessonType: lesson.lessonType,
      track: lesson.track,
      estimatedMinutes: lesson.estimatedMinutes,
      xpReward: lesson.xpReward,
      passingScore: lesson.passingScore,
      contentVersion: lesson.contentVersion,
      objectives: lesson.objectives ?? null,
      objectivesAr: lesson.objectivesAr ?? null,
    },
    levelCode: level?.code ?? "",
    levelOrder: level?.order ?? 1,
    levelId: level?.id ?? lesson.levelId,
    levelCurriculumId: level?.curriculumId ?? 0,
    contentBlocks,
  };
}

// ─── GET /lessons/:lessonId ───────────────────────────────────────────────────

router.get("/lessons/:lessonId", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const userId = req.session.userId!;

  // Load static content from cache
  const bundle = await cached(CK.lessonContent(lessonId), TTL.LESSON_CONTENT, () =>
    loadLessonContent(lessonId),
  );

  if (!bundle) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Enforce curriculum access
  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx || ctx.curriculumId !== bundle.levelCurriculumId) {
    res.status(403).json({ error: "You do not have access to this lesson" });
    return;
  }

  // Enforce plan access. This route serves the lesson's actual content blocks,
  // so it needs its own gate: without one a student could skip /start and read
  // everything the paywall is meant to cover.
  const entitlement = await getEntitlement(userId, req.session.role);
  if (!isLessonInTrack(entitlement, bundle.lesson.track)) {
    res.status(403).json({ ...DENIAL_MESSAGES.wrong_track, reason: "wrong_track" });
    return;
  }

  const [completedIds, progressRow, currentLevel] = await Promise.all([
    getCompletedLessonIds(userId),
    db
      .select()
      .from(lessonProgressTable)
      .where(
        and(
          eq(lessonProgressTable.userId, userId),
          eq(lessonProgressTable.lessonId, lessonId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null),
    ctx.currentLevelId
      ? db
          .select({ order: levelsTable.order })
          .from(levelsTable)
          .where(eq(levelsTable.id, ctx.currentLevelId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  // Quota gate. Deferred until here because it needs progressRow: a lesson the
  // student already started stays readable however spent the quota is, so they
  // can finish what they opened.
  if (entitlement.lessonQuota !== null && !progressRow?.startedAt) {
    const lessonsStarted = await countLessonsStarted(userId, entitlement.periodStartedAt);
    if (lessonsStarted >= entitlement.lessonQuota) {
      res
        .status(403)
        .json({ ...DENIAL_MESSAGES.quota_exhausted, reason: "quota_exhausted" });
      return;
    }
  }

  // Find the previous lesson in order for unlock derivation
  const prevLessonId = await (async () => {
    if (bundle.lesson.order <= 1) return null;
    const siblings = await db
      .select({ id: lessonsTable.id, order: lessonsTable.order })
      .from(lessonsTable)
      .where(
        and(
          eq(lessonsTable.levelId, bundle.lesson.levelId),
          // The predecessor that unlocks a lesson is in its own track.
          eq(lessonsTable.track, bundle.lesson.track),
          eq(lessonsTable.status, "published"),
          isNull(lessonsTable.softDeletedAt),
        ),
      )
      .orderBy(asc(lessonsTable.order));
    const idx = siblings.findIndex((l) => l.id === lessonId);
    return idx > 0 ? siblings[idx - 1].id : null;
  })();

  const currentLevelOrder = currentLevel?.order ?? null;
  const state = deriveLessonStateWithOrders(
    bundle.lesson,
    bundle.levelOrder,
    currentLevelOrder,
    completedIds,
    prevLessonId,
    progressRow?.status,
    entitlement.unlimited,
  );

  // Enforce that locked lessons are not accessible for detail
  if (state === "LOCKED") {
    res.status(403).json({ error: "This lesson is locked" });
    return;
  }

  const completedBlockIds = await getCompletedBlockIds(
    userId,
    lessonId,
    bundle.lesson.contentVersion,
  );

  res.json({
    id: bundle.lesson.id,
    levelId: bundle.lesson.levelId,
    levelCode: bundle.levelCode,
    title: bundle.lesson.title,
    titleAr: bundle.lesson.titleAr,
    description: bundle.lesson.description,
    descriptionAr: bundle.lesson.descriptionAr,
    order: bundle.lesson.order,
    lessonType: bundle.lesson.lessonType,
    estimatedMinutes: bundle.lesson.estimatedMinutes,
    contentVersion: bundle.lesson.contentVersion,
    state,
    // Legacy
    isUnlocked: true,
    isCompleted: state === "COMPLETED",
    bestScore: progressRow?.bestScore ?? null,
    xpReward: bundle.lesson.xpReward,
    passingScore: bundle.lesson.passingScore,
    contentBlocks: bundle.contentBlocks,
    completedBlockIds,
    objectives: bundle.lesson.objectives,
    objectivesAr: bundle.lesson.objectivesAr,
  });
});

// ─── POST /lessons/:lessonId/start ────────────────────────────────────────────

router.post("/lessons/:lessonId/start", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  const userId = req.session.userId!;

  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const [lessonRow] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
    .limit(1);

  if (!lessonRow) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Enforce curriculum access
  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx) {
    res.status(403).json({ error: "No curriculum assigned" });
    return;
  }

  const [level] = await db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.id, lessonRow.levelId))
    .limit(1);

  if (!level || level.curriculumId !== ctx.curriculumId) {
    res.status(403).json({ error: "This lesson does not belong to your curriculum" });
    return;
  }

  // Check unlock state
  const [completedIds, currentLevel] = await Promise.all([
    getCompletedLessonIds(userId),
    ctx.currentLevelId
      ? db
          .select({ order: levelsTable.order })
          .from(levelsTable)
          .where(eq(levelsTable.id, ctx.currentLevelId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const siblings = await db
    .select({ id: lessonsTable.id, order: lessonsTable.order })
    .from(lessonsTable)
    .where(
      and(
        eq(lessonsTable.levelId, lessonRow.levelId),
        // The predecessor that unlocks a lesson is in its own track.
        eq(lessonsTable.track, lessonRow.track),
        publishedLessonFilter(),
      ),
    )
    .orderBy(asc(lessonsTable.order));

  const idx = siblings.findIndex((l) => l.id === lessonId);
  const prevLessonId = idx > 0 ? siblings[idx - 1].id : null;
  const currentLevelOrder = currentLevel?.order ?? null;

  // Resolved before the progression check below, which needs `unlimited` to
  // let staff past it, as well as by the plan gate further down.
  const entitlement = await getEntitlement(userId, req.session.role);

  const state = deriveLessonStateWithOrders(
    lessonRow,
    level.order,
    currentLevelOrder,
    completedIds,
    prevLessonId,
    null,
    entitlement.unlimited,
  );

  if (state === "LOCKED") {
    res.status(403).json({ error: "This lesson is locked" });
    return;
  }

  // ── Plan gate ───────────────────────────────────────────────────────────────
  // The paywall. Everything above decides whether the CURRICULUM lets this
  // lesson open; this decides whether the student's PLAN does.
  //
  // Checked inside a transaction together with the progress write: the quota
  // counts "how many distinct lessons have been started", so two concurrent
  // requests would otherwise both read zero and both be allowed, handing a free
  // student two lessons.
  //
  // Serialised with a per-user advisory lock rather than SERIALIZABLE
  // isolation. What needs protecting is a COUNT over rows that do not exist
  // yet, so there is no row to lock and no unique index that can express
  // "at most N distinct lessons". An advisory lock keyed on the user gives the
  // one thing actually needed — two starts by the same student cannot
  // interleave — without making a routine request retryable on 40001, which
  // nothing else in this codebase is set up to handle.

  // Assigned inside the transaction callback and read after it commits.
  // Explicitly widened: TypeScript narrows a `null` initializer to `null` and
  // cannot see that the callback runs before these are read.
  let denial = null as LessonDenial | null;
  let payload = null as Record<string, unknown> | null;

  await db.transaction(async (tx) => {
    // Held until commit. Classid 4242 namespaces this lock against any other
    // advisory lock added later; the key is the user id, so students never
    // contend with each other.
    await tx.execute(sql`select pg_advisory_xact_lock(4242, ${userId})`);

    const [existing] = await tx
      .select()
      .from(lessonProgressTable)
      .where(
        and(
          eq(lessonProgressTable.userId, userId),
          eq(lessonProgressTable.lessonId, lessonId),
        ),
      )
      .limit(1);

    denial = checkLessonAccess({
      entitlement,
      lessonTrack: lessonRow.track,
      // Only counted when it can actually change the answer. An unlimited plan
      // and a resume both short-circuit, so the common paths skip the count.
      lessonsStarted:
        entitlement.lessonQuota !== null && !existing?.startedAt
          ? await countLessonsStarted(userId, entitlement.periodStartedAt, tx)
          : 0,
      // `startedAt`, not the row: a not_started row has opened nothing.
      alreadyStarted: Boolean(existing?.startedAt),
    });
    if (denial) return;

    if (existing) {
      // Preserve completed revisit history — don't overwrite completedAt/passed
      if (existing.status === "not_started" || existing.status === "completed" || existing.status === "passed" || existing.status === "failed") {
        await tx
          .update(lessonProgressTable)
          .set({ status: "in_progress", startedAt: existing.startedAt ?? new Date() })
          .where(eq(lessonProgressTable.id, existing.id));
      }
      payload = {
        ...existing,
        status: "in_progress",
        startedAt: existing.startedAt ?? new Date(),
        nextLessonUnlocked: false,
      };
      return;
    }

    const [progress] = await tx
      .insert(lessonProgressTable)
      .values({
        userId,
        lessonId,
        contentVersion: lessonRow.contentVersion,
        status: "in_progress",
        attempts: 0,
        passed: false,
        xpEarned: 0,
        startedAt: new Date(),
      })
      .returning();

    payload = { ...progress, nextLessonUnlocked: false };
    // Default READ COMMITTED, deliberately. Each statement takes its snapshot
    // after the advisory lock is granted, so the count above sees a concurrent
    // start's committed insert. SERIALIZABLE takes the snapshot at the lock call
    // itself, before the lock is granted: the second request would count from
    // stale data and fail at commit with a 40001 nothing retries.
  });

  if (denial) {
    res.status(403).json({ ...DENIAL_MESSAGES[denial], reason: denial });
    return;
  }

  res.json(payload);
});

// ─── POST /lessons/:lessonId/blocks/:blockId/submit ───────────────────────────

/**
 * Refuse work on a lesson this student was never let into.
 *
 * The paywall lives on /start, where the quota is counted under its lock, so
 * everything after it only has to ask whether /start happened. Without this a
 * student past their allowance could skip it: submit a lesson's blocks by id,
 * spending AI budget, then POST /complete and collect the pass and the XP.
 *
 * Sends the refusal itself and returns true when the caller should stop.
 */
async function refuseUnopenedLesson(
  res: import("express").Response,
  userId: number,
  role: string | undefined,
  lesson: { id: number; track: string },
): Promise<boolean> {
  const entitlement = await getEntitlement(userId, role);
  if (entitlement.unlimited) return false;

  if (!isLessonInTrack(entitlement, lesson.track)) {
    res.status(403).json({ ...DENIAL_MESSAGES.wrong_track, reason: "wrong_track" });
    return true;
  }

  // Not rechecked against the quota: a lesson already started can always be
  // finished, including after the allowance has run out.
  const [progress] = await db
    .select({ startedAt: lessonProgressTable.startedAt })
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lesson.id),
      ),
    )
    .limit(1);

  if (progress?.startedAt) return false;

  res.status(403).json({
    error: "Open this lesson before submitting work in it",
    errorAr: "افتح هذا الدرس أولاً قبل إرسال أي إجابات فيه.",
    reason: "not_started",
  });
  return true;
}

const submitBlockSchema = z.object({
  clientSubmissionId: z.string().min(1),
  /** Which question on the block is being answered. Omitted means the first. */
  exerciseId: z.number().int().positive().optional(),
  selectedOptionId: z.string().optional(),
  responseText: z.string().optional(),
  mediaReference: z.string().optional(),
  /** A media_assets id from the upload handshake. Verified before it is stored. */
  mediaId: z.number().int().positive().optional(),
  recordingDurationSeconds: z.number().int().min(0).optional(),
  timeSpentSeconds: z.number().int().min(0).optional(),
});

router.post(
  "/lessons/:lessonId/blocks/:blockId/submit",
  requireAuth,
  async (req, res): Promise<void> => {
    const lessonId = parseInt(
      Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId,
      10,
    );
    const blockId = parseInt(
      Array.isArray(req.params.blockId) ? req.params.blockId[0] : req.params.blockId,
      10,
    );
    const userId = req.session.userId!;

    if (isNaN(lessonId) || isNaN(blockId)) {
      res.status(400).json({ error: "Invalid lesson or block ID" });
      return;
    }

    const parsed = submitBlockSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.errors.map((e) => ({ path: e.path.join("."), message: e.message })),
      });
      return;
    }

    const {
      clientSubmissionId,
      exerciseId: requestedExerciseId,
      selectedOptionId,
      responseText,
      mediaReference,
      mediaId,
      recordingDurationSeconds,
    } = parsed.data;

    // Idempotency check
    const [existingAttempt] = await db
      .select()
      .from(learningActivityAttemptsTable)
      .where(
        and(
          eq(learningActivityAttemptsTable.userId, userId),
          eq(learningActivityAttemptsTable.clientSubmissionId, clientSubmissionId),
        ),
      )
      .limit(1);

    if (existingAttempt) {
      res.json({
        attemptId: existingAttempt.id,
        blockId: existingAttempt.blockId,
        completed: true,
        correct: existingAttempt.isCorrect ?? null,
        score: existingAttempt.score ?? null,
        evaluationStatus: existingAttempt.evaluationStatus,
      });
      return;
    }

    // Validate lesson is published and accessible
    const [lessonRow] = await db
      .select()
      .from(lessonsTable)
      .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
      .limit(1);

    if (!lessonRow) {
      res.status(404).json({ error: "Lesson not found" });
      return;
    }

    if (await refuseUnopenedLesson(res, userId, req.session.role, lessonRow)) return;

    // Validate block belongs to lesson and is active
    const [block] = await db
      .select()
      .from(contentBlocksTable)
      .where(
        and(
          eq(contentBlocksTable.id, blockId),
          eq(contentBlocksTable.lessonId, lessonId),
          eq(contentBlocksTable.isActive, true),
        ),
      )
      .limit(1);

    if (!block) {
      res.status(404).json({ error: "Block not found in this lesson" });
      return;
    }

    // Find the exercise being answered. Scoping by block and lesson as well as
    // id is what stops an exercise from another lesson being submitted here.
    const [exercise] = await db
      .select()
      .from(exercisesTable)
      .where(
        and(
          eq(exercisesTable.contentBlockId, blockId),
          eq(exercisesTable.lessonId, lessonId),
          ...(requestedExerciseId ? [eq(exercisesTable.id, requestedExerciseId)] : []),
        ),
      )
      // Same order the student is shown, so "the first question" means the
      // same one here as on screen.
      .orderBy(asc(exercisesTable.ordering), asc(exercisesTable.id))
      .limit(1);

    if (requestedExerciseId && !exercise) {
      res.status(404).json({ error: "Exercise not found on this block" });
      return;
    }

    // An item may be answered a limited number of times.
    //
    // Nothing used to bound this. The only ceiling was the per-plan AI quota,
    // which meant a student could retry one pronunciation block until their
    // whole day's allowance was gone and then be unable to start a lesson at
    // all — an accidental rule rather than a designed one, and a bad trade for
    // them as well as for the AI bill.
    //
    // Counted from attempts rather than stored on a counter column so it
    // cannot drift from the attempts actually recorded, and so it is right for
    // rows that already exist.
    //
    // Counted per question when the block holds several. Counting per block
    // refused the fourth question of a four-question block outright: each
    // question answered once had already used the block's three attempts.
    //
    // Passive blocks are exempt: re-reading a passage costs nothing and marking
    // one as seen twice is not a retry. A text block read ALOUD is not passive —
    // each recording is a transcription — so it is counted like any other. The
    // cap applies per lesson, so retaking the lesson later is a separate matter
    // — `maxAttempts` bounds one sitting, `ai_plan_policies` bounds the month.
    const isPassiveBlock =
      (block.type === "text" || block.type === "explanation" || block.type === "review") &&
      mediaId === undefined;
    if (!isPassiveBlock) {
      const [{ used }] = await db
        .select({ used: sql<number>`count(*)::int` })
        .from(learningActivityAttemptsTable)
        .where(
          and(
            eq(learningActivityAttemptsTable.userId, userId),
            eq(learningActivityAttemptsTable.lessonId, lessonId),
            eq(learningActivityAttemptsTable.blockId, blockId),
            ...(exercise ? [eq(learningActivityAttemptsTable.exerciseId, exercise.id)] : []),
          ),
        );

      // Staff retry a block as often as they need to check it.
      if (used >= MAX_BLOCK_ATTEMPTS && !(await isUnmeteredCaller(req))) {
        // 409, not 403: the request is well formed and the student is allowed
        // here — the block's state is simply done with being answered.
        res.status(409).json({
          error: `You have used all ${MAX_BLOCK_ATTEMPTS} attempts for this block.`,
          code: "ATTEMPT_LIMIT_REACHED",
          attemptsUsed: used,
          maxAttempts: MAX_BLOCK_ATTEMPTS,
        });
        return;
      }
    }

    // Enforce curriculum access
    const ctx = await getStudentCurriculumContext(userId);
    if (!ctx) {
      res.status(403).json({ error: "No curriculum assigned" });
      return;
    }

    const [level] = await db
      .select({ curriculumId: levelsTable.curriculumId })
      .from(levelsTable)
      .where(eq(levelsTable.id, lessonRow.levelId))
      .limit(1);

    if (!level || level.curriculumId !== ctx.curriculumId) {
      res.status(403).json({ error: "This lesson does not belong to your curriculum" });
      return;
    }

    // A recording is only accepted once the server has confirmed it exists in
    // the bucket and belongs to this student — see services/media.ts. Without
    // this check a student could attach anybody's audio to their own attempt.
    if (mediaId !== undefined) {
      try {
        await assertUsableRecording(mediaId, userId, "lesson_activity");
      } catch (err) {
        if (err instanceof MediaValidationError) {
          res.status(err.code === "NOT_FOUND" ? 404 : 400).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        throw err;
      }
    }

    let activityType = "passive";
    let isCorrect: boolean | null = null;
    let score: number | null = null;
    let evaluationStatus: "graded" | "pending" | "skipped" = "skipped";
    let explanation: string | null = null;
    let explanationAr: string | null = null;

    if (exercise) {
      activityType = exercise.exerciseType;

      if (exercise.exerciseType === "mcq") {
        if (!selectedOptionId) {
          res.status(400).json({ error: "selectedOptionId is required for MCQ" });
          return;
        }

        // Validate option belongs to this exercise
        const [option] = await db
          .select()
          .from(exerciseOptionsTable)
          .where(
            and(
              eq(exerciseOptionsTable.exerciseId, exercise.id),
              eq(exerciseOptionsTable.optionId, selectedOptionId),
            ),
          )
          .limit(1);

        if (!option) {
          res.status(400).json({ error: "Invalid option for this exercise" });
          return;
        }

        // Server-side grading — never trust client
        isCorrect = exercise.correctOptionId === selectedOptionId;
        score = isCorrect ? 100 : 0;
        evaluationStatus = "graded";
        explanation = exercise.explanation ?? null;
        explanationAr = exercise.explanationAr ?? null;
      } else if (
        exercise.exerciseType === "speaking" ||
        exercise.exerciseType === "pronunciation"
      ) {
        // Accept recorded metadata; score async
        evaluationStatus = "pending";
        isCorrect = null;
        score = null;
      } else {
        // open_ended, fill_blank, translation
        evaluationStatus = "pending";
        isCorrect = null;
        score = null;
      }
    } else if (mediaId !== undefined && isRecordingBlock(block)) {
      // A recording on a block with no exercise row. The pronunciation editor
      // never creates one — the word, passage and reference audio all live on
      // the block — and neither does a text block read aloud. Treating these as
      // passive stored the recording and never assessed it. The speech grader
      // reads the passage from the block, so the block is all it needs.
      activityType = block.type === "speaking_prompt" ? "speaking" : "pronunciation";
      evaluationStatus = "pending";
    }

    // Persist attempt
    const [attempt] = await db
      .insert(learningActivityAttemptsTable)
      .values({
        userId,
        lessonId,
        blockId,
        exerciseId: exercise?.id ?? null,
        contentVersion: lessonRow.contentVersion,
        activityType,
        clientSubmissionId,
        selectedOptionId: selectedOptionId ?? null,
        responseText: responseText ?? null,
        mediaReference: mediaReference ?? null,
        mediaAssetId: mediaId ?? null,
        recordingDurationSeconds: recordingDurationSeconds ?? null,
        isCorrect,
        score,
        evaluationStatus,
        metadata: null,
      })
      .returning();

    // Mark block progress complete
    await db
      .insert(lessonBlockProgressTable)
      .values({
        userId,
        lessonId,
        blockId,
        contentVersion: lessonRow.contentVersion,
        completedAt: new Date(),
      })
      .onConflictDoNothing();

    // An open-ended answer is graded here and now rather than in the background:
    // feedback is the entire point of the activity (spec section 4C), and a
    // student who has moved on will not come back for it. Failure is safe —
    // gradeLessonActivity returns null and the attempt stays pending, so the
    // lesson never stalls on the model being slow or absent.
    let verdict = null;
    // `responseText` OR a recording: a spoken open-ended answer is transcribed
    // inside gradeLessonActivity, so audio alone is enough to grade on.
    if (
      evaluationStatus === "pending" &&
      activityType === "open_ended" &&
      (responseText || mediaId !== undefined)
    ) {
      verdict = await gradeLessonActivity(attempt.id);
    }

    const responsePayload: Record<string, unknown> = {
      attemptId: attempt.id,
      blockId,
      completed: true,
      correct: verdict ? verdict.correct : isCorrect,
      score: verdict ? verdict.score : score,
      evaluationStatus: verdict ? "graded" : evaluationStatus,
    };

    if (verdict) {
      responsePayload.feedbackAr = verdict.feedback;
      responsePayload.feedback = verdict.feedbackEn;
      responsePayload.dimensions = verdict.dimensions;
    }

    // Only expose explanation after MCQ submission
    if (exercise?.exerciseType === "mcq") {
      responsePayload.explanation = explanation;
      responsePayload.explanationAr = explanationAr;
    }

    res.json(responsePayload);

    // A recording is assessed after the response is sent: it downloads audio
    // and waits on a speech recogniser, which is seconds of work. The student
    // moves on and the verdict appears in their progress when it lands.
    if (
      evaluationStatus === "pending" &&
      mediaId !== undefined &&
      activityType !== "open_ended"
    ) {
      jobs.enqueue("assess_speaking_activity", { activityAttemptId: attempt.id });
    }
  },
);

/**
 * The current verdict on one activity attempt.
 *
 * A spoken answer is assessed in the background, so the submit response can only
 * say "pending". This is how the student finds out what it came to without
 * reloading the lesson — the block polls it a few times after recording.
 */
router.get(
  "/lessons/:lessonId/attempts/:attemptId",
  requireAuth,
  async (req, res): Promise<void> => {
    const attemptId = parseInt(
      Array.isArray(req.params.attemptId) ? req.params.attemptId[0] : req.params.attemptId,
      10,
    );
    if (isNaN(attemptId)) {
      res.status(400).json({ error: "Invalid attempt ID" });
      return;
    }

    const [attempt] = await db
      .select()
      .from(learningActivityAttemptsTable)
      .where(
        and(
          eq(learningActivityAttemptsTable.id, attemptId),
          // Scoped to the caller: an attempt id must not be a way to read
          // another student's marks.
          eq(learningActivityAttemptsTable.userId, req.session.userId!),
        ),
      )
      .limit(1);

    if (!attempt) {
      res.status(404).json({ error: "Attempt not found" });
      return;
    }

    const metrics = (attempt.speechMetrics ?? null) as Record<string, unknown> | null;

    res.json({
      attemptId: attempt.id,
      blockId: attempt.blockId,
      evaluationStatus: attempt.evaluationStatus,
      correct: attempt.isCorrect,
      score: attempt.score,
      feedback: attempt.feedback,
      feedbackAr: attempt.feedbackAr,
      transcript: attempt.transcript,
      pronunciationScore: attempt.pronunciationScore,
      fluencyScore: attempt.fluencyScore,
      // The full word-by-word alignment is large and only useful to a teacher;
      // the student needs the headline numbers and what to practise.
      speechMetrics: metrics
        ? {
            speechRate: metrics.speechRate,
            pauseCount: metrics.pauseCount,
            meanLengthOfRun: metrics.meanLengthOfRun,
            fillersPer100Words: metrics.fillersPer100Words,
            problemWords: metrics.problemWords,
            fluencyUnavailable: metrics.fluencyUnavailable,
          }
        : null,
    });
  },
);

// ─── POST /lessons/:lessonId/complete ─────────────────────────────────────────

router.post("/lessons/:lessonId/complete", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  const userId = req.session.userId!;

  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const bodySchema = z.object({
    timeSpentSeconds: z.number().int().min(0).optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { timeSpentSeconds } = parsed.data;

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Enforce curriculum access
  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx) {
    res.status(403).json({ error: "No curriculum assigned" });
    return;
  }

  const [level] = await db
    .select({ curriculumId: levelsTable.curriculumId })
    .from(levelsTable)
    .where(eq(levelsTable.id, lesson.levelId))
    .limit(1);

  if (!level || level.curriculumId !== ctx.curriculumId) {
    res.status(403).json({ error: "This lesson does not belong to your curriculum" });
    return;
  }

  // Enforce plan access. The quota itself is not re-checked: completing is the
  // end of a lesson the student was already allowed to start, and re-counting
  // here would strand a free student inside the one lesson they were given.
  if (await refuseUnopenedLesson(res, userId, req.session.role, lesson)) return;

  // Check for missing required blocks
  const missingRequiredBlockIds = await getMissingRequiredBlockIds(
    userId,
    lessonId,
    lesson.contentVersion,
  );

  if (missingRequiredBlockIds.length > 0) {
    res.status(422).json({
      error: "Required blocks not completed",
      missingRequiredBlockIds,
    });
    return;
  }

  // Derive score server-side — ignore any client-submitted score
  const score = await deriveLessonScore(userId, lessonId, lesson.contentVersion);
  const passed = score >= lesson.passingScore;
  const xpEarned = passed ? lesson.xpReward : Math.floor(lesson.xpReward * 0.25);

  const [existing] = await db
    .select()
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lessonId),
      ),
    )
    .limit(1);

  let progress;

  if (existing) {
    const newBest =
      existing.bestScore === null ? score : Math.max(existing.bestScore, score);
    const wasAlreadyPassed = existing.passed;

    [progress] = await db
      .update(lessonProgressTable)
      .set({
        status: passed ? "passed" : "completed",
        lastScore: score,
        bestScore: newBest,
        attempts: existing.attempts + 1,
        passed: wasAlreadyPassed || passed,
        // Award XP only once
        xpEarned: wasAlreadyPassed ? existing.xpEarned : passed ? xpEarned : existing.xpEarned,
        // Preserve original completedAt on revisits if already completed
        completedAt: existing.completedAt ?? new Date(),
        timeSpentSeconds: existing.timeSpentSeconds + (timeSpentSeconds ?? 0),
      })
      .where(eq(lessonProgressTable.id, existing.id))
      .returning();

    if (passed && !wasAlreadyPassed) {
      await db
        .update(studentProfilesTable)
        .set({ totalXp: sql`total_xp + ${xpEarned}` })
        .where(eq(studentProfilesTable.userId, userId));
    }
  } else {
    [progress] = await db
      .insert(lessonProgressTable)
      .values({
        userId,
        lessonId,
        contentVersion: lesson.contentVersion,
        status: passed ? "passed" : "completed",
        lastScore: score,
        bestScore: score,
        attempts: 1,
        passed,
        xpEarned,
        timeSpentSeconds: timeSpentSeconds ?? 0,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning();

    if (passed) {
      await db
        .update(studentProfilesTable)
        .set({ totalXp: sql`total_xp + ${xpEarned}` })
        .where(eq(studentProfilesTable.userId, userId));
    }
  }

  // Maybe advance to next level
  const { advanced, newLevelId } = await maybeAdvanceLevel(userId, lessonId, req.session.role);

  // Find next lesson
  const nextLessonRow = await findNextLesson(lessonId);

  res.json({
    ...progress,
    score,
    nextLessonId: nextLessonRow?.id ?? null,
    nextLessonUnlocked: passed && !!nextLessonRow,
    levelAdvanced: advanced,
    newLevelId,
  });
});

// ─── GET /lessons/:lessonId/progress ─────────────────────────────────────────

router.get("/lessons/:lessonId/progress", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  const userId = req.session.userId!;

  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const [progress] = await db
    .select()
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lessonId),
      ),
    )
    .limit(1);

  if (!progress) {
    res.status(404).json({ error: "No progress found" });
    return;
  }

  res.json({ ...progress, nextLessonUnlocked: false });
});

export default router;
