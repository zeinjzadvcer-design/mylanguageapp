import app from "./app";
import { logger } from "./lib/logger";
import { startGradingSweeper, stopGradingSweeper } from "./services/grading-sweeper";
import { ensureBootstrapAdmin } from "./services/bootstrap-admin";
import { closeJobQueue } from "./services/jobs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Stop taking work, finish what is in hand, then exit.
 *
 * The platform sends SIGTERM on every deploy and waits a short while before
 * killing the container. Without this the process dies immediately, which with
 * the in-process queue meant losing whatever job was running and with BullMQ
 * would mean a job left marked active until its lock expires.
 *
 * `worker.close()` inside the queue is the part that matters: it stops
 * accepting new jobs and waits for the running ones, so a deploy no longer
 * interrupts a student's grading mid-flight.
 *
 * Bounded, because a shutdown that hangs is a shutdown the platform kills
 * anyway — and then nothing has drained at all.
 */
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "15000", 10);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  const deadline = setTimeout(() => {
    logger.warn({ ms: SHUTDOWN_TIMEOUT_MS }, "Shutdown timed out — exiting anyway");
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref?.();

  try {
    stopGradingSweeper();
    await closeJobQueue();
    logger.info("Shutdown complete");
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
  }

  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // An empty database has no way in: registration only ever makes students and
  // nothing promotes them. This creates the first administrator from
  // ADMIN_EMAIL / ADMIN_PASSWORD, once, and does nothing on every restart
  // after that. It never throws — a server that will not start because a
  // convenience account could not be created is worse than one without it.
  void ensureBootstrapAdmin();

  // Started after the port is bound, not at import time: a sweep runs real
  // grading, and doing that while the process is still coming up would compete
  // with the requests it is meant to be ready for.
  startGradingSweeper();
});
