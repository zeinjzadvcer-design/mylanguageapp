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
 * TWO QUEUES, NOT FIVE
 * ────────────────────
 * Jobs are dispatched by name, and all but one share a queue. Analysing a
 * peer call is the exception: it transcribes up to fifteen minutes of audio and
 * can hold a worker slot for minutes. Sharing one pool, a few evaluated calls
 * left every student's recording in a lesson waiting behind them. Calls get a
 * queue and a worker of their own, so lesson grading always has its slots.
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
import { envInt } from "../lib/env";
import type { JobName, JobPayload, JobQueue } from "./jobs";

/** Every job except call analysis; the name is carried on the job itself. */
const QUEUE_NAME = "ascension-jobs";

/** Peer-call analysis only. See "Two queues" above. */
const CALLS_QUEUE_NAME = "ascension-calls";

/**
 * How many lesson and quiz jobs this process runs at once.
 *
 * A job is mostly *waiting* — on a speech recogniser, on a model. It takes a
 * database connection only for each query and gives it back, so the limit
 * here is not the pool: it is how many paid AI calls run at once, and the
 * memory of the recordings being handled.
 */
const CONCURRENCY = envInt("JOB_CONCURRENCY", 4);

/** How many call analyses run at once, alongside the jobs above. */
const CALL_CONCURRENCY = envInt("JOB_CALL_CONCURRENCY", 2);

/** The queue a job runs on. */
function queueFor(name: JobName): string {
  return name === "analyse_peer_call" ? CALLS_QUEUE_NAME : QUEUE_NAME;
}

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
const ATTEMPTS = envInt("JOB_ATTEMPTS", 2);

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
  const workerEnabled = (process.env.JOB_WORKER ?? "on") !== "off";

  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];

  for (const [name, concurrency] of [
    [QUEUE_NAME, CONCURRENCY],
    [CALLS_QUEUE_NAME, CALL_CONCURRENCY],
  ] as const) {
    const queue = new Queue(name, {
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
      logger.error({ err, queue: name }, "Job queue error");
    });
    queues.set(name, queue);

    if (!workerEnabled) continue;

    const worker = new Worker(
      name,
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
      { connection: createConnection(redisUrl), concurrency },
    );

    worker.on("completed", (job) => {
      logger.info({ job: job.name, id: job.id, queue: name }, "Job completed");
    });
    worker.on("failed", (job, err) => {
      // `attemptsMade` against `attempts` is the useful part: a first failure
      // that will be retried reads very differently from a final one.
      logger.error(
        { err, job: job?.name, id: job?.id, queue: name, attempt: job?.attemptsMade, of: ATTEMPTS },
        "Job failed",
      );
    });
    worker.on("error", (err) => {
      logger.error({ err, queue: name }, "Job worker error");
    });
    workers.push(worker);
  }

  logger.info(
    {
      queues: [...queues.keys()],
      worker: workerEnabled,
      concurrency: CONCURRENCY,
      callConcurrency: CALL_CONCURRENCY,
      attempts: ATTEMPTS,
    },
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
      void queues
        .get(queueFor(name))!
        .add(name, payload, jobOptions)
        .catch((err: unknown) => {
          logger.error({ err, job: name, payload }, "Could not enqueue job");
        });
    },
  };

  return {
    queue: api,
    async close() {
      // Workers first: they stop taking new jobs and wait for the ones they
      // hold, so a deploy does not kill work mid-flight. Then the producers.
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      await producerConnection.quit().catch(() => {});
    },
  };
}
