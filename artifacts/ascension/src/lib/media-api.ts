/**
 * Recording upload.
 *
 * Three steps, because the bytes do not go through our API:
 *   1. ask the server to reserve a key and sign a PUT
 *   2. PUT the blob straight at the bucket
 *   3. tell the server it landed, so it can verify and mark the asset usable
 *
 * Only after step 3 will the server accept the recording on an attempt, so a
 * partial upload can never be submitted as an answer.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export type MediaPurpose = "lesson_activity" | "quiz_response";

/** Image uploads. Receipts go through the student path; the QR is admin-only. */
export type ImagePurpose = "payment_receipt" | "payment_qr";

export class MediaUploadError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "MediaUploadError";
    this.status = status;
    this.code = code;
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!r.ok) {
    let payload: { error?: string; code?: string } = {};
    try {
      payload = await r.json();
    } catch {
      // Non-JSON body; the status alone will have to do.
    }
    throw new MediaUploadError(
      payload.error ?? `${method} ${path} → ${r.status}`,
      r.status,
      payload.code ?? null,
    );
  }

  return r.json();
}

export interface MediaConfig {
  enabled: boolean;
  allowedAudioTypes: string[];
  maxBytes: number;
  maxDurationSeconds: number;
}

export const getMediaConfig = () => api<MediaConfig>("GET", "/media/config");

interface BeginUploadResponse {
  mediaId: number;
  key: string;
  upload: { url: string; headers: Record<string, string>; expiresInSeconds: number };
}

export interface UploadedRecording {
  mediaId: number;
  sizeBytes: number | null;
  durationSec: number | null;
}

/**
 * Run the whole handshake for one recording.
 *
 * `blob.type` can carry codec parameters ("audio/webm;codecs=opus") that the
 * server's allowlist does not contain, so the bare MIME type is what gets
 * declared and signed — and the PUT must send exactly that back, or the
 * signature will not match.
 */
export async function uploadRecording(
  blob: Blob,
  purpose: MediaPurpose,
  durationSec: number,
): Promise<UploadedRecording> {
  const contentType = (blob.type || "audio/webm").split(";")[0].trim();

  const begun = await api<BeginUploadResponse>("POST", "/media/uploads", {
    purpose,
    contentType,
    sizeBytes: blob.size,
    durationSec: Math.round(durationSec),
  });

  const put = await fetch(begun.upload.url, {
    method: "PUT",
    body: blob,
    headers: begun.upload.headers,
    // The bucket is a different origin and needs no session cookie; sending one
    // would only break the CORS preflight.
    credentials: "omit",
  });

  if (!put.ok) {
    throw new MediaUploadError(
      `Upload failed (${put.status})`,
      put.status,
      "UPLOAD_FAILED",
    );
  }

  const done = await api<{ mediaId: number; sizeBytes: number | null; durationSec: number | null }>(
    "POST",
    `/media/uploads/${begun.mediaId}/complete`,
  );

  return done;
}

/** A short-lived playback URL for an asset this user is allowed to hear. */
export async function getPlaybackUrl(mediaId: number): Promise<string> {
  const { url } = await api<{ url: string }>("GET", `/media/${mediaId}/url`);
  return url;
}

/** What the server accepts for a payment image. Kept in step with storage.ts. */
export const PAYMENT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_PAYMENT_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Upload a payment image — a student's transfer receipt, or the admin's
 * ShamCash QR.
 *
 * Same three-step handshake as a recording, but the type and size are checked
 * here first: a student photographing a receipt gets a clear message rather
 * than a signed PUT that the bucket rejects, and an oversized phone photo is
 * caught before it is uploaded rather than after.
 *
 * The QR goes to an admin-only endpoint. A QR students scan decides where
 * their money goes, so it must never come from the student upload path.
 */
export async function uploadPaymentImage(
  file: File,
  purpose: ImagePurpose,
): Promise<{ mediaId: number }> {
  const contentType = (file.type || "").split(";")[0].trim().toLowerCase();

  if (!PAYMENT_IMAGE_TYPES.includes(contentType)) {
    throw new MediaUploadError(
      "الرجاء اختيار صورة بصيغة JPG أو PNG أو WEBP",
      400,
      "UNSUPPORTED_TYPE",
    );
  }

  if (file.size > MAX_PAYMENT_IMAGE_BYTES) {
    throw new MediaUploadError(
      "حجم الصورة كبير جداً. الحد الأقصى 8 ميغابايت",
      400,
      "TOO_LARGE",
    );
  }

  const path = purpose === "payment_qr" ? "/admin/media/payment-qr" : "/media/uploads";
  const begun = await api<BeginUploadResponse>("POST", path, {
    ...(purpose === "payment_qr" ? {} : { purpose }),
    contentType,
    sizeBytes: file.size,
    originalName: file.name,
  });

  const put = await fetch(begun.upload.url, {
    method: "PUT",
    body: file,
    headers: begun.upload.headers,
    credentials: "omit",
  });

  if (!put.ok) {
    throw new MediaUploadError(`Upload failed (${put.status})`, put.status, "UPLOAD_FAILED");
  }

  const done = await api<{ mediaId: number }>(
    "POST",
    `/media/uploads/${begun.mediaId}/complete`,
  );

  return done;
}
