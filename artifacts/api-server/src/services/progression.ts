/**
 * Level evaluation and student promotion.
 *
 * Spec section 10: a student finishes the lessons of a sub-level, sits that
 * level's evaluation test, and passes it to move on — A1.1 lessons → A1.1
 * evaluation → A1.2. Section 2 additionally requires that an administrator can
 * override a placement.
 *
 * Two rules shape everything here:
 *
 * 1. **No AI.** Eligibility, scoring, pass/fail and promotion are arithmetic
 *    over data the server already holds (spec section 6: if normal application
 *    logic can do the task accurately, do not use AI). AI's role in an
 *    evaluation is to write feedback about the result, never to decide it.
 *
 * 2. **One writer.** `student_profiles.current_level_id` is written by
 *    `setStudentLevel` and nowhere else, and every write appends a row to
 *    `level_progressions` in the same transaction. A level that changed without
 *    a recorded reason is a bug, not a shortcut.
 */

import { eq, and, asc, desc, isNull, inArray, sql } from "drizzle-orm";
import {
  db,
  levelsTable,
  lessonsTable,
  lessonProgressTable,
  quizzesTable,
  quizAttemptsTable,
  studentProfilesTable,
  levelProgressionsTable,
} from "@workspace/db";
import { publishedLessonFilter } from "./learning";
import { getEntitlement, lessonTrackFilter } from "./entitlements";

/** The transaction handle drizzle hands to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either a transaction or the pool — so callers can compose or not. */
type Executor = Tx | typeof db;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProgressionReason = "placement" | "evaluation" | "admin_override";

export interface SetStudentLevelInput {
  userId: number;
  curriculumId: number;
  toLevelId: number;
  reason: ProgressionReason;
  /** The evaluation attempt that earned it, when reason = evaluation. */
  quizAttemptId?: number | null;
  /** The administrator responsible, when reason = admin_override. */
  decidedByUserId?: number | null;
  note?: string | null;
}

/** Why a student may not sit an evaluation right now. */
export type IneligibilityCode =
  | "NOT_PLACED"
  | "NO_EVALUATION"
  | "NOT_CURRENT_LEVEL"
  | "LESSONS_INCOMPLETE"
  | "COOLDOWN"
  | "ATTEMPTS_EXHAUSTED";

export interface EvaluationEligibility {
  eligible: boolean;
  code: IneligibilityCode | null;
  /** Published lessons in the level the student has passed. */
  lessonsPassed: number;
  /** Published lessons in the level. */
  lessonsTotal: number;
  /** How much of the level must be finished, as a percentage. */
  requiredPercent: number;
  completedPercent: number;
  attemptsUsed: number;
  /** Null when the quiz allows unlimited attempts. */
  attemptsRemaining: number | null;
  /** Set when code = COOLDOWN — the earliest the student may retry. */
  retryAvailableAt: string | null;
}

export interface PromotionOutcome {
  promoted: boolean;
  fromLevelId: number | null;
  toLevelId: number | null;
  toLevelCode: string | null;
  toLevelName: string | null;
  toLevelNameAr: string | null;
  /** True when the student passed the final level of the curriculum. */
  curriculumCompleted: boolean;
}

// ─── The only writer of current_level_id ──────────────────────────────────────

/**
 * Move a student to a level and record why.
 *
 * Returns the progression row, or null when the write was a no-op because this
 * attempt had already been applied — see the partial unique index on
 * `level_progressions.quiz_attempt_id`. That makes the call safe to repeat: a
 * double submit, a retried job, or a late AI verdict on an already-graded
 * attempt cannot promote the same student twice.
 */
export async function setStudentLevel(
  input: SetStudentLevelInput,
  executor: Executor = db,
): Promise<{ fromLevelId: number | null } | null> {
  const {
    userId,
    curriculumId,
    toLevelId,
    reason,
    quizAttemptId = null,
    decidedByUserId = null,
    note = null,
  } = input;

  const [profile] = await executor
    .select({
      currentLevelId: studentProfilesTable.currentLevelId,
    })
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);

  const fromLevelId = profile?.currentLevelId ?? null;

  const inserted = await executor
    .insert(levelProgressionsTable)
    .values({
      userId,
      curriculumId,
      fromLevelId,
      toLevelId,
      reason,
      quizAttemptId,
      decidedByUserId,
      note,
    })
    .onConflictDoNothing()
    .returning({ id: levelProgressionsTable.id });

  // The attempt already produced a promotion. Leave the profile alone: a second
  // write here would be harmless today but would silently overwrite a later
  // administrator override if the job ever ran out of order.
  if (inserted.length === 0) return null;

  if (profile) {
    await executor
      .update(studentProfilesTable)
      .set({ currentLevelId: toLevelId, curriculumId })
      .where(eq(studentProfilesTable.userId, userId));
  } else {
    await executor.insert(studentProfilesTable).values({
      userId,
      curriculumId,
      currentLevelId: toLevelId,
      placementCompleted: reason === "placement",
    });
  }

  return { fromLevelId };
}

