import {
  pgTable, text, serial, integer, boolean, timestamp, real, numeric, jsonb,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { mediaAssetsTable } from "./cms";

export const subscriptionPlansTable = pgTable("subscription_plans", {
  id: serial("id").primaryKey(),
  /**
   * Each plan is a (track, tier) pair: two content tracks, two sizes each.
   *
   * `general_english` and `professional_english` were renamed to the `_basic`
   * tiers in migration 025 — those are the $2 and $4 plans that already
   * existed, so a current subscriber keeps the allowance they were sold.
   */
  code: text("code", {
    enum: [
      "free",
      "general_basic",
      "general_plus",
      "pro_basic",
      "pro_plus",
    ],
  }).notNull().unique(),
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
   * Lessons a subscriber may START per period. `null` is unlimited.
   *
   * The period is `quotaPeriod` below, so this one column covers both the free
   * trial's "one, ever" and the paid tiers' monthly allowance — which is what
   * separates $2 from $5 within one track.
   */
  lessonsPerMonth: integer("lessons_per_month"),
  /**
   * Whether the allowance resets.
   *
   * `lifetime` counts over the account's whole history — the free trial, so
   * the paywall still bites after one lesson. `monthly` counts from the
   * subscription's own start date. Per plan rather than inferred from price,
   * so a paid lifetime plan or a renewing free tier needs no special case.
   */
  quotaPeriod: text("quota_period").notNull().default("monthly"),
  /**
   * Peer calls a subscriber may START per monthly period. `null` is unlimited.
   *
   * `PRACTICE_DAILY_CALL_LIMIT` is unaffected: that is abuse control, applied
   * per rolling 24h to everyone. This is the allowance being sold. Both apply,
   * and whichever is stricter bites.
   */
  callsPerMonth: integer("calls_per_month"),
  /**
   * Price in Syrian pounds, for the local wallet. `null` means the wallet
   * cannot sell this plan.
   *
   * Set by an admin, never derived from `priceUsd`: the official and parallel
   * exchange rates differ by roughly 18%, so a converted figure would either
   * reject genuine payments or under-collect. `numeric` because it is money
   * compared for equality, and it reaches the driver as a string.
   */
  priceSyp: numeric("price_syp", { precision: 14, scale: 2 }),
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
  /**
   * Start of the current monthly quota period.
   *
   * Stored rather than derived from `startedAt`, which moves: activation sets
   * it when payment is confirmed and a renewal sets it again, so without a
   * fixed anchor a renewal mid-month would silently reset the allowance.
   *
   * Rolled forward a month at a time, so a subscription dormant for three
   * months catches up rather than granting one allowance for the whole gap.
   */
  periodStartedAt: timestamp("period_started_at", { withTimezone: true }),
  /**
   * The exact USDT amount held for this subscription, tag included. Nobody
   * else can be given it while it is held; see services/usdt-amount.ts.
   */
  usdtAmount: numeric("usdt_amount", { precision: 12, scale: 4 }),
  usdtAmountAt: timestamp("usdt_amount_at", { withTimezone: true }),
  /**
   * The SYP price quoted when this subscription was opened.
   *
   * With an automatic rate the price moves. A student who read 290 ل.س and
   * paid it is checked against 290, not against whatever the rate has become
   * by the time the confirmation SMS arrives.
   */
  quotedPriceSyp: numeric("quoted_price_syp", { precision: 14, scale: 2 }),
  quotedAt: timestamp("quoted_at", { withTimezone: true }),
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

  /**
   * `sham_cash` is retained but no longer offered: existing rows carry it, and
   * a payment record is a financial audit trail — rewriting it to claim a
   * student paid by a method they did not use would be worse than carrying a
   * value nothing new will write.
   */
  method: text("method", {
    enum: ["syriatel_cash", "sham_cash", "crypto_usdt_bep20"],
  }).notNull(),
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
  /** Four decimals: a USDT amount carries a tag (usdtAmountWithTag). */
  amountExpected: numeric("amount_expected", { precision: 12, scale: 4 }).notNull(),

  /** ShamCash: the transfer receipt the student uploaded. */
  receiptMediaId: integer("receipt_media_id").references(() => mediaAssetsTable.id, {
    onDelete: "set null",
  }),
  studentNote: text("student_note"),

  /**
   * Local wallet: رقم العملية from the payer's Syriatel SMS.
   *
   * A bearer secret — Syriatel sends it only to the payer and the merchant,
   * and it appears nowhere public — which is what makes an otherwise
   * unverifiable claim believable. Text, not numeric: an identifier that
   * happens to be digits, where leading zeros matter and nothing is computed.
   */
  operationNumber: text("operation_number"),
  /** What the student says they sent, in SYP. */
  amountClaimedSyp: numeric("amount_claimed_syp", { precision: 14, scale: 2 }),
  /** What they owed, snapshotted at submission like `amountExpected`. */
  amountExpectedSyp: numeric("amount_expected_syp", { precision: 14, scale: 2 }),
  /**
   * Crypto: the receiving address this submission is checked against,
   * captured when it was made. Without it, an admin changing the address
   * would re-point the verification of every payment still being checked.
   */
  expectedWalletAddress: text("expected_wallet_address"),

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
  // Rejected rows excluded: a refused claim bought nothing, and counting it
  // would burn a real payment the student is told to resubmit.
  txHashUnique: uniqueIndex("payment_submissions_tx_hash_open_key")
    .on(sql`lower(${table.txHash})`)
    .where(sql`${table.txHash} is not null and ${table.status} <> 'rejected'`),
  /**
   * One operation number buys one subscription, ever — the same control as
   * `txHashUnique`, for the same reason: without it one payment could be
   * claimed repeatedly, and every claim would verify because the payment
   * really did happen.
   */
  operationNumberUnique: uniqueIndex("payment_submissions_operation_number_open_key")
    .on(table.operationNumber)
    .where(sql`${table.operationNumber} is not null and ${table.status} <> 'rejected'`),
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
  /** Which local wallet the `wallet*` details describe. One at a time. */
  walletProvider: text("wallet_provider").notNull().default("syriatel_cash"),
  /** Admin-uploaded receive QR, purpose `payment_qr`, owned by nobody. */
  walletQrMediaId: integer("wallet_qr_media_id").references(
    () => mediaAssetsTable.id,
    { onDelete: "set null" },
  ),
  /** Shown beside the QR so a student can confirm the account before paying. */
  walletAccountName: text("wallet_account_name"),
  walletAccountNumber: text("wallet_account_number"),
  /**
   * The merchant handset that receives the confirmation SMS. Recorded so an
   * admin can see where the companion app belongs; the server never sends here.
   */
  walletMerchantPhone: text("wallet_merchant_phone"),
  /**
   * Bearer token the companion app presents when forwarding an SMS.
   *
   * While null the ingest endpoint refuses every request: an unauthenticated
   * ingest would let anyone fabricate a payment confirmation.
   */
  smsIngestToken: text("sms_ingest_token"),

  /**
   * When true, a plan's SYP price is its USD price × `sypRate`, fetched from
   * SP Today. When false, the admin's `subscriptionPlans.priceSyp` is used.
   */
  sypRateAuto: boolean("syp_rate_auto").notNull().default(false),
  /** SYP per USD in `sypUnit`. Stored, not fetched per request: the free tier is 100 calls a month. */
  sypRate: numeric("syp_rate", { precision: 14, scale: 4 }),
  sypRateFetchedAt: timestamp("syp_rate_fetched_at", { withTimezone: true }),
  /** The source's own timestamp — a feed that stopped updating shows here. */
  sypRateSourceUpdatedAt: timestamp("syp_rate_source_updated_at", { withTimezone: true }),
  /** The last fetch failure, cleared on success. */
  sypRateError: text("syp_rate_error"),
  /** Last fetch attempt, successful or not. What the scheduler claims; see syp-rate.ts. */
  sypRateAttemptedAt: timestamp("syp_rate_attempted_at", { withTimezone: true }),
  /**
   * `new` or `old` Syrian pound — 100 old = 1 new. SP Today reports in old;
   * prices are converted to whichever unit Syriatel Cash charges in. Wrong,
   * and every price is off by a factor of a hundred.
   */
  sypUnit: text("syp_unit").notNull().default("new"),

  /**
   * BEP-20 receiving address, lowercased. Admin-editable — a deliberate trade
   * of protection for convenience, narrowed by attribution below and by each
   * submission snapshotting the address it was checked against.
   */
  cryptoWalletAddress: text("crypto_wallet_address"),
  cryptoQrMediaId: integer("crypto_qr_media_id").references(() => mediaAssetsTable.id, {
    onDelete: "set null",
  }),
  /** Who last changed the crypto details, and when. Shown on the admin screen. */
  cryptoUpdatedBy: integer("crypto_updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  cryptoUpdatedAt: timestamp("crypto_updated_at", { withTimezone: true }),
  /** Arabic payment instructions. Data, because wallet UIs change often. */
  walletInstructionsAr: text("wallet_instructions_ar"),
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

/**
 * Confirmation SMS forwarded by the companion app on the merchant phone.
 *
 * Stored before matching is attempted, and kept whether or not it matches: an
 * unmatched message is the evidence an admin needs when a student insists they
 * paid, a message that arrives before the student submits must still match
 * afterwards, and a parser change can be replayed against what was actually
 * received rather than against a guess at it.
 */
export const walletSmsMessagesTable = pgTable("wallet_sms_messages", {
  id: serial("id").primaryKey(),
  /** Exactly as received. The parsed columns are derived; this is the record. */
  rawText: text("raw_text").notNull(),
  sender: text("sender"),
  /**
   * When the handset received it — not when the server was told. A phone
   * offline for an hour reports an older timestamp, and any validity window
   * has to be measured from this.
   */
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  /**
   * Null when parsing failed, which is itself the signal that the message
   * format changed and an admin should look, rather than a silent mismatch.
   */
  parsedOperationNumber: text("parsed_operation_number"),
  parsedAmountSyp: numeric("parsed_amount_syp", { precision: 14, scale: 2 }),
  matchedSubmissionId: integer("matched_submission_id").references(
    () => paymentSubmissionsTable.id,
    { onDelete: "set null" },
  ),
  matchedAt: timestamp("matched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  /**
   * Deliberately NOT unique.
   *
   * A message may legitimately arrive more than once — a retrying companion
   * app, or a redelivery during an investigation. Refusing the second copy
   * burned the operation number: a message that arrived before its student
   * submitted matched nothing, and could then never be re-ingested to match
   * the submission when it came. The payment was real and the system had made
   * it unmatchable.
   *
   * Uniqueness belongs on `paymentSubmissionsTable.operationNumber` — the
   * claim being spent — not on the announcement of it.
   */
  operationNumberIdx: index("wallet_sms_operation_number_idx")
    .on(table.parsedOperationNumber)
    .where(sql`${table.parsedOperationNumber} is not null`),
  unmatchedIdx: index("wallet_sms_unmatched_idx")
    .on(table.receivedAt)
    .where(sql`${table.matchedSubmissionId} is null`),
}));

export type WalletSmsMessage = typeof walletSmsMessagesTable.$inferSelect;
