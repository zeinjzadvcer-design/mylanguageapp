import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * What a notification is about. The wording lives in the app's locale files,
 * keyed by kind, so a notification follows the student's language even when
 * they switch it after it was sent.
 */
export const NOTIFICATION_KINDS = [
  "subscription_approved",
  "subscription_rejected",
  "lesson_reminder",
  "quiz_available",
  "evaluation_available",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * In-app notifications, shown under the bell.
 *
 * `dedupe_key` makes sending idempotent: the same reminder or the same quiz is
 * never announced to one student twice, however many times a sweep runs or
 * however many server instances run it. A null key never conflicts, for
 * notifications that are allowed to repeat.
 */
export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    /** The facts the wording needs: plan names, a quiz title, a reason. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Where tapping it goes, as an app path. */
    link: text("link"),
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDedupeUnique: uniqueIndex("notifications_user_dedupe_unique").on(table.userId, table.dedupeKey),
    userCreatedIdx: index("notifications_user_created_idx").on(table.userId, table.createdAt),
    /** For the unread badge, polled every minute: answered from the index alone. */
    userUnreadIdx: index("notifications_user_unread_idx").on(table.userId).where(sql`read_at IS NULL`),
  }),
);

export type Notification = typeof notificationsTable.$inferSelect;