// ─── Evaluation lookup ────────────────────────────────────────────────────────

/**
 * The live evaluation gate for a level, if the curriculum team has published
 * one. A level with no evaluation simply has no gate — students still progress
 * through its lessons, they just cannot be promoted out of it until an
 * evaluation exists. That is deliberate: silently auto-promoting past a missing
 * gate would let an unfinished curriculum quietly skip assessment.
 */
export async function getLevelEvaluation(levelId: number) {
  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(
      and(
        eq(quizzesTable.levelId, levelId),
        eq(quizzesTable.kind, "level_evaluation"),
        eq(quizzesTable.status, "published"),
        isNull(quizzesTable.softDeletedAt),
      ),
    )
    .limit(1);
  return quiz ?? null;
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/** Everything `decideEligibility` needs, with no database in sight. */
export interface EligibilityInput {
  isPlaced: boolean;
  hasEvaluation: boolean;
  isCurrentLevel: boolean;
  requiredPercent: number;
  lessonsTotal: number;
  lessonsPassed: number;
  /** Null = unlimited retries. */
  maxAttempts: number | null;
  /** Newest first. */
  attempts: Array<{ passed: boolean | null; submittedAt: Date | null }>;
  /** Null or 0 = retry immediately. */
  cooldownHours: number | null;
  now: Date;
}

/**
 * Whether the gate is open, given the facts. Pure, so the rules can be read and
 * tested on their own — this function decides whether a student advances, which
 * makes it the part most worth being able to check.
 *
 * Order matters: the reason reported is the first one that applies, chosen so
 * the student is told the most actionable thing. "Finish your lessons" is more
 * use than "you are out of attempts" when both are true.
 */
export function decideEligibility(input: EligibilityInput): EvaluationEligibility {
  const {
    isPlaced, hasEvaluation, isCurrentLevel, requiredPercent,
    lessonsTotal, lessonsPassed, maxAttempts, attempts, cooldownHours, now,
  } = input;

  // A level with no published lessons yet counts as fully done rather than not
  // started, so an empty level cannot deadlock a student behind a gate they
  // have no way to satisfy.
  const completedPercent =
    lessonsTotal === 0 ? 100 : Math.floor((lessonsPassed / lessonsTotal) * 100);

  const attemptsUsed = attempts.length;
  const attemptsRemaining =
    maxAttempts === null ? null : Math.max(0, maxAttempts - attemptsUsed);

  const base: EvaluationEligibility = {
    eligible: false,
    code: null,
    lessonsPassed,
    lessonsTotal,
    requiredPercent,
    completedPercent,
    attemptsUsed,
    attemptsRemaining,
    retryAvailableAt: null,
  };

  if (!hasEvaluation) return { ...base, code: "NO_EVALUATION" };
  if (!isPlaced) return { ...base, code: "NOT_PLACED" };
  if (!isCurrentLevel) return { ...base, code: "NOT_CURRENT_LEVEL" };
  if (completedPercent < requiredPercent) return { ...base, code: "LESSONS_INCOMPLETE" };
  if (attemptsRemaining !== null && attemptsRemaining <= 0) {
    return { ...base, code: "ATTEMPTS_EXHAUSTED" };
  }

  // A cooldown after a failure sends the student back to the curriculum before
  // they may retry (spec section 10). Only a finished, failed attempt starts the
  // clock — an abandoned one should not lock anybody out.
  if (cooldownHours && cooldownHours > 0) {
    const lastFailed = attempts.find((a) => a.passed === false && a.submittedAt !== null);
    if (lastFailed?.submittedAt) {
      const retryAt = new Date(lastFailed.submittedAt.getTime() + cooldownHours * 3_600_000);
      if (retryAt > now) {
        return { ...base, code: "COOLDOWN", retryAvailableAt: retryAt.toISOString() };
      }
    }
  }

  return { ...base, eligible: true, code: null };
}

/**
 * Load the facts for one student and one level, then decide.
 *
 * Always answers — a level that does not exist, or has no evaluation, is a
 * closed gate rather than an error, because the caller renders both the same
 * way.
 */
export async function getEvaluationEligibility(
  userId: number,
  levelId: number,
): Promise<EvaluationEligibility> {
  const [level] = await db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.id, levelId))
    .limit(1);

  const requiredPercent = level?.evaluationUnlockPercent ?? 100;
  const quiz = level ? await getLevelEvaluation(levelId) : null;

  if (!level || !quiz) {
    return decideEligibility({
      isPlaced: false, hasEvaluation: false, isCurrentLevel: false,
      requiredPercent, lessonsTotal: 0, lessonsPassed: 0,
      maxAttempts: null, attempts: [], cooldownHours: null, now: new Date(),
    });
  }

  const [profile] = await db
    .select({ currentLevelId: studentProfilesTable.currentLevelId })
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);

  // Counted from published lessons only — an unpublished draft must not hold a
  // student back from an evaluation they have otherwise earned. Likewise only
  // the student's own track: the other track's lessons cannot be opened, so
  // counting them would hold the evaluation shut for good.
  const trackFilter = lessonTrackFilter(await getEntitlement(userId));
  const lessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(and(eq(lessonsTable.levelId, levelId), trackFilter, publishedLessonFilter()));

  let lessonsPassed = 0;
  if (lessons.length > 0) {
    const [{ passed }] = await db
      .select({ passed: sql<number>`count(*)::int` })
      .from(lessonProgressTable)
      .where(
        and(
          eq(lessonProgressTable.userId, userId),
          eq(lessonProgressTable.passed, true),
          inArray(lessonProgressTable.lessonId, lessons.map((l) => l.id)),
        ),
      );
    lessonsPassed = passed;
  }

  const attempts = await db
    .select({
      passed: quizAttemptsTable.passed,
      submittedAt: quizAttemptsTable.submittedAt,
    })
    .from(quizAttemptsTable)
    .where(
      and(
        eq(quizAttemptsTable.quizId, quiz.id),
        eq(quizAttemptsTable.userId, userId),
      ),
    )
    .orderBy(desc(quizAttemptsTable.startedAt));

  return decideEligibility({
    isPlaced: profile?.currentLevelId != null,
    hasEvaluation: true,
    isCurrentLevel: profile?.currentLevelId === level.id,
    requiredPercent,
    lessonsTotal: lessons.length,
    lessonsPassed,
    maxAttempts: quiz.maxAttempts,
    attempts,
    cooldownHours: quiz.cooldownHours,
    now: new Date(),
  });
}

