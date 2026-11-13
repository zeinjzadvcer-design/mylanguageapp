/**
 * Student notifications: creating them, reading them, and the sweep that sends
 * the ones nobody's action triggers.
 *
 * Three things notify a student:
 *   - a decision on their payment (approved or rejected), from
 *     subscription-activation.ts, whoever or whatever made it;
 *   - a quiz they can now take: when one is published at a level they have
 *     reached, when they reach a level that has quizzes, and when their level
 *     test opens;
 *   - the daily lesson reminder.
 *
 * Sending never throws. A notification is a courtesy: a failure to record one
 * must not undo a payment approval or a lesson completion, so every entry point
 * here catches and logs.
 *
 * Every insert carries a dedupe key, and the unique index on
 * (user_id, dedupe_key) turns a repeat into a no-op. That is what makes the
 * sweep safe to run often and on several instances at once.
 */

import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  lessonBlockProgressTable,
  lessonProgressTable,
  levelProgressionsTable,
  levelsTable,
  notificationsTable,
  quizAttemptsTable,
  quizzesTable,
  studentProfilesTable,
  usersTable,
  type NotificationKind,
} from "@workspace/db";
import { getEvaluationEligibility, getLevelEvaluation } from "./progression";
import { countLessonsStarted, getEntitlement } from "./entitlements";
import { studentLessonView } from "./free-lesson";
import {
  NOTIFICATION_RETENTION_DAYS,
  REMINDER_TIMEZONE,
  REMINDER_TIMEZONE_REJECTED,
  evaluationDedupeKey,
  hasLessonToStudy,
  quizDedupeKey,
  reminderDedupeKey,
  reminderWindow,
} from "./notification-policy";
import { logger } from "../lib/logger";

/**
 * Where a quiz notification takes the student: the quizzes list, not the quiz.
 * Opening /quiz/:id starts an attempt, which a student only glancing at a
 * notification did not ask for.
 */
const QUIZZES_PAGE = "/quizzes";

export interface NotificationInput {
  userId: number;
  kind: NotificationKind;
  data?: Record<string, unknown>;
  link?: string | null;
  dedupeKey?: string | null;
}

/** Record one notification. Never throws; a repeat of the same key is ignored. */
export async function notify(input: NotificationInput): Promise<void> {
  try {
    await db
      .insert(notificationsTable)
      .values({
        userId: input.userId,
        kind: input.kind,
        data: input.data ?? {},
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.warn({ err, userId: input.userId, kind: input.kind }, "Could not record a notification");
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export async function listNotifications(userId: number, limit = 30) {
  const [items, unread] = await Promise.all([
    db
      .select({
        id: notificationsTable.id,
        kind: notificationsTable.kind,
        data: notificationsTable.data,
        link: notificationsTable.link,
        readAt: notificationsTable.readAt,
        createdAt: notificationsTable.createdAt,
      })
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, userId))
      .orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id))
      .limit(limit),
    unreadCount(userId),
  ]);
  return { items, unread };
}

export async function unreadCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)));
  return row?.n ?? 0;
}

/** Mark one of the caller's own notifications read. False when it is not theirs. */
export async function markRead(userId: number, id: number): Promise<boolean> {
  const rows = await db
    .update(notificationsTable)
    .set({ readAt: sql`coalesce(${notificationsTable.readAt}, now())` })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, userId)))
    .returning({ id: notificationsTable.id });
  return rows.length > 0;
}

export async function markAllRead(userId: number): Promise<void> {
  await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.readAt)));
}

// ─── Quizzes ──────────────────────────────────────────────────────────────────

/**
 * Tell every student who can see a newly published practice quiz.
 *
 * "Can see" is the rule GET /quizzes applies: a quiz with no level is for
 * everyone; otherwise the student's level must be at or past the quiz's, and a
 * student not yet placed sees only the first level. Limited further to the
 * quiz's own curriculum, so a German quiz is not announced to English
 * students. Level tests are left out: one opens per student, when their
 * lessons are done, and notifyEvaluationIfOpen announces it then.
 */
