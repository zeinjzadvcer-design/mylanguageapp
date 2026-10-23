/**
 * Payment settings — what a student needs on screen to pay.
 *
 * ShamCash details are admin-editable and live in the database; the crypto
 * wallet address is deploy-time configuration and lives in env. That asymmetry
 * is deliberate and is explained in migration 023: ShamCash has a human
 * reviewing every receipt, so a swapped QR is caught; the crypto path verifies
 * without a human, which makes its address a trust anchor.
 */

import { eq } from "drizzle-orm";
import { db, paymentSettingsTable, mediaAssetsTable } from "@workspace/db";
import { storage } from "./storage";

/** The singleton row. Enforced by a check constraint, not just convention. */
export const SETTINGS_ROW_ID = 1;

export interface ShamCashDetails {
  /** Signed URL for the receive QR, or null when no QR has been uploaded. */
  qrUrl: string | null;
  accountName: string | null;
  accountNumber: string | null;
  instructionsAr: string | null;
  /**
   * Whether this deployment can actually take a ShamCash payment. False when
   * no QR has been uploaded — the payment page shows an explanation rather
   * than an empty box the student cannot act on.
   */
  configured: boolean;
}

/**
 * The ShamCash details to show a student.
 *
 * The QR is resolved to a signed URL here rather than returning a media id:
 * the client would otherwise need a second round trip before it could render
 * anything, on the one page where a student is waiting to pay.
 */
export async function getShamCashDetails(): Promise<ShamCashDetails> {
  const [row] = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);

  let qrUrl: string | null = null;

  if (row?.shamCashQrMediaId) {
    const [asset] = await db
      .select({ key: mediaAssetsTable.key, status: mediaAssetsTable.status })
      .from(mediaAssetsTable)
      .where(eq(mediaAssetsTable.id, row.shamCashQrMediaId))
      .limit(1);

    // Only a completed upload is served. A pending one would render as a
    // broken image on the payment page.
    if (asset?.status === "ready") {
      qrUrl = await storage.presignDownload(asset.key);
    }
  }

  return {
    qrUrl,
    accountName: row?.shamCashAccountName ?? null,
    accountNumber: row?.shamCashAccountNumber ?? null,
    instructionsAr: row?.shamCashInstructionsAr ?? null,
    configured: qrUrl !== null,
  };
}