// ─── Applying the result ──────────────────────────────────────────────────────

/**
 * Promote the student if this attempt was a passed level evaluation.
 *
 * Called after grading finishes. Deliberately tolerant: anything that is not an
 * unambiguous pass on the student's current level returns `promoted: false`
 * rather than throwing, because this runs on the tail of a submit request and
 * must never turn a successfully-graded attempt into a failed HTTP response.
 *
 * Safe to call repeatedly — see `setStudentLevel`.
 */
export async function applyEvaluationOutcome(
  attemptId: number,
): Promise<PromotionOutcome> {
  const none: PromotionOutcome = {
    promoted: false,
    fromLevelId: null,
    toLevelId: null,
    toLevelCode: null,
    toLevelName: null,
    toLevelNameAr: null,
    curriculumCompleted: false,
  };

  const [attempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, attemptId))
    .limit(1);

  // `passed` stays null while any block is still awaiting an AI or teacher
  // verdict. Withholding promotion until every block has one is the point:
  // a student must not be moved up on a partial score.
  if (!attempt || attempt.passed !== true) return none;

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, attempt.quizId))
    .limit(1);

  if (!quiz || quiz.kind !== "level_evaluation" || quiz.levelId === null) {
    return none;
  }

  const [level] = await db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.id, quiz.levelId))
    .limit(1);

  if (!level) return none;

  const [profile] = await db
    .select({
      currentLevelId: studentProfilesTable.currentLevelId,
      curriculumId: studentProfilesTable.curriculumId,
    })
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, attempt.userId))
    .limit(1);

  // Only the gate on the level the student is actually standing on promotes
  // them. Passing an old level's evaluation again changes nothing.
  if (!profile?.curriculumId || profile.currentLevelId !== level.id) {
    return none;
  }

  const [nextLevel] = await db
    .select()
    .from(levelsTable)
    .where(
      and(
        eq(levelsTable.curriculumId, level.curriculumId),
        sql`${levelsTable.order} > ${level.order}`,
      ),
    )
    .orderBy(asc(levelsTable.order))
    .limit(1);

  // Passing the last level's evaluation finishes the curriculum. There is
  // nowhere to promote to, and inventing a level would be worse than saying so.
  if (!nextLevel) {
    return { ...none, curriculumCompleted: true, fromLevelId: level.id };
  }

  const result = await setStudentLevel({
    userId: attempt.userId,
    curriculumId: profile.curriculumId,
    toLevelId: nextLevel.id,
    reason: "evaluation",
    quizAttemptId: attempt.id,
  });

  // Already applied by an earlier call.
  if (!result) return none;

  return {
    promoted: true,
    fromLevelId: result.fromLevelId,
    toLevelId: nextLevel.id,
    toLevelCode: nextLevel.code,
    toLevelName: nextLevel.name,
    toLevelNameAr: nextLevel.nameAr,
    curriculumCompleted: false,
  };
}

