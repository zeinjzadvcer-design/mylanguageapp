/**
 * Media asset lifecycle and access control.
 *
 * The upload is a three-step handshake, and each step exists for a reason:
 *
 *   1. `beginUpload`    — the server picks the key and records a `pending` row.
 *                         The client never chooses where its bytes land.
 *   2. browser PUTs     — straight to the bucket, bypassing this server.
 *   3. `completeUpload` — the server HEADs the object. Only an object that
 *                         actually exists, at the expected key, within the size
 *                         cap, becomes `ready`.
 *
 * Without step 3 a client could claim any key it liked and attach it to an
 * attempt. With it, "this recording exists" is something the server checked
 * rather than something the client asserted.
 */

import { eq, and, gte, sql } from "drizzle-orm";
import { db, mediaAssetsTable } from "@workspace/db";
import {
  storage,
  recordingKey,
  curriculumKey,
  paymentImageKey,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_CMS_TYPES,
  ALLOWED_PAYMENT_IMAGE_TYPES,
  MAX_PAYMENT_IMAGE_BYTES,
  MAX_RECORDING_BYTES,
  MAX_CMS_BYTES,
  MAX_RECORDING_SECONDS,
  type PresignedUpload,
} from "./storage";
import { logger } from "../lib/logger";
import { canReadMediaAsset } from "./entitlement-policy";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MediaPurpose =
  | "lesson_activity"
  | "quiz_response"
  | "curriculum"
  /**
   * A peer-call recording uploaded for evaluation. Its own purpose because it
   * is the one recording containing a second student's voice: it must not be
   * reachable by a route that accepts a student's own `lesson_activity`
   * recording, and it is deleted once the transcript exists.
   */
  | "practice_call"
  /**
   * A student's proof of a ShamCash transfer. Owned by that student, readable
   * by them and by staff reviewing the payment — the same rule as a recording,
   * which is why it reuses `ownerUserId` rather than needing its own.
   */
  | "payment_receipt"
  /**
   * The ShamCash receive QR an admin uploads for students to scan.
   *
   * The one payment asset with NO owner: every student must be able to see it,
   * exactly like curriculum material. Setting an owner here would hide the QR
   * from everyone but the admin who uploaded it.
   */
  | "payment_qr";

export interface BeginUploadInput {
  userId: number;
  purpose: MediaPurpose;
  contentType: string;
  /** What the client believes it is about to upload. Re-checked on completion. */
  sizeBytes: number;
  durationSec?: number | null;
  originalName?: string | null;
}

export interface BeginUploadResult {
  mediaId: number;
  key: string;
  upload: PresignedUpload;
}

/** A refusal the caller should turn into a 4xx, rather than a crash. */
export class MediaValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
  }
}

// ─── Daily cap ────────────────────────────────────────────────────────────────

/**
 * Recordings one student may start in a day.
 *
 * Counted in Postgres rather than Redis on purpose. The AI quota fails closed
 * when Redis is down because letting AI run free costs money; a recording costs
 * a fraction of a cent, so blocking a lesson because a cache is down would be
 * the more expensive failure. Postgres is already required for the request to
 * work at all.
 */
const DAILY_RECORDING_LIMIT = parseInt(process.env.MEDIA_DAILY_UPLOAD_LIMIT ?? "200", 10);

async function countTodaysUploads(userId: number): Promise<number> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [{ used }] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(mediaAssetsTable)
    .where(
      and(
        eq(mediaAssetsTable.ownerUserId, userId),
        gte(mediaAssetsTable.createdAt, since),
      ),
    );
  return used;
}

// ─── Step 1: presign ──────────────────────────────────────────────────────────

