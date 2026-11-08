/**
 * Payment settings — what a student needs on screen to pay.
 *
 * The local wallet's details are admin-editable and live in the database; the
 * crypto wallet address is deploy-time configuration and lives in env.
 *
 * That asymmetry survived the move to Syriatel Cash, but its reason changed.
 * It was "a human reads every receipt, so a swapped QR is caught". Syriatel
 * payments can now verify automatically, so the review is no longer the
 * control — what protects the QR is that a swapped one produces no matching
 * SMS on the merchant phone, and nothing activates. The crypto address has no
 * such second signal: a payment to it is confirmed by the chain whatever the
 * address is, which is why it stays where changing it needs deploy access.
 */

import { eq } from "drizzle-orm";
import { db, paymentSettingsTable, mediaAssetsTable } from "@workspace/db";
import { storage } from "./storage";

/** The singleton row. Enforced by a check constraint, not just convention. */
export const SETTINGS_ROW_ID = 1;

export interface WalletDetails {
  /** Signed URL for the receive QR, or null when no QR has been uploaded. */
  qrUrl: string | null;
  accountName: string | null;
  accountNumber: string | null;
  instructionsAr: string | null;
  /** Which wallet these details belong to, for the student-facing label. */
  provider: string;
  /**
   * Whether this deployment can actually take a wallet payment. False when no
   * QR has been uploaded — the payment page explains rather than showing an
   * empty box the student cannot act on.
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
/**
 * A signed URL for an uploaded QR, or null.
 *
 * Only a completed upload is served: a pending one would render as a broken
 * image on the payment page.
 */
async function qrUrlFor(mediaId: number | null | undefined): Promise<string | null> {
  if (!mediaId) return null;
  const [asset] = await db
    .select({ key: mediaAssetsTable.key, status: mediaAssetsTable.status })
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, mediaId))
    .limit(1);
  return asset?.status === "ready" ? storage.presignDownload(asset.key) : null;
}

async function settingsRow() {
  const [row] = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);
  return row;
}

export async function getWalletDetails(): Promise<WalletDetails> {
  const row = await settingsRow();
  const qrUrl = await qrUrlFor(row?.walletQrMediaId);

  return {
    qrUrl,
    provider: row?.walletProvider ?? "syriatel_cash",
    accountName: row?.walletAccountName ?? null,
    accountNumber: row?.walletAccountNumber ?? null,
    instructionsAr: row?.walletInstructionsAr ?? null,
    configured: qrUrl !== null,
  };
}

export interface CryptoDetails {
  /**
   * Whether students are offered crypto at all: true when an admin has set a
   * receiving address, a QR, or both. Otherwise the option is not shown and
   * Syriatel Cash is the only method.
   */
  configured: boolean;
  /** Lowercased BEP-20 address, or null when only a QR was uploaded. */
  walletAddress: string | null;
  qrUrl: string | null;
  /**
   * Whether payments can be confirmed on chain. Needs an address to compare
   * the recipient against; a QR alone means an admin reviews each payment.
   */
  autoVerify: boolean;
}

export async function getCryptoDetails(): Promise<CryptoDetails> {
  const row = await settingsRow();
  const walletAddress = row?.cryptoWalletAddress ?? null;
  const qrUrl = await qrUrlFor(row?.cryptoQrMediaId);

  return {
    // The media id, not the resolved URL, decides whether a QR is configured:
    // a storage outage that fails to sign a URL must not silently withdraw the
    // payment method.
    configured: Boolean(walletAddress || row?.cryptoQrMediaId),
    walletAddress,
    qrUrl,
    autoVerify: Boolean(walletAddress),
  };
}