// ─── Remediation after a failure ──────────────────────────────────────────────

export interface RemediationLesson {
  lessonId: number;
  title: string;
  titleAr: string;
  bestScore: number | null;
  attempts: number;
}

/**
 * Order the lessons of a level by how badly they need redoing.
 *
 * Weakest first — a lesson scraped through at 60% needs the work more than one
 * passed at 90%. Lessons never attempted sort last with a null score, because
 * "you skipped this" is a weaker signal than "you struggled with this"; ties
 * fall back to curriculum order so the list reads in the order it is taught.
 */
export function rankRemediation(
  lessons: Array<{ id: number; title: string; titleAr: string; order: number }>,
  progress: Array<{ lessonId: number; bestScore: number | null; attempts: number }>,
  limit = 5,
): RemediationLesson[] {
  const byLesson = new Map(progress.map((p) => [p.lessonId, p]));

  return lessons
    .map((l) => {
      const p = byLesson.get(l.id);
      return {
        lessonId: l.id,
        title: l.title,
        titleAr: l.titleAr,
        bestScore: p?.bestScore ?? null,
        attempts: p?.attempts ?? 0,
        order: l.order,
      };
    })
    .sort((a, b) => {
      const aScore = a.bestScore ?? Number.POSITIVE_INFINITY;
      const bScore = b.bestScore ?? Number.POSITIVE_INFINITY;
      if (aScore !== bScore) return aScore - bScore;
      return a.order - b.order;
    })
    .slice(0, limit)
    .map(({ order: _order, ...rest }) => rest);
}

/**
 * What a student who failed an evaluation should redo, drawn entirely from the
 * curriculum they have already been given (spec sections 8 and 9: recommend
 * existing resources, never invent a new path).
 */
export async function getLevelRemediation(
  userId: number,
  levelId: number,
  limit = 5,
): Promise<RemediationLesson[]> {
  const lessons = await db
    .select({
      id: lessonsTable.id,
      title: lessonsTable.title,
      titleAr: lessonsTable.titleAr,
      order: lessonsTable.order,
    })
    .from(lessonsTable)
    // Only lessons the student can open are worth recommending.
    .where(
      and(
        eq(lessonsTable.levelId, levelId),
        lessonTrackFilter(await getEntitlement(userId)),
        publishedLessonFilter(),
      ),
    )
    .orderBy(asc(lessonsTable.order));

  if (lessons.length === 0) return [];

  const progress = await db
    .select({
      lessonId: lessonProgressTable.lessonId,
      bestScore: lessonProgressTable.bestScore,
      attempts: lessonProgressTable.attempts,
    })
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        inArray(lessonProgressTable.lessonId, lessons.map((l) => l.id)),
      ),
    );

  return rankRemediation(lessons, progress, limit);
}

// ─── History ──────────────────────────────────────────────────────────────────

export async function getProgressionHistory(userId: number) {
  const rows = await db
    .select({
      id: levelProgressionsTable.id,
      reason: levelProgressionsTable.reason,
      note: levelProgressionsTable.note,
      createdAt: levelProgressionsTable.createdAt,
      fromLevelId: levelProgressionsTable.fromLevelId,
      toLevelId: levelProgressionsTable.toLevelId,
    })
    .from(levelProgressionsTable)
    .where(eq(levelProgressionsTable.userId, userId))
    .orderBy(desc(levelProgressionsTable.createdAt));

  if (rows.length === 0) return [];

  const levelIds = [
    ...new Set(
      rows.flatMap((r) => [r.fromLevelId, r.toLevelId]).filter((id): id is number => id !== null),
    ),
  ];

  const levels = await db
    .select({
      id: levelsTable.id,
      code: levelsTable.code,
      name: levelsTable.name,
      nameAr: levelsTable.nameAr,
    })
    .from(levelsTable)
    .where(inArray(levelsTable.id, levelIds));

  const byId = new Map(levels.map((l) => [l.id, l]));

  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    note: r.note,
    createdAt: r.createdAt,
    fromLevel: r.fromLevelId ? (byId.get(r.fromLevelId) ?? null) : null,
    toLevel: byId.get(r.toLevelId) ?? null,
  }));
}
