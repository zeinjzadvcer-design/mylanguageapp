/**
 * Deleting students' lesson recordings once they are a month old.
 *
 * Covers `lesson_activity` only: spoken answers in lesson blocks and spoken
 * turns with the tutor. Curriculum media has no owner, payment receipts are
 * financial records, and peer-call recordings are already deleted once their
 * transcript exists.
 *
 * What the recording produced stays: the score, the feedback and the transcript
 * live on the attempt, so a student's history is unaffected and only playback
 * of the audio goes away.
 *
 * A recording still waiting to be marked is kept, however old. Grading reads
 * the audio, so deleting it would leave that answer pending for good.
 */

import { and, asc, eq, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { db, learningActivityAttemptsTable, mediaAssetsTable } from "@workspace/db";
import { storage } from "./storage";
import { logger } from "../lib/logger";

const SWEEP_INTERVAL_MS = 3_600_000;

/** Enough to clear a backlog steadily without holding one huge result. */
const BATCH_SIZE = 200;

/**
 * Delete every lesson recording past its retention period.
 *
 * The object goes first and the row second, so a failure part-way leaves a row
 * that the next sweep retries rather than a file nothing points to any more.
 * Safe with several API instances running it: removing an object or a row that
 * has already gone is not an error.
 */
export async function deleteExpiredRecordings(): Promise<number> {
  // Without storage the files cannot be removed, and deleting the rows alone
  // would orphan them for good if storage is configured again later.
  if (!storage.configured) return 0;

  let deleted = 0;

  for (;;) {
    const expired = await db
      .select({ id: mediaAssetsTable.id, key: mediaAssetsTable.key })
      .from(mediaAssetsTable)
      .where(
        and(
          eq(mediaAssetsTable.purpose, "lesson_activity"),
          isNotNull(mediaAssetsTable.ownerUserId),
          lt(mediaAssetsTable.createdAt, sql`now() - interval '1 month'`),
          notExists(
            db
              .select({ id: learningActivityAttemptsTable.id })
              .from(learningActivityAttemptsTable)
              .where(
                and(
                  eq(learningActivityAttemptsTable.mediaAssetId, mediaAssetsTable.id),
                  eq(learningActivityAttemptsTable.evaluationStatus, "pending"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(mediaAssetsTable.createdAt))
      .limit(BATCH_SIZE);

    let deletedThisBatch = 0;
    for (const recording of expired) {
      try {
        await storage.remove(recording.key);
        await db.delete(mediaAssetsTable).where(eq(mediaAssetsTable.id, recording.id));
        deletedThisBatch += 1;
      } catch (err) {
        logger.error({ err, mediaId: recording.id }, "Could not delete an expired recording");
      }
    }

    deleted += deletedThisBatch;

    // A batch that removed nothing would be selected again unchanged, so stop
    // and leave it for the next sweep.
    if (expired.length < BATCH_SIZE || deletedThisBatch === 0) break;
  }

  if (deleted > 0) logger.info({ deleted }, "Deleted expired lesson recordings");
  return deleted;
}

let timer: NodeJS.Timeout | null = null;

export function startRecordingRetentionSweeper(): void {
  if (timer) return;

  const sweep = () => {
    void deleteExpiredRecordings().catch((err) => {
      logger.error({ err }, "Recording retention sweep failed");
    });
  };

  // Once at startup as well: a process restarted more often than the interval
  // would otherwise never sweep at all.
  sweep();
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);

  // Do not hold the process open for the timer alone.
  timer.unref?.();
}

export function stopRecordingRetentionSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
