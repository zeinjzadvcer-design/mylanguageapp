/**
 * Announcements an admin writes and sends to students.
 *
 * WHO RECEIVES ONE
 * ────────────────
 * Every student, or the students on chosen plans. A student's plan is the one
 * in force now: an active subscription that has not expired, or "free" when
 * there is none. That is the rule the lesson paywall uses (see
 * `subscriptionInForce`), so a payment still awaiting review or a lapsed plan
 * does not count. Staff are never included.
 *
 * Recipients are fixed when it is sent. A student who subscribes afterwards
 * does not receive an older announcement, the same as someone joining a
 * mailing list later.
 *
 * Each recipient gets an ordinary notification of kind "announcement", made in
 * the same transaction as the record of the send, so the bell needs nothing new
 * and a failed send leaves neither half behind.
 */

import { desc, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  announcementsTable,
  subscriptionPlansTable,
  usersTable,
} from "@workspace/db";

/** Every student, or only those on these plans ("free" included). */
export type Audience = { kind: "all" } | { kind: "plans"; planCodes: string[] };

export interface AnnouncementInput {
  title: string | null;
  titleAr: string | null;
  body: string | null;
  bodyAr: string | null;
  link: string | null;
  audience: Audience;
}

/**
 * The plans an announcement can be aimed at, grouped by track for the screen.
 *
 * `free` is listed with the general track because free students get general
 * lessons, but it is its own choice: an announcement meant for paying general
 * students should not reach free ones unless the admin says so.
 */
export async function audiencePlans() {
  const plans = await db
    .select({
      code: subscriptionPlansTable.code,
      name: subscriptionPlansTable.name,
      nameAr: subscriptionPlansTable.nameAr,
      track: subscriptionPlansTable.lessonTrack,
    })
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.isActive, true))
    .orderBy(subscriptionPlansTable.priceUsd);
  return plans;
}

/**
 * The plan codes an audience names, or null for every student.
 *
 * Unknown codes are dropped rather than trusted, and an audience whose codes
 * are all unknown names nobody: it must never widen to everyone by accident.
 */
export function audiencePlanCodes(audience: Audience, knownCodes: readonly string[]): string[] | null {
  if (audience.kind === "all") return null;
  const known = new Set(knownCodes);
  return [...new Set(audience.planCodes)].filter((code) => known.has(code));
}

/** The students an audience reaches, as a subquery of user ids. */
function recipientsQuery(planCodes: string[] | null): SQL {
  const planFilter =
    planCodes === null
      ? sql`true`
      : planCodes.length === 0
        ? sql`false`
        : sql`COALESCE(current_plan.plan_code, 'free') IN (${sql.join(
            planCodes.map((code) => sql`${code}`),
            sql`, `,
          )})`;

  return sql`
    SELECT u.id
    FROM ${usersTable} u
    LEFT JOIN LATERAL (
      SELECT s.plan_code
      FROM student_subscriptions s
      WHERE s.user_id = u.id
        AND s.status = 'active'
        AND (s.expires_at IS NULL OR s.expires_at > now())
      ORDER BY s.started_at DESC
      LIMIT 1
    ) current_plan ON true
    WHERE u.role = 'student' AND ${planFilter}
  `;
}

/** How many students an audience reaches right now, for the screen to show before sending. */
export async function countRecipients(audience: Audience): Promise<number> {
  const plans = await audiencePlans();
  const codes = audiencePlanCodes(audience, plans.map((p) => p.code));
  const result = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM (${recipientsQuery(codes)}) recipients`,
  );
  return result.rows[0]?.count ?? 0;
}

/** Send it: record the announcement and give each recipient their notification. */
export async function sendAnnouncement(
  input: AnnouncementInput,
  sentBy: number,
): Promise<{ id: number; recipients: number }> {
  const plans = await audiencePlans();
  const codes = audiencePlanCodes(input.audience, plans.map((p) => p.code));

  return db.transaction(async (tx) => {
    const [announcement] = await tx
      .insert(announcementsTable)
      .values({
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        link: input.link,
        planCodes: codes,
        createdBy: sentBy,
      })
      .returning();

    const data = JSON.stringify({
      announcementId: announcement!.id,
      title: input.title,
      titleAr: input.titleAr,
      body: input.body,
      bodyAr: input.bodyAr,
    });

    // The dedupe key makes a retried send a no-op per student rather than a
    // second copy.
    const sent = await tx.execute(sql`
      INSERT INTO notifications (user_id, kind, data, link, dedupe_key)
      SELECT recipients.id, 'announcement', ${data}::jsonb, ${input.link},
             ${`announcement:${announcement!.id}`}
      FROM (${recipientsQuery(codes)}) recipients
      ON CONFLICT (user_id, dedupe_key) DO NOTHING
    `);
    const recipients = sent.rowCount ?? 0;

    await tx
      .update(announcementsTable)
      .set({ recipientCount: recipients })
      .where(eq(announcementsTable.id, announcement!.id));

    return { id: announcement!.id, recipients };
  });
}

/** What was sent, newest first, for the admin screen. */
export async function listAnnouncements(limit = 50) {
  const rows = await db
    .select({
      id: announcementsTable.id,
      title: announcementsTable.title,
      titleAr: announcementsTable.titleAr,
      body: announcementsTable.body,
      bodyAr: announcementsTable.bodyAr,
      link: announcementsTable.link,
      planCodes: announcementsTable.planCodes,
      recipientCount: announcementsTable.recipientCount,
      createdAt: announcementsTable.createdAt,
      sentByName: usersTable.name,
    })
    .from(announcementsTable)
    .leftJoin(usersTable, eq(usersTable.id, announcementsTable.createdBy))
    .orderBy(desc(announcementsTable.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
