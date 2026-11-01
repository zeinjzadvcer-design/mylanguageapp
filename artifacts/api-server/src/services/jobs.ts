/**
 * Background Jobs / Async Processing
 *
 * Provides a thin abstraction for work that should NOT block an HTTP response:
 *   - AI evaluation (speaking, pronunciation, open answers)
 *   - Audio/media processing
 *   - Push notifications
 *   - Usage/analytics aggregation
 *   - Heavy report generation
 *
 * V1: all jobs run in-process using setImmediate — fire-and-forget, no queue.
 * This is correct for the current load, with one consequence worth knowing:
 * a job is lost if the process restarts between enqueue and run. Every handler
 * is therefore written so that not running is survivable — grading left
 * pending can be retried, and nothing depends on a job having happened.
 *
 * TO ADD A REAL QUEUE (Bull, BullMQ, pg-boss) LATER
 * ───────────────────────────────────────────────────
 * 1. Install the queue library.
 * 2. Implement JobQueue with the library's worker/producer API.
 * 3. Replace the FireAndForgetQueue with the real implementation.
 * 4. Update createJobQueue() to choose based on JOB_QUEUE env var.
 * 5. Nothing in the rest of the codebase changes — callers use jobs.enqueue().
 *
 * IMPORTANT: jobs.enqueue() MUST NOT be awaited by HTTP handlers for
 * non-critical work. Return the HTTP response first, then enqueue.
 */

import { logger } from "../lib/logger";

// ─── Job definitions ──────────────────────────────────────────────────────────

export type JobName =
  | "grade_quiz_attempt"
  | "assess_speaking_activity"
  | "analyse_peer_call"
  | "send_notification"
  | "process_audio";

export interface JobPayload {
  /**
   * Grade every text answer in a submitted attempt, then re-finalise it — and
   * apply promotion if it was a level evaluation. Off the request because an
   * exam with several written answers is several model calls, and a submit
   * must not hang on them.
   *
   * The payload is only an id: everything else is read fresh when the job runs,
   * so a job that fires late cannot act on a stale copy of the attempt.
   */
  grade_quiz_attempt: { attemptId: number };
  /**
   * Assess one recording submitted inside a lesson. Off the request because it
   * downloads audio and waits on a speech recogniser — seconds of work that
   * must not hold a lesson open.
   */
  assess_speaking_activity: { activityAttemptId: number };
  /**
   * Transcribe and analyse one peer-call recording. Off the request for the
   * same reason, only more so: diarized ASR over a call of up to thirty minutes
   * plus a model pass is far longer than any request should wait.
   */
  analyse_peer_call: { evaluationId: number };
  send_notification: {
    userId: number;
    type: string;
    payload: Record<string, unknown>;
  };
  process_audio: {
    audioRef: string;
    targetFormat: string;
  };
}

/** What a handler does with a payload. Registered at startup. */
export type JobHandler<N extends JobName> = (payload: JobPayload[N]) => Promise<void>;

const handlers = new Map<JobName, JobHandler<JobName>>();

/**
 * Register the function that runs a job.
 *
 * Handlers are registered rather than imported here so this module stays free
 * of dependencies on the services it runs — importing the grading runner from
 * the queue, and the queue from the grading runner, would be a cycle.
 */
export function registerJobHandler<N extends JobName>(name: N, handler: JobHandler<N>): void {
  handlers.set(name, handler as JobHandler<JobName>);
}

// ─── Queue interface ──────────────────────────────────────────────────────────

export interface JobQueue {
  enqueue<N extends JobName>(
    name: N,
    payload: JobPayload[N],
    options?: { delayMs?: number },
  ): void; // intentionally not async — enqueue is fire-and-forget
}

// ─── In-process fire-and-forget implementation ────────────────────────────────

class FireAndForgetQueue implements JobQueue {
  enqueue<N extends JobName>(name: N, payload: JobPayload[N], options?: { delayMs?: number }): void {
    const run = () => {
      const handler = handlers.get(name);
      if (!handler) {
        logger.warn({ job: name }, "Job enqueued with no registered handler");
        return;
      }

      const started = Date.now();
      // Nothing awaits this. A job that throws must not become an unhandled
      // rejection that takes the process down, so every path is caught here.
      void handler(payload)
        .then(() => {
          logger.info({ job: name, ms: Date.now() - started }, "Job completed");
        })
        .catch((err: unknown) => {
          logger.error({ err, job: name, payload }, "Job failed");
        });
    };

    if (options?.delayMs && options.delayMs > 0) {
      setTimeout(run, options.delayMs).unref?.();
    } else {
      setImmediate(run);
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Shut the backend down cleanly, if it has anything to shut down.
 *
 * Set by the BullMQ backend; a no-op for the in-process one, which has nothing
 * to drain. Called from the server's SIGTERM handler.
 */
let closeBackend: (() => Promise<void>) | null = null;

export async function closeJobQueue(): Promise<void> {
  await closeBackend?.();
  closeBackend = null;
}

function createJobQueue(): JobQueue {
  const backend = process.env.JOB_QUEUE ?? "memory";

  switch (backend) {
    case "memory":
      return new FireAndForgetQueue();

    case "bullmq": {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        // Falling back silently would be worse: the deployment asked for a
        // durable queue and would get an in-process one, losing jobs on every
        // restart with nothing to say so.
        throw new Error('JOB_QUEUE="bullmq" requires REDIS_URL to be set.');
      }

      // Required lazily, and the module is loaded here rather than imported at
      // the top, so that a deployment on the in-process backend never pulls
      // BullMQ or its Redis connection into the process at all.
      //
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createBullMQQueue } = require("./jobs-bullmq") as typeof import("./jobs-bullmq");

      // Handlers are looked up at RUN time, not wired in now: registration
      // happens in a side-effect import that may not have run yet when this
      // module is first evaluated.
      const handles = createBullMQQueue(redisUrl, (name) => handlers.get(name));
      closeBackend = () => handles.close();
      return handles.queue;
    }

    default:
      throw new Error(`Unknown JOB_QUEUE: "${backend}". Supported: memory, bullmq`);
  }
}

export const jobs: JobQueue = createJobQueue();
