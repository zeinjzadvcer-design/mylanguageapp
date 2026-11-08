/**
 * Holding an exact USDT amount for one subscription.
 *
 * The rules are in crypto-verify-policy.ts; this is the part that needs the
 * database. Reservation is what makes the amount proof of who paid: while one
 * student's subscription holds 2.0037, no other subscription can be given it,
 * so a transfer of 2.0037 can only be theirs.
 */

import { randomInt } from "node:crypto";
import { and, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { db, studentSubscriptionsTable } from "@workspace/db";
import { freeUsdtAmounts } from "./crypto-verify-policy";

/**
 * How long an amount stays held for an unpaid subscription.
 *
 * Bounded so abandoned attempts give their amounts back. Matches how long a
 * Syrian pound quote is held.
 */
export const USDT_AMOUNT_HOLD_MS = 48 * 3600_000;

/**
 * Give this subscription a free amount and return it, or null when every
 * amount for this price is held.
 */
export async function reserveUsdtAmount(
  subscriptionId: number,
  priceUsd: number,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // One allocation at a time across all students: two requests reading the
    // same free list could otherwise pick the same amount. Classid 4244
    // namespaces this against the lesson-start and activation locks.
    await tx.execute(sql`select pg_advisory_xact_lock(4244, 0)`);

    const heldRows = await tx
      .select({ amount: studentSubscriptionsTable.usdtAmount })
      .from(studentSubscriptionsTable)
      .where(
        and(
          eq(studentSubscriptionsTable.status, "pending_payment"),
          isNotNull(studentSubscriptionsTable.usdtAmount),
          gt(studentSubscriptionsTable.usdtAmountAt, new Date(Date.now() - USDT_AMOUNT_HOLD_MS)),
          ne(studentSubscriptionsTable.id, subscriptionId),
        ),
      );

    const free = freeUsdtAmounts(priceUsd, new Set(heldRows.map((r) => r.amount as string)));
    if (free.length === 0) return null;

    // Random rather than the first free one, so the amount says nothing about
    // who else is paying.
    const amount = free[randomInt(free.length)];
    await tx
      .update(studentSubscriptionsTable)
      .set({ usdtAmount: amount, usdtAmountAt: new Date() })
      .where(eq(studentSubscriptionsTable.id, subscriptionId));
    return amount;
  });
}
