import app from "./app";
import { logger } from "./lib/logger";
import { startGradingSweeper } from "./services/grading-sweeper";
import { startSubscriptionSweeper } from "./services/subscription-sweeper";
import { ensureBootstrapAdmin } from "./services/bootstrap-admin";

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
  startSubscriptionSweeper();
});
