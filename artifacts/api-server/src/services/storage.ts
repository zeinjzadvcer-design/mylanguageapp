/**
 * Object storage for audio and other media.
 *
 * Bytes never pass through this server. The browser asks for a presigned URL,
 * uploads straight to the bucket, and tells us the upload finished; we verify
 * the object exists and is the size we expected before accepting it. That keeps
 * a 2MB recording from every student off the Node event loop, and keeps the
 * bucket credentials on the server.
 *
 * Provider-agnostic by construction: everything here speaks the S3 API, which
 * MinIO (local), Cloudflare R2 and DigitalOcean Spaces all implement. Switching
 * between them is an endpoint and a key pair, not a code change.
 *
 * Unconfigured, this degrades to a `disabled` implementation that throws a
 * clear error rather than preventing the server from starting — the same
 * approach `services/ai.ts` takes, so a developer without a bucket can still
 * run every other feature.
 */

import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "../lib/logger";

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * What a student's microphone may produce. MediaRecorder emits webm/opus on
 * Chrome and Firefox and mp4/aac on Safari, so both must be accepted; the rest
 * are here for uploads from other clients later.
 */
export const ALLOWED_AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/**
 * Payment images: a ShamCash receive QR uploaded by an admin, and a transfer
 * receipt uploaded by a student.
 *
 * Images only, and deliberately not the CMS list — that one also admits audio
 * and video, and a payment receipt is never either. Narrow on purpose: these
 * are the one upload path where an unauthenticated-ish actor (any student)
 * sends a file that staff will later open.
 */
export const ALLOWED_PAYMENT_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * 8MB. A phone screenshot of a transfer confirmation is well under 1MB; the
 * headroom is for an uncropped photo of a screen taken by a modern camera.
 */
export const MAX_PAYMENT_IMAGE_BYTES = 8 * 1024 * 1024;

/** Curriculum media a content manager may upload. */
export const ALLOWED_CMS_TYPES: Record<string, string> = {
  ...ALLOWED_AUDIO_TYPES,
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/**
 * 15MB. A three-minute opus recording is well under 3MB; the headroom is for
 * Safari's less efficient encoder and for the odd long reading passage.
 */
export const MAX_RECORDING_BYTES = 15 * 1024 * 1024;
/** 100MB for curriculum audio and video, which staff upload deliberately. */
export const MAX_CMS_BYTES = 100 * 1024 * 1024;
/** Ten minutes. Longer than any single speaking activity the spec describes. */
export const MAX_RECORDING_SECONDS = 600;
/**
 * Sixteen minutes, for a peer-call recording only.
 *
 * A call recording is legitimately twenty times longer than a read-aloud
 * answer, so one shared limit cannot serve both: at 600s every call over ten
 * minutes was refused at upload and could never be evaluated.
 *
 * 960s is a 15-minute call (`PRACTICE_MAX_CALL_MINUTES`) plus a minute of
 * headroom for a recording that slightly overruns the call. The 15MB byte cap
 * is deliberately left alone — 15 minutes of 96kbps stereo is about 10.3MB, so
 * it still has room, and it stays the backstop if the bitrate is ever raised.
 *
 * Raising the call cap to 30 minutes would need the byte limit raised too
 * (~20.6MB), so the two belong together.
 */
export const MAX_CALL_RECORDING_SECONDS = 960;

/** How long a presigned upload URL stays valid. */
const UPLOAD_TTL_SECONDS = 300;
/** How long a presigned playback URL stays valid. */
const DOWNLOAD_TTL_SECONDS = 3600;

// ─── Interface ────────────────────────────────────────────────────────────────

export interface PresignedUpload {
  url: string;
  /** Headers the browser MUST send with the PUT, or the signature will not match. */
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface ObjectMetadata {
  sizeBytes: number;
  contentType: string | null;
}

export interface StorageProvider {
  readonly name: string;
  readonly configured: boolean;

  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds?: number): Promise<string>;
  /** Null when the object is not there. */
  head(key: string): Promise<ObjectMetadata | null>;
  /**
   * The object's bytes, for server-side processing — sending a recording to a
   * speech recogniser, for instance. Not used to serve media to a browser:
   * that goes through a presigned URL so the bytes never touch this process.
   */
  download(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Media storage is not configured. Set STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID " +
        "and STORAGE_SECRET_ACCESS_KEY (plus STORAGE_ENDPOINT for MinIO/R2/Spaces).",
    );
    this.name = "StorageNotConfiguredError";
  }
}

// ─── Key construction ─────────────────────────────────────────────────────────

/**
 * Build the storage key for a student recording.
 *
 * The key is always generated here and never accepted from the client. Two
 * reasons: a client-supplied key is a path-traversal and overwrite primitive,
 * and putting the owner's id in the path means ownership can be re-checked from
 * the key alone if the database row is ever lost.
 */
export function recordingKey(userId: number, contentType: string): string {
  const ext = ALLOWED_AUDIO_TYPES[contentType] ?? "bin";
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `recordings/${userId}/${yyyymm}/${randomUUID()}.${ext}`;
}

/** Build the storage key for curriculum media uploaded by staff. */
/**
 * Storage key for a payment image.
 *
 * Namespaced away from recordings and curriculum material so a bucket policy,
 * a lifecycle rule or a bulk delete aimed at one can never catch the other —
 * these are financial records and outlive the lesson content around them.
 */
