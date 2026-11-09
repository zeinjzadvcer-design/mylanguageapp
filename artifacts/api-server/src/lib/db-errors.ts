/**
 * Whether a database error is a unique index refusing a duplicate.
 *
 * Walks the cause chain because Drizzle wraps the driver error, so Postgres's
 * code may sit a level or two down rather than on the error that was thrown.
 */
export function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: string; cause?: unknown };
    if (candidate.code === "23505") return true;
    cursor = candidate.cause;
  }
  return false;
}
