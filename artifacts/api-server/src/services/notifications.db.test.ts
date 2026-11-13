import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The notification SQL, against a real database: who a published quiz is
 * announced to, what a level change adds, who the daily reminder reaches, and
 * that nothing is sent twice.
 *
 * Skipped unless NOTIFICATIONS_DB_TEST=1, with DATABASE_URL pointing at a
 * migrated and seeded database (scripts/migrate.mjs, then scripts/seed.mjs). It
 * creates its own accounts, lessons and quizzes and deletes them afterwards;
 * students already in that database may also receive the test quizzes and the
 * test reminder date, and those notifications are deleted too.
 */
const enabled = process.env.NOTIFICATIONS_DB_TEST === "1";

describe.skipIf(!enabled)("notifications against a database", async () => {
  const { pool } = await import("@workspace/db");
  const n = await import("./notifications");
  const { quizDedupeKey, reminderDedupeKey } = await import("./notification-policy");

  const tag = `ntest-${Date.now()}`;
  // 19:00 in Damascus on a date nothing else uses, inside the reminder window.
  const evening = new Date("2030-01-15T16:00:00Z");
  const reminderKey = reminderDedupeKey("2030-01-15");

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await pool.query(text, params)).rows as T[];

  let curriculumId: number;
  let levels: Array<{ id: number; order: number }>;
  const users: Record<string, number> = {};
  const quizIds: number[] = [];
  let lessonId: number;

  async function student(name: string, opts: { level?: number | null; placed?: boolean; curriculum?: number | null; reminders?: boolean }) {
    const [u] = await q<{ id: number }>(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', 'student') RETURNING id`,
      [name, `${name}-${tag}@example.test`],
    );
    await q(
      `INSERT INTO student_profiles (user_id, curriculum_id, current_level_id, placement_completed, lesson_reminders)
       VALUES ($1, $2, $3, $4, $5)`,
      [u.id, opts.curriculum === undefined ? curriculumId : opts.curriculum, opts.level ?? null, opts.placed ?? false, opts.reminders ?? true],
    );
    users[name] = u.id;
    return u.id;
  }

  async function quiz(levelId: number) {
    const [row] = await q<{ id: number }>(
      `INSERT INTO quizzes (title, title_ar, level_id, kind, status) VALUES ($1, $2, $3, 'practice', 'published') RETURNING id`,
      [`Quiz ${tag}`, `اختبار ${tag}`, levelId],
    );
    quizIds.push(row.id);
    return row.id;
  }

  const kinds = async (userId: number, kind: string) =>
    (await q<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM notifications WHERE user_id = $1 AND kind = $2`,
      [userId, kind],
    )).map((r) => r.dedupe_key);

  async function moveLevel(userId: number, from: number | null, to: number) {
    await q(
      `INSERT INTO level_progressions (user_id, curriculum_id, from_level_id, to_level_id, reason, note)
       VALUES ($1, $2, $3, $4, 'placement', 'notification test')`,
      [userId, curriculumId, from, to],
    );
    await q(`UPDATE student_profiles SET current_level_id = $2, placement_completed = true WHERE user_id = $1`, [userId, to]);
  }

  beforeAll(async () => {
    const [first] = await q<{ curriculum_id: number }>(
      `SELECT curriculum_id FROM levels GROUP BY curriculum_id HAVING count(*) >= 3 ORDER BY curriculum_id LIMIT 1`,
    );
    if (!first) throw new Error("Needs a seeded curriculum with at least three levels");
    curriculumId = first.curriculum_id;
    levels = await q<{ id: number; order: number }>(
      `SELECT id, "order" FROM levels WHERE curriculum_id = $1 ORDER BY "order" LIMIT 3`,
      [curriculumId],
    );
    const [lesson] = await q<{ id: number }>(
      `INSERT INTO lessons (level_id, title, title_ar, "order") VALUES ($1, $2, $3, 999) RETURNING id`,
      [levels[0].id, `Lesson ${tag}`, `درس ${tag}`],
    );
    lessonId = lesson.id;
  });

  afterAll(async () => {
    const ids = Object.values(users);
    if (quizIds.length) {
      await q(`DELETE FROM notifications WHERE dedupe_key = ANY($1)`, [quizIds.map(quizDedupeKey)]);
      await q(`DELETE FROM quizzes WHERE id = ANY($1)`, [quizIds]);
    }
    await q(`DELETE FROM notifications WHERE dedupe_key = $1`, [reminderKey]);
    if (ids.length) await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
    if (lessonId) await q(`DELETE FROM lessons WHERE id = $1`, [lessonId]);
  });

  it("announces a published quiz to the students who can see it, once", async () => {
    const [l1, l2, l3] = levels;
    const low = await student("low", { level: l1.id, placed: true });
    const high = await student("high", { level: l3.id, placed: true });
    const unplaced = await student("unplaced", {});
    const elsewhere = await student("elsewhere", { curriculum: null, level: null });

    const atL2 = await quiz(l2.id);
    await n.notifyQuizPublished(atL2);
    expect(await kinds(high, "quiz_available")).toContain(quizDedupeKey(atL2));
    expect(await kinds(low, "quiz_available")).not.toContain(quizDedupeKey(atL2));
    expect(await kinds(unplaced, "quiz_available")).not.toContain(quizDedupeKey(atL2));

    const atL1 = await quiz(l1.id);
    await n.notifyQuizPublished(atL1);
    for (const id of [low, high, unplaced]) {
      expect(await kinds(id, "quiz_available")).toContain(quizDedupeKey(atL1));
    }
    expect(await kinds(elsewhere, "quiz_available")).toHaveLength(0);

    // Publishing again, after an unpublish, says nothing new.
    await n.notifyQuizPublished(atL1);
    expect((await kinds(low, "quiz_available")).filter((k) => k === quizDedupeKey(atL1))).toHaveLength(1);
  });

  it("announces what a level change adds to the list, and nothing on a move down", async () => {
    const [l1, l2, l3] = levels;
    const atL2 = quizIds[0];
    const climber = await student("climber", { level: l1.id, placed: true });
    const faller = await student("faller", { level: l3.id, placed: true });
    const since = new Date(Date.now() - 60_000);

    await moveLevel(climber, l1.id, l3.id);
    await moveLevel(faller, l3.id, l1.id);
    await n.notifyQuizzesAfterLevelChanges(since);

    // Level 2 came into the climber's list; level 1 was already in it.
    expect(await kinds(climber, "quiz_available")).toEqual([quizDedupeKey(atL2)]);
    expect(await kinds(faller, "quiz_available")).toHaveLength(0);

    // Run again: nothing repeats.
    await n.notifyQuizzesAfterLevelChanges(since);
    expect(await kinds(climber, "quiz_available")).toHaveLength(1);
    void l2;
  });

  it("reminds students with a lesson they can open, once, and nobody else", async () => {
    const l1 = levels[0].id;
    const fresh = await student("fresh", { level: l1, placed: true });
    const usedUp = await student("usedup", { level: l1, placed: true });
    const midway = await student("midway", { level: l1, placed: true });
    const optedOut = await student("optedout", { level: l1, placed: true, reminders: false });
    const studied = await student("studied", { level: l1, placed: true });
    const notPlaced = await student("notplaced", {});

    // The free plan's one lesson, started and passed: nothing left to open.
    await q(
      `INSERT INTO lesson_progress (user_id, lesson_id, started_at, completed_at, passed) VALUES ($1, $2, now(), now(), true)`,
      [usedUp, lessonId],
    );
    // Started and not passed: it can still be finished.
    await q(`INSERT INTO lesson_progress (user_id, lesson_id, started_at) VALUES ($1, $2, now())`, [midway, lessonId]);
    // Touched a lesson that evening.
    await q(
      `INSERT INTO lesson_progress (user_id, lesson_id, started_at, updated_at) VALUES ($1, $2, now(), $3)`,
      [studied, lessonId, new Date("2030-01-15T10:00:00Z")],
    );

    await n.sendLessonReminders(evening);
    const got = async (id: number) => (await kinds(id, "lesson_reminder")).includes(reminderKey);
    expect(await got(fresh)).toBe(true);
    expect(await got(midway)).toBe(true);
    expect(await got(notPlaced)).toBe(true);
    expect(await got(usedUp)).toBe(false);
    expect(await got(optedOut)).toBe(false);
    expect(await got(studied)).toBe(false);

    const [placementLink] = await q<{ link: string }>(
      `SELECT link FROM notifications WHERE user_id = $1 AND dedupe_key = $2`,
      [notPlaced, reminderKey],
    );
    expect(placementLink.link).toBe("/placement");

    expect(await n.sendLessonReminders(evening)).toBe(0);
  });

  it("lets a student mark only their own notification read", async () => {
    const owner = users.fresh;
    const other = users.midway;
    const [row] = await q<{ id: number }>(
      `SELECT id FROM notifications WHERE user_id = $1 AND dedupe_key = $2`,
      [owner, reminderKey],
    );
    expect(await n.markRead(other, row.id)).toBe(false);
    expect(await n.unreadCount(owner)).toBeGreaterThan(0);
    expect(await n.markRead(owner, row.id)).toBe(true);
    const [after] = await q<{ read_at: Date | null }>(`SELECT read_at FROM notifications WHERE id = $1`, [row.id]);
    expect(after.read_at).not.toBeNull();
  });
});