export async function notifyQuizPublished(quizId: number): Promise<number> {
  try {
    const [quiz] = await db
      .select({
        id: quizzesTable.id,
        title: quizzesTable.title,
        titleAr: quizzesTable.titleAr,
        kind: quizzesTable.kind,
        levelId: quizzesTable.levelId,
        levelOrder: levelsTable.order,
        curriculumId: levelsTable.curriculumId,
      })
      .from(quizzesTable)
      .leftJoin(levelsTable, eq(levelsTable.id, quizzesTable.levelId))
      .where(and(eq(quizzesTable.id, quizId), eq(quizzesTable.status, "published")))
      .limit(1);
    if (!quiz || quiz.kind !== "practice") return 0;

    const data = JSON.stringify({ quizId: quiz.id, title: quiz.title, titleAr: quiz.titleAr });
    const audience =
      quiz.levelId === null || quiz.levelOrder === null
        ? sql`true`
        : sql`sp.curriculum_id = ${quiz.curriculumId} AND (
            (cur."order" IS NULL AND ${quiz.levelOrder} <= 1) OR cur."order" >= ${quiz.levelOrder}
          )`;

    const result = await db.execute(sql`
      INSERT INTO notifications (user_id, kind, data, link, dedupe_key)
      SELECT u.id, 'quiz_available', ${data}::jsonb, ${QUIZZES_PAGE}, ${quizDedupeKey(quiz.id)}
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN levels cur ON cur.id = sp.current_level_id
      WHERE u.role = 'student' AND ${audience}
        AND NOT EXISTS (
          SELECT 1 FROM quiz_attempts qa WHERE qa.quiz_id = ${quiz.id} AND qa.user_id = u.id
        )
      ON CONFLICT (user_id, dedupe_key) DO NOTHING
    `);
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err, quizId }, "Could not announce a published quiz");
    return 0;
  }
}

/**
 * Tell students about the practice quizzes a level change has just put in
 * their list, by placement, promotion or an admin's override.
 *
 * "Just put in their list" follows GET /quizzes, which shows every quiz at or
 * below the student's level: the quizzes above the level they came from (or
 * above the first level, for a student not placed before) and at or below the
 * level they reached, in the same curriculum. Moving down adds nothing. The
 * student's current level is checked too, so a promotion undone within the
 * look-back window does not announce what they can no longer see.
 *
 * Run by the sweep over recent level changes rather than at each of the places
 * a level changes: several of them do it inside a transaction, where a failed
 * insert would abort the promotion with it. A few minutes' delay is the price,
 * and the dedupe key means a quiz already announced is not announced again.
 */
