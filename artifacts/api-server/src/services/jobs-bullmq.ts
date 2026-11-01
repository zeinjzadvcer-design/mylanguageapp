/**
 * The BullMQ job backend.
 *
 * WHAT IT FIXES
 * ─────────────
 * `FireAndForgetQueue` runs work with `setImmediate` inside the web process.
 * Two consequences follow, and both are now live problems rather than
 * theoretical ones:
 *
 *   1. A job enqueued but not finished is LOST on restart. With
 *      `deploy_on_push: true` that is every deploy, and the grading sweeper
 *      only notices on its next pass — up to ten minutes of a student waiting
 *      on pronunciation feedback that is never coming.
 *
 *   2. It caps the deployment at ONE instance. A second one would not share
 *      the work, so a job enqueued on instance A dies with A, and both
 *      instances would run their own sweepers over the same rows.
 *
 * A durable queue in Redis fixes the first and unblocks the second, which is
 * what makes "a deploy causes no gap in service" possible at all.
 *
 * ONE QUEUE, NOT FIVE
 * ───────────────────
 * All five job names share a queue and are dispatched by name. Five queues
 * would mean five workers, five sets of connections and five things to watch,
 * for work that is a handful of jobs per student per lesson.
 *
 * THE WORKER RUNS IN THIS PROCESS, FOR NOW
 * ────────────────────────────────────────
 * `JOB_WORKER=off` leaves a process producing jobs without consuming them,
 * which is exactly what a separate worker deployment needs: same image,
 * different environment. Until that exists, the web process does both — which
 * is still a strict improvement, because the job survives the restart even
 * when the process running it does not.
 */

import { Queue, Worker, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import { logger } from "../lib/logger";
import type { JobName, JobPayload, JobQueue } from "./jobs";

/** One queue for every job name; the name is carried on the job itself. */
const QUEUE_NAME = "ascension-jobs";

/**
 * How many jobs this process runs at once.
 *
 * Deliberately small. A job is mostly *waiting* — on a speech recogniser, on a
 * model — but it holds a PostgreSQL connection while it waits, and
 * `DB_POOL_MAX` is 10 per process. Letting twenty jobs run at once would starve
 * the HTTP requests sharing that pool, which is the opposite of the point.
 */
const CONCURRENCY = parseInt(process.env.JOB_CONCURRENCY ?? "4", 10);

/**
 * Retries, and why not more of them.
 *
 * The grading sweeper is already a recovery path and already bounded by
 * `GRADING_SWEEP_MAX_ATTEMPTS`. Retrying hard here as well would multiply paid
 * AI calls against a provider having a bad day — the exact failure
 * docs/ai-cost-model.md lists as unmodelled. Two attempts catches a transient
 * blip; anything worse is the sweeper's problem, and it escalates to the human
 * marking queue rather than spending money in a loop.
 */
const ATTEMPTS = parseInt(process.env.JOB_ATTEMPTS ?? "2", 10);

/**
 * BullMQ requires `maxRetriesPerRequest: null` — it blocks on Redis for long
 * stretches by design, and a client that gives up mid-wait breaks the worker.
 * The shared client in services/redis.ts sets `0` so that a cache read fails
 * fast and falls back to PostgreSQL, which is right for a cache and wrong
 * here. Hence its own connection.
 */
function createConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
}

export interface BullMQQueueHandles {
  queue: JobQueue;
  /** Finish what is in flight and let go of Redis. Called on shutdown. */
  close(): Promise<void>;
}

export function createBullMQQueue(
  redisUrl: string,
  resolveHandler: (name: JobName) => ((payload: unknown) => Promise<void>) | undefined,
): BullMQQueueHandles {
  const producerConnection = createConnection(redisUrl);

  const queue = new Queue(QUEUE_NAME, {
    connection: producerConnection,
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: "exponential", delay: 2000 },
      // Keep the queue from growing without bound. Enough history to see what
      // happened recently; not an archive.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  queue.on("error", (err) => {
    logger.error({ err }, "Job queue error");
  });

  const workerEnabled = (process.env.JOB_WORKER ?? "on") !== "off";
  let worker: Worker | null = null;

  if (workerEnabled) {
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const handler = resolveHandler(job.name as JobName);
        if (!handler) {
          // Not retryable: a missing handler is a deployment that does not know
          // about this job, and trying again will not teach it.
          logger.warn({ job: job.name }, "Job has no registered handler — discarding");
          return;
        }
        await handler(job.data);
      },
      { connection: createConnection(redisUrl), concurrency: CONCURRENCY },
    );

    worker.on("completed", (job) => {
      logger.info({ job: job.name, id: job.id }, "Job completed");
    });

    worker.on("failed", (job, err) => {
      // `attemptsMade` against `attempts` is the useful part: a first failure
      // that will be retried reads very differently from a final one.
      logger.error(
        { err, job: job?.name, id: job?.id, attempt: job?.attemptsMade, of: ATTEMPTS },
        "Job failed",
      );
    });

    worker.on("error", (err) => {
      logger.error({ err }, "Job worker error");
    });
  }

  logger.info(
    { queue: QUEUE_NAME, worker: workerEnabled, concurrency: CONCURRENCY, attempts: ATTEMPTS },
    "BullMQ job backend started",
  );

  const api: JobQueue = {
    enqueue<N extends JobName>(
      name: N,
      payload: JobPayload[N],
      options?: { delayMs?: number },
    ): void {
      const jobOptions: JobsOptions = {};
      if (options?.delayMs && options.delayMs > 0) jobOptions.delay = options.delayMs;

      // Not awaited, because `enqueue` is synchronous by contract: an HTTP
      // handler must not wait on Redis to answer a student. A failure to
      // enqueue is logged and left to the grading sweeper, which is the same
      // recovery path a lost in-process job had.
      void queue.add(name, payload, jobOptions).catch((err: unknown) => {
        logger.error({ err, job: name, payload }, "Could not enqueue job");
      });
    },
  };

  return {
    queue: api,
    async close() {
      // Worker first: it stops taking new jobs and waits for the ones it holds,
      // so a deploy does not kill work mid-flight. Then the producer.
      await worker?.close();
      await queue.close();
      await producerConnection.quit().catch(() => {});
    },
  };
}
