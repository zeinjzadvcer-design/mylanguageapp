import {
  pgTable, text, serial, integer, boolean, timestamp, real, numeric, jsonb,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { mediaAssetsTable } from "./cms";

export const subscriptionPlansTable = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  code: text("code", { enum: ["free", "general_english", "professional_english"] }).notNull().unique(),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull(),
  description: text("description"),
  descriptionAr: text("description_ar"),
  priceUsd: real("price_usd").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  billingCycle: text("billing_cycle", { enum: ["monthly", "yearly"] }).notNull().default("monthly"),
  features: text("features").array().notNull().default([]),
  featuresAr: text("features_ar").array().notNull().default([]),
  includesConversationPartner: boolean("includes_conversation_partner").notNull().default(false),
  /**
   * Which content track this plan unlocks, matched against `lessons.lessonType`.
   *
   * The tracks are mutually exclusive, not nested: a `general` subscriber must
   * not see professional lessons and a `professional` subscriber must not see
   * general ones. Plain text rather than an enum, matching `lessons.lessonType`
   * — that column was deliberately widened from a pgEnum so a new lesson type
   * needs only an INSERT (docs/multi-curriculum-arch.md).
   */
  lessonTrack: text("lesson_track").notNull().default("general"),
  /**
   * How many distinct lessons a subscriber may start. `null` means unlimited.
   *
   * 1 on the free plan: the single trial lesson a student gets after placement,
   * before everything locks.
   */
  freeLessonQuota: integer("free_lesson_quota"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SubscriptionPlan = typeof subscriptionPlansTable.$inferSelect;

export const studentSubscriptionsTable = pgTable("student_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  planCode: text("plan_code").notNull(),
  planName: text("plan_name").notNull(),
  planNameAr: text("plan_name_ar").notNull(),
  status: text("status", { enum: ["active", "pending_payment", "expired", "cancelled"] }).notNull().default("pending_payment"),
  paymentMethod: text("payment_method"),
  paymentReference: text("payment_reference"),
  paymentNote: text("payment_note"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /**
   * The subscription this one replaced on activation. Null for a first
   * subscription.
   *
   * Superseding happens inside the activation transaction, never at request
   * time: cancelling the current plan before the new one is paid for would
   * downgrade a student who abandons an upgrade.
   */
  supersedesId: integer("supersedes_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type StudentSubscription = typeof studentSubscriptionsTable.$inferSelect;

/**
 * A claimed payment awaiting verification.
 *
 * Both methods land here. A ShamCash row carries a receipt image an admin
 * reviews; a crypto row carries a transaction hash checked on-chain, and falls
 * back to the same admin queue when that check is inconclusive.
 */
export const paymentSubmissionsTable = pgTable("payment_submissions", {
  id: serial("id").primaryKey(),
  subscriptionId: integer("subscription_id")
    .notNull()
    .references(() => studentSubscriptionsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  method: text("method", { enum: ["sham_cash", "crypto_usdt_bep20"] }).notNull(),
  status: text("status", {
    enum: ["pending", "verifying", "approved", "rejected"],
  }).notNull().default("pending"),

  /**
   * What the plan cost when the student paid, not what it costs now. A price
   * change between submission and review must not invalidate a payment that
   * was correct when it was made.
   *
   * `numeric` reaches the driver as a string; parse it rather than relying on
   * JavaScript number coercion.
   */
  amountExpected: numeric("amount_expected", { precision: 12, scale: 2 }).notNull(),

  /** ShamCash: the transfer receipt the student uploaded. */
  receiptMediaId: integer("receipt_media_id").references(() => mediaAssetsTable.id, {
    onDelete: "set null",
  }),
  studentNote: text("student_note"),

  /** Crypto: the transaction the student says they sent. Unique when present. */
  txHash: text("tx_hash"),
  /** 18 decimals, because that is what BEP-20 USDT carries. Never a float. */
  amountObserved: numeric("amount_observed", { precision: 38, scale: 18 }),
  /**
   * Kept although matching deliberately ignores it: sanctions screening needs
   * to know who paid even when access control does not.
   */
  senderAddress: text("sender_address"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

  reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
  /** Why the automatic check passed or failed, for the admin looking at it. */
  verificationLog: jsonb("verification_log"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => ({
  /**
   * A transaction hash buys exactly one subscription, ever.
   *
   * Without this one student pays once and shares the hash, or replays it
   * monthly — and the on-chain check would confirm it every time, because the
   * transaction really is real. Case-insensitive because hex arrives in mixed
   * case; partial so ShamCash rows, which have no hash, do not collide on NULL.
   */
  txHashUnique: uniqueIndex("payment_submissions_tx_hash_key")
    .on(sql`lower(${table.txHash})`)
    .where(sql`${table.txHash} is not null`),
  statusIdx: index("payment_submissions_status_idx").on(table.status, table.createdAt),
  userIdx: index("payment_submissions_user_idx").on(table.userId, table.createdAt),
  subscriptionIdx: index("payment_submissions_subscription_idx").on(table.subscriptionId),
}));

export type PaymentSubmission = typeof paymentSubmissionsTable.$inferSelect;

/**
 * The ShamCash receive details students see. Singleton: `id` is always 1.
 *
 * Admin-editable, unlike the crypto wallet address which lives in env. The
 * difference is the human: an admin reads every ShamCash receipt before any
 * subscription activates, so a swapped QR surfaces as receipts naming an
 * unfamiliar account. The crypto path has no such review, which makes its
 * address a trust anchor that must not be changeable from the app.
 */
export const paymentSettingsTable = pgTable("payment_settings", {
  id: integer("id").primaryKey().default(1),
  /** Admin-uploaded receive QR, purpose `payment_qr`, owned by nobody. */
  shamCashQrMediaId: integer("sham_cash_qr_media_id").references(
    () => mediaAssetsTable.id,
    { onDelete: "set null" },
  ),
  /** Shown beside the QR so a student can confirm the account before paying. */
  shamCashAccountName: text("sham_cash_account_name"),
  shamCashAccountNumber: text("sham_cash_account_number"),
  /** Arabic payment instructions. Data, because wallet UIs change often. */
  shamCashInstructionsAr: text("sham_cash_instructions_ar"),
  /** These settings decide where money goes; changes must be attributable. */
  updatedBy: integer("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PaymentSettings = typeof paymentSettingsTable.$inferSelect;