export async function notifyQuizzesAfterLevelChanges(since: Date): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO notifications (user_id, kind, data, link, dedupe_key)
    SELECT DISTINCT ON (lp.user_id, q.id)
      lp.user_id,
      'quiz_available',
      jsonb_build_object('quizId', q.id, 'title', q.title, 'titleAr', q.title_ar),
      ${QUIZZES_PAGE},
      'quiz:' || q.id
    FROM ${levelProgressionsTable} lp
    JOIN ${usersTable} u ON u.id = lp.user_id AND u.role = 'student'
    JOIN ${studentProfilesTable} sp ON sp.user_id = lp.user_id
    JOIN ${levelsTable} cur ON cur.id = sp.current_level_id
    JOIN ${levelsTable} reached ON reached.id = lp.to_level_id
    LEFT JOIN ${levelsTable} came_from ON came_from.id = lp.from_level_id
    JOIN ${levelsTable} ql
      ON ql.curriculum_id = reached.curriculum_id
     AND ql."order" <= reached."order"
     AND ql."order" <= cur."order"
     AND ql."order" > COALESCE(came_from."order", 1)
    JOIN ${quizzesTable} q
      ON q.level_id = ql.id
     AND q.kind = 'practice'
     AND q.status = 'published'
     AND q.soft_deleted_at IS NULL
    WHERE lp.created_at >= ${since}
      AND NOT EXISTS (
        SELECT 1 FROM ${quizAttemptsTable} qa WHERE qa.quiz_id = q.id AND qa.user_id = lp.user_id
      )
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `);
  return result.rowCount ?? 0;
}

/**
 * Tell a student their level test has opened, if it just did.
 *
 * Called after every passed lesson, so the cheap questions come first: a level
 * with no published test, or a test already announced to this student, stops
 * here before the eligibility check and its several queries. Asking the same
 * eligibility rule the quiz page uses keeps the two from disagreeing.
 */
export async function notifyEvaluationIfOpen(userId: number, levelId: number): Promise<void> {
  try {
    const quiz = await getLevelEvaluation(levelId);
    if (!quiz) return;
    const [announced] = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.userId, userId),
          eq(notificationsTable.dedupeKey, evaluationDedupeKey(quiz.id)),
        ),
      )
      .limit(1);
    if (announced) return;
    const eligibility = await getEvaluationEligibility(userId, levelId);
    if (!eligibility.eligible) return;
    await notify({
      userId,
      kind: "evaluation_available",
      data: { quizId: quiz.id, title: quiz.title, titleAr: quiz.titleAr },
      link: QUIZZES_PAGE,
      dedupeKey: evaluationDedupeKey(quiz.id),
    });
  } catch (err) {
    logger.warn({ err, userId, levelId }, "Could not check whether a level test opened");
  }
}

// ─── Daily reminder ───────────────────────────────────────────────────────────

/**
 * Students this instance has already checked today and found with no lesson
 * they can open, so later sweeps the same day do not check them again. Cleared
 * when the local day changes.
 */
const noLessonToday = { dateKey: "", userIds: new Set<number>() };

/**
 * Whether a placed student has a lesson they can actually open now, by the
 * rules the lesson pages apply: their plan, the free lesson, and the lessons
 * they have already started.
 */
async function canStudyNow(userId: number, curriculumId: number | null): Promise<boolean> {
  const entitlement = await getEntitlement(userId, "student");
  if (entitlement.unlimited) return true;
  const view = await studentLessonView(entitlement, curriculumId);

  const [unpassed] = await db
    .select({ id: lessonProgressTable.id })
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        isNotNull(lessonProgressTable.startedAt),
        sql`coalesce(${lessonProgressTable.passed}, false) = false`,
      ),
    )
    .limit(1);

  let freeLessonPassed = false;
  if (view.freeOnly && view.freeLessonId !== null) {
    const [free] = await db
      .select({ passed: lessonProgressTable.passed })
      .from(lessonProgressTable)
      .where(and(eq(lessonProgressTable.userId, userId), eq(lessonProgressTable.lessonId, view.freeLessonId)))
      .limit(1);
    freeLessonPassed = free?.passed === true;
  }

  const lessonsStarted =
    !view.freeOnly && entitlement.lessonQuota !== null
      ? await countLessonsStarted(userId, entitlement.periodStartedAt)
      : 0;

  return hasLessonToStudy({
    unlimited: entitlement.unlimited,
    hasUnpassedStartedLesson: Boolean(unpassed),
    freeOnly: view.freeOnly,
    freeLessonPassed,
    lessonQuota: entitlement.lessonQuota,
    lessonsStarted,
  });
}

/**
 * Remind every student who has not studied today, once per local day.
 *
 * "Studied" means a lesson or a lesson block was touched since local midnight.
 * A student who has not taken the placement test is sent there instead, since
 * no lesson opens before it. Skipped: students who turned reminders off, those
 * already reminded today, and those with no lesson their plan lets them open —
 * a reminder they cannot act on is only a nag.
 *
 * Students already reminded are left out of the query, through the unique
 * index, so the sweeps after the first in an evening cost little.
 */
export async function sendLessonReminders(now: Date = new Date()): Promise<number> {
  const window = reminderWindow(now);
  if (!window.due) return 0;

  if (noLessonToday.dateKey !== window.dateKey) {
    noLessonToday.dateKey = window.dateKey;
    noLessonToday.userIds.clear();
  }
  const key = reminderDedupeKey(window.dateKey);
  // A Postgres array literal: an interpolated JS array would be expanded into
  // a list of parameters instead of one array.
  const alreadyChecked = `{${[...noLessonToday.userIds].join(",")}}`;

  const candidates = await db.execute(sql`
    SELECT u.id, sp.placement_completed AS placed, sp.curriculum_id
    FROM ${usersTable} u
    JOIN ${studentProfilesTable} sp ON sp.user_id = u.id
    WHERE u.role = 'student'
      AND sp.lesson_reminders = true
      AND u.id <> ALL(${alreadyChecked}::int[])
      AND NOT EXISTS (
        SELECT 1 FROM ${notificationsTable} n WHERE n.user_id = u.id AND n.dedupe_key = ${key}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${lessonProgressTable} lp
        WHERE lp.user_id = u.id AND lp.updated_at >= ${window.dayStart}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${lessonBlockProgressTable} bp
        WHERE bp.user_id = u.id AND bp.updated_at >= ${window.dayStart}
      )
  `);

  const due: Array<{ userId: number; placed: boolean }> = [];
  for (const row of candidates.rows as Array<{ id: number; placed: boolean; curriculum_id: number | null }>) {
    if (!row.placed || (await canStudyNow(row.id, row.curriculum_id))) {
      due.push({ userId: row.id, placed: row.placed });
    } else {
      noLessonToday.userIds.add(row.id);
    }
  }

  let sent = 0;
  for (let i = 0; i < due.length; i += 500) {
    const rows = await db
      .insert(notificationsTable)
      .values(
        due.slice(i, i + 500).map((d) => ({
          userId: d.userId,
          kind: "lesson_reminder" as const,
          data: { placement: !d.placed },
          link: d.placed ? "/learn" : "/placement",
          dedupeKey: key,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notificationsTable.id });
    sent += rows.length;
  }
  if (sent > 0) logger.info({ sent, date: window.dateKey }, "Lesson reminders sent");
  return sent;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** Null when the account has no student profile, and so nothing to remind. */
export async function getReminderSetting(userId: number): Promise<boolean | null> {
  const [row] = await db
    .select({ on: studentProfilesTable.lessonReminders })
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);
  return row ? row.on : null;
}

export async function setReminderSetting(userId: number, on: boolean): Promise<boolean> {
  const rows = await db
    .update(studentProfilesTable)
    .set({ lessonReminders: on })
    .where(eq(studentProfilesTable.userId, userId))
    .returning({ id: studentProfilesTable.id });
  return rows.length > 0;
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS ?? 5 * 60_000);

/**
 * How far back the sweep looks for level changes. Wider than the interval, so a
 * slow or missed run is caught up by the next; the dedupe key absorbs overlap.
 */
const LEVEL_CHANGE_LOOKBACK_MS = 24 * 60 * 60_000;

/** The UTC day this instance last pruned, so pruning runs once a day, not every sweep. */
let lastPrunedDay = "";

/**
 * Delete notifications past their retention. Once a day: no index leads with
 * created_at, so the delete scans the table, which is fine daily and wasteful
 * every five minutes.
 */
async function pruneOldNotifications(now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (lastPrunedDay === day) return;
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60_000);
  await db.delete(notificationsTable).where(lt(notificationsTable.createdAt, cutoff));
  lastPrunedDay = day;
}

export async function runNotificationSweep(now: Date = new Date()): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["lesson reminders", () => sendLessonReminders(now)],
    ["quizzes after level changes", () => notifyQuizzesAfterLevelChanges(new Date(now.getTime() - LEVEL_CHANGE_LOOKBACK_MS))],
    ["pruning old notifications", () => pruneOldNotifications(now)],
  ];
  // Each step on its own, so one failing does not skip the others.
  for (const [name, step] of steps) {
    await step().catch((err) => logger.warn({ err }, `Notification sweep: ${name} failed`));
  }
}

let timer: NodeJS.Timeout | null = null;

export function startNotificationSweeper(): void {
  if (timer || process.env.NOTIFICATIONS_SWEEP_ENABLED === "false") return;
  if (REMINDER_TIMEZONE_REJECTED) {
    logger.error(
      { rejected: REMINDER_TIMEZONE_REJECTED, using: REMINDER_TIMEZONE },
      "REMINDER_TIMEZONE is not a time zone name (like Asia/Damascus); lesson reminders use the default instead",
    );
  }
  void runNotificationSweep();
  timer = setInterval(() => void runNotificationSweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "Notification sweeper started");
}

export function stopNotificationSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