export function paymentImageKey(
  kind: "receipt" | "qr",
  userId: number,
  contentType: string,
): string {
  const ext = ALLOWED_PAYMENT_IMAGE_TYPES[contentType] ?? "bin";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `payments/${kind}/${userId}/${unique}.${ext}`;
}

export function curriculumKey(contentType: string, originalName?: string | null): string {
  const ext = ALLOWED_CMS_TYPES[contentType] ?? "bin";
  const slug = (originalName ?? "asset")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "asset";
  return `curriculum/${slug}-${randomUUID()}.${ext}`;
}

/** Where the keys built above put private objects: recordings and payment images. */
const PRIVATE_KEY_PREFIXES = ["recordings/", "payments/"];

/**
 * Whether a key typed into the CMS may be registered as curriculum media.
 *
 * One plain relative path, nothing a storage gateway could normalise into a
 * different object, and never under a private prefix.
 */
export function isRegistrableCurriculumKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(key)) return false;
  if (key.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  const lower = key.toLowerCase();
  return !PRIVATE_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ─── S3-compatible implementation ─────────────────────────────────────────────

class S3StorageProvider implements StorageProvider {
  readonly name: string;
  readonly configured = true;
  /** Used for operations this server makes itself: HEAD, DELETE. */
  private readonly client: S3Client;
  /**
   * Used only to sign URLs the browser will open.
   *
   * In a container the API reaches MinIO at `http://storage:9000` while the
   * browser can only reach `http://localhost:9000`. Rewriting the host of a
   * finished presigned URL does not work — SigV4 signs the Host header, so the
   * swap invalidates the signature. Signing against the public endpoint from
   * the start is the only correct fix.
   *
   * In production, where both endpoints are the same, this is the same client.
   */
  private readonly signingClient: S3Client;
  private readonly bucket: string;

  constructor(config: {
    endpoint?: string;
    publicEndpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  }) {
    this.bucket = config.bucket;
    this.name = config.endpoint ? `s3:${config.endpoint}` : "s3";

    const base = {
      region: config.region,
      // MinIO and some Spaces setups serve buckets as a path segment rather
      // than a subdomain. R2 and AWS do not.
      forcePathStyle: config.forcePathStyle,
      // Recent SDKs add a CRC32 checksum to every PutObject by default. For a
      // PRESIGNED upload that is computed over an empty body — the bytes are
      // not here — and baked into the URL as x-amz-checksum-crc32=AAAAAA==.
      // The browser then PUTs the real file and any provider that verifies the
      // checksum (SeaweedFS, MinIO, R2, Backblaze B2) rejects it:
      //   "checksum mismatch: expected AAAAAA==, got eB6jKg=="
      // WHEN_REQUIRED leaves the checksum off unless the operation demands one.
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };

    this.client = new S3Client({ ...base, endpoint: config.endpoint });
    this.signingClient =
      config.publicEndpoint && config.publicEndpoint !== config.endpoint
        ? new S3Client({ ...base, endpoint: config.publicEndpoint })
        : this.client;
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.signingClient,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      {
        expiresIn: UPLOAD_TTL_SECONDS,
        // Without this the presigner signs only `host`, and the declared
        // content type is decoration: the holder of the URL could PUT HTML at
        // a key named .webm and have the bucket serve it back as HTML. Naming
        // content-type here puts it in the signature, so the bucket itself
        // rejects a PUT that does not match what was asked for.
        signableHeaders: new Set(["content-type"]),
      },
    );
    // The browser must send exactly this header back, or the signature fails.
    return {
      url,
      headers: { "Content-Type": contentType },
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    };
  }

  presignDownload(key: string, ttlSeconds = DOWNLOAD_TTL_SECONDS): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: r.ContentLength ?? 0,
        contentType: r.ContentType ?? null,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (status === 404 || status === 403) return null;
      throw err;
    }
  }

  async download(key: string): Promise<Uint8Array> {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!r.Body) throw new Error(`Object ${key} has no body`);
    // transformToByteArray buffers the whole object. Recordings are capped at
    // 15MB by MAX_RECORDING_BYTES, so this is bounded; it must not be used for
    // curriculum video, which is capped far higher.
    return r.Body.transformToByteArray();
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// ─── Disabled implementation ──────────────────────────────────────────────────

class DisabledStorageProvider implements StorageProvider {
  readonly name = "disabled";
  readonly configured = false;

  presignUpload(): Promise<PresignedUpload> {
    return Promise.reject(new StorageNotConfiguredError());
  }
  presignDownload(): Promise<string> {
    return Promise.reject(new StorageNotConfiguredError());
  }
  head(): Promise<ObjectMetadata | null> {
    return Promise.reject(new StorageNotConfiguredError());
  }
  download(): Promise<Uint8Array> {
    return Promise.reject(new StorageNotConfiguredError());
  }
  remove(): Promise<void> {
    return Promise.reject(new StorageNotConfiguredError());
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createStorageProvider(): StorageProvider {
  const bucket = process.env.STORAGE_BUCKET;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    logger.warn(
      "Media storage is not configured — recording upload and playback will be unavailable.",
    );
    return new DisabledStorageProvider();
  }

  return new S3StorageProvider({
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    // Only needed when the browser reaches storage at a different address than
    // this server does — a container talking to MinIO, typically.
    publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || undefined,
    // R2 requires the literal region "auto"; AWS and Spaces want a real one.
    region: process.env.STORAGE_REGION ?? "auto",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
  });
}

export const storage: StorageProvider = createStorageProvider();