export async function beginUpload(input: BeginUploadInput): Promise<BeginUploadResult> {
  const { userId, purpose, contentType, sizeBytes, durationSec, originalName } = input;

  const isCurriculum = purpose === "curriculum";
  const isPaymentImage = purpose === "payment_receipt" || purpose === "payment_qr";

  const allowed = isPaymentImage
    ? ALLOWED_PAYMENT_IMAGE_TYPES
    : isCurriculum
      ? ALLOWED_CMS_TYPES
      : ALLOWED_AUDIO_TYPES;
  const maxBytes = isPaymentImage
    ? MAX_PAYMENT_IMAGE_BYTES
    : isCurriculum
      ? MAX_CMS_BYTES
      : MAX_RECORDING_BYTES;

  // MediaRecorder reports the codec alongside the type — "audio/webm;codecs=opus".
  // The allowlist holds bare types, so compare on the type and keep the
  // normalised value: it is what gets signed and stored, and a stored type with
  // a codec parameter would not match on the way back out either.
  const baseContentType = (contentType ?? "").split(";")[0].trim().toLowerCase();

  if (!allowed[baseContentType]) {
    throw new MediaValidationError(
      "UNSUPPORTED_TYPE",
      `Unsupported content type "${contentType}". Allowed: ${Object.keys(allowed).join(", ")}`,
    );
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new MediaValidationError("INVALID_SIZE", "sizeBytes must be a positive number");
  }

  if (sizeBytes > maxBytes) {
    throw new MediaValidationError(
      "TOO_LARGE",
      `File is ${Math.round(sizeBytes / 1024 / 1024)}MB; the limit is ${Math.round(maxBytes / 1024 / 1024)}MB`,
    );
  }

  if (
    !isCurriculum &&
    !isPaymentImage &&
    durationSec != null &&
    (!Number.isFinite(durationSec) || durationSec > MAX_RECORDING_SECONDS)
  ) {
    throw new MediaValidationError(
      "TOO_LONG",
      `Recording is longer than the ${MAX_RECORDING_SECONDS / 60} minute limit`,
    );
  }

  // The daily cap counts recordings. A payment image is not one, and a student
  // who has been practising all day must still be able to send a receipt.
  if (!isCurriculum && !isPaymentImage) {
    const used = await countTodaysUploads(userId);
    if (used >= DAILY_RECORDING_LIMIT) {
      throw new MediaValidationError(
        "DAILY_LIMIT",
        "You have reached today's recording limit. Try again tomorrow.",
      );
    }
  }

  const key = isPaymentImage
    ? paymentImageKey(purpose === "payment_qr" ? "qr" : "receipt", userId, baseContentType)
    : isCurriculum
      ? curriculumKey(baseContentType, originalName)
      : recordingKey(userId, baseContentType);

  const upload = await storage.presignUpload(key, baseContentType);

  const [asset] = await db
    .insert(mediaAssetsTable)
    .values({
      key,
      originalName: originalName ?? null,
      mimeType: baseContentType,
      sizeBytes,
      durationSec: durationSec ?? null,
      // Curriculum media belongs to the curriculum, not to the staff member who
      // uploaded it — otherwise no student could ever play it back. The payment
      // QR is the same case: every student has to be able to see it to pay.
      // A receipt is the opposite — it is the student's own, like a recording.
      ownerUserId: isCurriculum || purpose === "payment_qr" ? null : userId,
      status: "pending",
      purpose,
      createdBy: userId,
    })
    .returning();

  return { mediaId: asset.id, key, upload };
}

// ─── Step 3: confirm ──────────────────────────────────────────────────────────

/**
 * Verify the bytes actually arrived, then mark the asset usable.
 *
 * Idempotent: confirming an already-`ready` asset returns it unchanged, so a
 * retried request from a flaky mobile connection is harmless.
 */
