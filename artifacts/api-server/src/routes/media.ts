/**
 * Media upload and playback.
 *
 * Bytes go browser → bucket directly; this server only signs, verifies and
 * authorises. See `services/media.ts` for why the upload is a three-step
 * handshake rather than a single call.
 */

import { Router, type IRouter } from "express";
import { requireAuth, requireContentManager, currentRole } from "../middlewares/auth";
import {
  beginUpload,
  completeUpload,
  resolvePlaybackUrl,
  MediaValidationError,
  type MediaPurpose,
} from "../services/media";
import {
  storage,
  StorageNotConfiguredError,
  ALLOWED_AUDIO_TYPES,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_SECONDS,
} from "../services/storage";

const router: IRouter = Router();

// `practice_call` is deliberately absent: a call recording holds a second
// student's voice, so it is only accepted once both participants have consented
// — which this generic endpoint cannot check. Those uploads go through
// POST /practice/evaluations/:id/recording instead.
const STUDENT_PURPOSES = new Set<MediaPurpose>(["lesson_activity", "quiz_response"]);

/** Map a service-level refusal onto the right status code. */
function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
    case "WRONG_PURPOSE":
      return 403;
    case "DAILY_LIMIT":
      return 429;
    case "TOO_LARGE":
      return 413;
    case "TYPE_MISMATCH":
      return 415;
    default:
      return 400;
  }
}

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof MediaValidationError) {
    res.status(statusForCode(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof StorageNotConfiguredError) {
    // 503, not 500: the request was fine, the deployment is incomplete.
    res.status(503).json({ error: err.message, code: "STORAGE_UNCONFIGURED" });
    return;
  }
  throw err;
}

/**
 * What this deployment accepts. The client reads this to decide whether to show
 * a record button at all, rather than discovering storage is missing only after
 * the student has spoken for two minutes.
 */
router.get("/media/config", requireAuth, (_req, res): void => {
  res.json({
    enabled: storage.configured,
    allowedAudioTypes: Object.keys(ALLOWED_AUDIO_TYPES),
    maxBytes: MAX_RECORDING_BYTES,
    maxDurationSeconds: MAX_RECORDING_SECONDS,
  });
});

/** Step 1 — reserve a key and get a presigned PUT for it. */
router.post("/media/uploads", requireAuth, async (req, res): Promise<void> => {
  const { purpose, contentType, sizeBytes, durationSec } = req.body ?? {};

  if (!STUDENT_PURPOSES.has(purpose)) {
    res.status(400).json({
      error: `purpose must be one of: ${[...STUDENT_PURPOSES].join(", ")}`,
      code: "INVALID_PURPOSE",
    });
    return;
  }
  if (typeof contentType !== "string") {
    res.status(400).json({ error: "contentType is required", code: "INVALID_TYPE" });
    return;
  }

  try {
    const result = await beginUpload({
      userId: req.session.userId!,
      purpose,
      contentType,
      sizeBytes: Number(sizeBytes),
      durationSec: durationSec == null ? null : Number(durationSec),
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

/** Step 3 — confirm the bytes landed. Only then may the asset be attached. */
router.post("/media/uploads/:mediaId/complete", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.mediaId) ? req.params.mediaId[0] : req.params.mediaId;
  const mediaId = parseInt(raw as string, 10);
  if (isNaN(mediaId)) {
    res.status(400).json({ error: "Invalid media ID" });
    return;
  }

  try {
    const asset = await completeUpload(mediaId, req.session.userId!);
    res.json({
      mediaId: asset.id,
      status: asset.status,
      sizeBytes: asset.sizeBytes,
      durationSec: asset.durationSec,
      mimeType: asset.mimeType,
    });
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * A short-lived playback URL.
 *
 * Missing, unfinished and not-yours all answer 404 alike, so iterating ids
 * cannot be used to learn which recordings exist.
 */
router.get("/media/:mediaId/url", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.mediaId) ? req.params.mediaId[0] : req.params.mediaId;
  const mediaId = parseInt(raw as string, 10);
  if (isNaN(mediaId)) {
    res.status(400).json({ error: "Invalid media ID" });
    return;
  }

  try {
    // The current role, not the one from login: staff may play any student's
    // recording, so someone no longer on staff must stop being able to.
    const role = await currentRole(req);
    if (!role) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const url = await resolvePlaybackUrl(mediaId, {
      userId: req.session.userId!,
      role,
    });
    if (!url) {
      res.status(404).json({ error: "Recording not found" });
      return;
    }
    res.json({ url });
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * Curriculum media upload, for staff.
 *
 * Separate from the student path because the limits, the allowed types and the
 * ownership rule all differ: what staff upload has no owner and is playable by
 * every student in the level.
 */
router.post("/cms/media/uploads", requireContentManager, async (req, res): Promise<void> => {
  const { contentType, sizeBytes, originalName, durationSec } = req.body ?? {};

  if (typeof contentType !== "string") {
    res.status(400).json({ error: "contentType is required", code: "INVALID_TYPE" });
    return;
  }

  try {
    const result = await beginUpload({
      userId: req.session.userId!,
      purpose: "curriculum",
      contentType,
      sizeBytes: Number(sizeBytes),
      durationSec: durationSec == null ? null : Number(durationSec),
      originalName: typeof originalName === "string" ? originalName : null,
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