export async function completeUpload(
  mediaId: number,
  userId: number,
): Promise<typeof mediaAssetsTable.$inferSelect> {
  const [asset] = await db
    .select()
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, mediaId))
    .limit(1);

  if (!asset) throw new MediaValidationError("NOT_FOUND", "Upload not found");

  // Only the uploader may complete their own upload.
  if (asset.createdBy !== userId) {
    throw new MediaValidationError("FORBIDDEN", "This upload belongs to someone else");
  }

  if (asset.status === "ready") return asset;

  const meta = await storage.head(asset.key);

  if (!meta) {
    await db
      .update(mediaAssetsTable)
      .set({ status: "failed" })
      .where(eq(mediaAssetsTable.id, mediaId));
    throw new MediaValidationError(
      "NOT_UPLOADED",
      "No file was found at the expected location. Upload the recording, then try again.",
    );
  }

  const maxBytes = asset.purpose === "curriculum" ? MAX_CMS_BYTES : MAX_RECORDING_BYTES;

  /** Delete the object and mark the row failed, then refuse. */
  const reject = async (code: string, message: string): Promise<never> => {
    await storage.remove(asset.key).catch((err) => {
      logger.error({ err, key: asset.key }, "Failed to remove rejected upload");
    });
    await db
      .update(mediaAssetsTable)
      .set({ status: "failed" })
      .where(eq(mediaAssetsTable.id, mediaId));
    throw new MediaValidationError(code, message);
  };

  // The size declared up front was a claim; this is the measurement. A client
  // that understated its size to get past the cap is caught here, and the
  // object is removed rather than left paid-for in the bucket.
  if (meta.sizeBytes > maxBytes) {
    await reject("TOO_LARGE", "The uploaded file exceeds the size limit");
  }

  // The presigned URL binds the content type into its signature, so a
  // mismatched PUT should already have been refused by the bucket. This is the
  // second lock: it does not depend on the storage provider honouring signed
  // headers, and it is what stops an object named `.webm` from actually being
  // HTML that a browser would render from the storage origin.
  const declared = asset.mimeType.split(";")[0].trim().toLowerCase();
  const actual = (meta.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (actual && actual !== declared) {
    await reject(
      "TYPE_MISMATCH",
      `The uploaded file is ${actual}, but ${declared} was declared`,
    );
  }

  const [updated] = await db
    .update(mediaAssetsTable)
    .set({
      status: "ready",
      // Trust the bucket over the client for the recorded size.
      sizeBytes: meta.sizeBytes,
      uploadedAt: new Date(),
    })
    .where(eq(mediaAssetsTable.id, mediaId))
    .returning();

  return updated;
}

// ─── Access control ───────────────────────────────────────────────────────────

const STAFF_ROLES = new Set(["admin", "content_manager", "content_reviewer"]);

/**
 * May this user play this asset?
 *
 * Curriculum material (no owner) is readable by anyone signed in — it is
 * teaching content, and every student in the level is meant to hear it.
 * A student's own recording is readable by that student and by staff, who need
 * it to grade speaking work. Nobody else, ever.
 */
export function canReadAsset(
  asset: { ownerUserId: number | null; purpose?: string | null },
  viewer: { userId: number; role: string | undefined },
): boolean {
  return canReadMediaAsset(asset, viewer, STAFF_ROLES);
}

/**
 * A playable URL for an asset the viewer is allowed to hear.
 * Returns null when the asset is missing, unfinished, or not theirs to play —
 * the caller turns that into a 404 so a probe cannot distinguish the cases.
 */
export async function resolvePlaybackUrl(
  mediaId: number,
  viewer: { userId: number; role: string | undefined },
): Promise<string | null> {
  const [asset] = await db
    .select()
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, mediaId))
    .limit(1);

  if (!asset || asset.status !== "ready") return null;
  if (!canReadAsset(asset, viewer)) return null;

  return storage.presignDownload(asset.key);
}

/**
 * Confirm an asset is this student's, uploaded, and of the expected purpose —
 * the check every route must run before attaching a recording to an attempt.
 */
export async function assertUsableRecording(
  mediaId: number,
  userId: number,
  purpose: MediaPurpose,
): Promise<typeof mediaAssetsTable.$inferSelect> {
  const [asset] = await db
    .select()
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, mediaId))
    .limit(1);

  if (!asset || asset.ownerUserId !== userId) {
    throw new MediaValidationError("NOT_FOUND", "Recording not found");
  }
  if (asset.status !== "ready") {
    throw new MediaValidationError("NOT_UPLOADED", "That recording has not finished uploading");
  }
  if (asset.purpose !== purpose) {
    throw new MediaValidationError(
      "WRONG_PURPOSE",
      "That recording was made for a different activity",
    );
  }
  return asset;
}
