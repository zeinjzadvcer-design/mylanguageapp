import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import helmet from "helmet";
import compression from "compression";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { RedisStore, type SendCommandFn } from "rate-limit-redis";
import router from "./routes";
import docsRouter from "./routes/docs";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { redis } from "./services/redis";
import { createRedisSessionStore } from "./services/session-store";
// Side-effect import: registers the handlers the background queue dispatches to.
import "./services/job-handlers";

const app: Express = express();

// Trust the first reverse proxy (e.g. nginx / Cloudflare).
// Required for rate-limit to correctly identify client IPs from X-Forwarded-For,
// and for secure cookies to work behind HTTPS termination.
app.set("trust proxy", parseInt(process.env.TRUST_PROXY ?? "1", 10));

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  }),
);

// ── Compression ────────────────────────────────────────────────────────────────
app.use(compression());

// ── Request logging ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({ origin: allowedOrigin ?? true, credentials: true }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// ── API reference (Swagger UI) ─────────────────────────────────────────────────
// On by default in development so the docs are there without extra setup; off in
// production unless API_DOCS_ENABLED=true, so a deployment opts in deliberately.
// Mounted before sessions and rate limiting: it is static content, it should not
// create sessions, and it must not eat the caller's /api request budget.
// An empty API_DOCS_ENABLED counts as unset: .env.example ships the key blank,
// and copying it must not turn the docs off in development.
const docsFlag = process.env.API_DOCS_ENABLED?.trim();
const docsEnabled = docsFlag ? docsFlag === "true" : process.env.NODE_ENV !== "production";

if (docsEnabled) {
  // /docs is the canonical URL on the API host. /api/docs is the same page
  // reachable through anything that already forwards /api — the Vite dev server
  // proxy and the Vercel rewrite — so the docs work from the web app's origin too.
  app.use("/docs", docsRouter);
  app.use("/api/docs", docsRouter);
  logger.info("API reference available at /docs and /api/docs");
}

// ── Sessions ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production");
}
if (!process.env.SESSION_SECRET) {
  logger.warn("SESSION_SECRET not set — using insecure default (development only)");
}

/**
 * Sessions live in Redis when it is configured, PostgreSQL otherwise.
 *
 * Measured under load, the PostgreSQL store was just under half of all
 * database time — two queries on every request from every user, one to read
 * the session and one to push its expiry out for `rolling` below. In Redis
 * those are a GET and an EXPIRE, both in memory.
 *
 * The trade is that Redis becomes load-bearing for authentication rather than
 * only for the AI quota and the cache; see services/session-store.ts.
 */
const PgSession = connectPgSimple(session);
const redisSessionStore = createRedisSessionStore();
if (redisSessionStore) {
  logger.info("Sessions stored in Redis");
} else {
  logger.info("Sessions stored in PostgreSQL (REDIS_URL not set)");
}

app.use(
  session({
    store:
      redisSessionStore ??
      new PgSession({
        pool,
        tableName: "session",
        createTableIfMissing: true,
        // Seconds between expired-session cleanups. The 15-minute default wakes
        // a scale-to-zero database (Neon free tier) around the clock; raise it
        // there. Unused when Redis holds the sessions: it expires its own keys.
        pruneSessionInterval: parseInt(process.env.SESSION_PRUNE_INTERVAL_S ?? "900", 10),
      }),
    secret: process.env.SESSION_SECRET ?? "ascension-dev-secret",
    resave: false,
    saveUninitialized: false,
    /**
     * Re-send the cookie on every response, so its 30 days are counted from
     * the student's last visit rather than from the day they logged in.
     *
     * Without this the two halves of a session expire on different clocks:
     * `connect-pg-simple` implements `touch`, so express-session keeps pushing
     * the DATABASE row's expiry forward on each request, while the BROWSER
     * cookie keeps the fixed `maxAge` it was given at login. A student using
     * the app daily was still logged out 30 days after signing in, mid-use and
     * for no reason they could see — the server-side session was alive and
     * well; the cookie carrying its id had simply expired.
     *
     * The cost is a `Set-Cookie` header on every response, which is a few dozen
     * bytes and no extra query: the store is touched either way.
     */
    rolling: true,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      /**
       * `lax` in both, not `none` in production.
       *
       * The frontend is served from the same origin as the API — the platform
       * routes `/api` to this service, which is the whole reason that routing
       * exists — so the cookie is first-party and `lax` applies cleanly.
       *
       * `none` was wrong in two ways. It needs `secure`, so any environment
       * serving plain HTTP dropped the cookie entirely and the student was
       * logged out on the next request. And it tells the browser the cookie is
       * for cross-site use, which modern privacy settings and tracking
       * protection are increasingly willing to discard — intermittently, and
       * per-browser, which is exactly what an unexplained logout looks like.
       */
      sameSite: "lax",
    },
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
/**
 * Rate limit store selection:
 * - Redis available → RedisStore: limits are shared across all API server
 *   instances; correct for horizontal scaling.
 * - Redis unavailable → default in-process store: per-instance limits only;
 *   acceptable for single-server development.
 *
 * Failure behavior: fail OPEN. A Redis problem must not stop people using the
 * app — rate limiting is abuse protection, not correctness. AI quota is the
 * opposite and fails closed, because unlimited paid AI costs real money
 * (see services/ai-quota.ts).
 *
 * This does not happen by itself. The ioredis client is created with
 * `enableOfflineQueue: false`, so any command issued while it is connecting or
 * disconnected throws synchronously; rate-limit-redis passes that error on, and
 * express-rate-limit turns it into a 500. Left alone, every request during the
 * first moments after a restart — and every request during a Redis blip —
 * answers 500 rather than being allowed through. Hence `failOpen` below.
 */
type RedisClient = InstanceType<typeof import("ioredis").default>;

/** Resolves once the client is connected; rejects after `timeoutMs`. */
function redisReady(client: RedisClient, timeoutMs: number): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      reject(new Error("Redis not ready"));
    }, timeoutMs);
    client.once("ready", onReady);
  });
}

/**
 * rate-limit-redis loads its Lua scripts once, in init(), and every later call
 * awaits that same promise. init() runs when this module is imported — before
 * the lazily connected client is up — so the load failed, every increment
 * rejected with it, and failOpen let every request through: rate limiting,
 * login brute-force protection included, was silently off from the first boot.
 *
 * Two fixes. Script loads wait for the connection (only they do; ordinary
 * commands still fail fast, so a Redis outage never adds latency). And if a
 * call fails anyway — Redis was down at boot, or restarted and lost its script
 * cache — the scripts are reloaded in the background for the next request.
 */
class RecoveringRedisStore extends RedisStore {
  private reloading = false;

  override async increment(key: string) {
    try {
      return await super.increment(key);
    } catch (err) {
      this.reloadScripts();
      throw err;
    }
  }

  override async get(key: string) {
    try {
      return await super.get(key);
    } catch (err) {
      this.reloadScripts();
      throw err;
    }
  }

  private reloadScripts() {
    if (this.reloading) return;
    this.reloading = true;
    this.init({ windowMs: this.windowMs } as Parameters<RedisStore["init"]>[0])
      .catch(() => {})
      .finally(() => {
        this.reloading = false;
      });
  }
}

function makeRedisStore(prefix: string): RedisStore | undefined {
  if (!redis) return undefined;
  const client = redis as RedisClient;
  return new RecoveringRedisStore({
    prefix,
    // ioredis call() is the raw Redis command interface
    sendCommand: (async (...args: string[]) => {
      if (args[0] === "SCRIPT") await redisReady(client, 10_000);
      return client.call(args[0], ...args.slice(1));
    }) as SendCommandFn,
  });
}

/**
 * Let a request through when the rate-limit store cannot answer.
 *
 * express-rate-limit reports a store failure by calling `next(err)`. Swallowing
 * it and calling `next()` is what "fail open" actually means here — without
 * this the documented behaviour above is not the real behaviour.
 */
function failOpen(limiter: RequestHandler): RequestHandler {
  return (req, res, next) => {
    try {
      limiter(req, res, (err?: unknown) => {
        if (err) {
          logger.warn({ err }, "Rate limit store unavailable — allowing the request");
          next();
          return;
        }
        next();
      });
    } catch (err) {
      logger.warn({ err }, "Rate limit store threw — allowing the request");
      next();
    }
  };
}

// Voice practice polls once a second for as long as a student is queued or in
// a call — ~900 requests per window on its own, which under the broad limit
// below would cut every call off after about three minutes. It gets its own
// budget instead, keyed by the signed-in user so classmates behind one school
// or mobile-carrier NAT do not share it.
//
// BOTH polling paths belong here, not just /poll. `use-voice-call.ts` polls
// /poll AND /sessions/:id/signals on the same one-second timer, so exempting
// only the first left the second on the broad 200-per-15-minutes budget — which
// is IP-keyed, so two students testing from one machine shared it and burned it
// in about a minute and a half. What that looked like: every request 429, the
// app reporting the server as asleep, and the call never ending — the 30-minute
// cap is enforced when someone polls, so a 429'd poll means nothing closes the
// session. One call sat "active" for two and a half hours.
const PRACTICE_POLL_PATH = "/practice/poll";

/** Matches /api/practice/sessions/:id/signals, the other one-second poll. */
const PRACTICE_SIGNALS_RE = /^\/practice\/sessions\/\d+\/signals$/;

function isPracticePoll(path: string): boolean {
  return path === PRACTICE_POLL_PATH || PRACTICE_SIGNALS_RE.test(path);
}

const practicePollLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000", 10),
  // Two polls a second now share this budget (status + signals), and a
  // 15-minute window holds 900 seconds — so a single student in one continuous
  // call needs ~1800. 1200 was sized for one poller and would cut a call off
  // after ten minutes.
  limit: parseInt(process.env.RATE_LIMIT_PRACTICE_POLL ?? "2400", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: makeRedisStore("rl:poll:"),
  keyGenerator: (req) =>
    req.session?.userId ? `user:${req.session.userId}` : ipKeyGenerator(req.ip ?? ""),
  message: { error: "Too many requests, please try again later" },
});

// Broad limit: all API endpoints — protects against general abuse.
//
// Keyed by the signed-in user, falling back to IP only for anonymous requests.
// IP alone is wrong here for the same reason it was wrong for the poll limiter,
// and worse in practice: the browser talks to Vite, which proxies to the API, so
// EVERY signed-in user arrives as the web container's single address and shares
// one 200-request budget. Two students in a call exhausted it and the app
// reported the server as asleep — and the request that lost was whichever came
// last, which made it look random rather than like a limit.
//
// The same collapse happens in production behind any shared NAT: a school or a
// mobile carrier is one address for hundreds of students. Per-user is the unit
// that actually matches "general abuse by one account".
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000", 10), // 15 min
  limit: parseInt(process.env.RATE_LIMIT_API ?? "600", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: makeRedisStore("rl:api:"),
  keyGenerator: (req) =>
    req.session?.userId ? `user:${req.session.userId}` : ipKeyGenerator(req.ip ?? ""),
  // Relative to the /api mount below. Limited by practicePollLimiter instead.
  // `/healthz` is exempt: it is a liveness probe, and a probe answering 429 is
  // read as "the server is down" by everything that calls it — which is how a
  // rate limit came to be reported to students as the server waking up.
  skip: (req) => isPracticePoll(req.path) || req.path === "/healthz",
  message: { error: "Too many requests, please try again later" },
});

// Strict limit: auth endpoints — brute-force protection
const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000", 10),
  limit: parseInt(process.env.RATE_LIMIT_AUTH ?? "10", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: makeRedisStore("rl:auth:"),
  skipSuccessfulRequests: true,
  message: { error: "Too many authentication attempts, please try again later" },
});

app.use("/api", failOpen(apiLimiter));
app.use(`/api${PRACTICE_POLL_PATH}`, failOpen(practicePollLimiter));
// Signal reads are polled on the same timer, so they need the same per-user
// budget. Mounted as a predicate because the path carries a session id.
app.use("/api/practice/sessions", (req, res, next) => {
  // `req.path` here is relative to this mount point.
  if (/^\/\d+\/signals$/.test(req.path)) {
    failOpen(practicePollLimiter)(req, res, next);
    return;
  }
  next();
});
app.use("/api/auth/login", failOpen(authLimiter));
app.use("/api/auth/register", failOpen(authLimiter));
// Reset endpoints are brute-force targets: one guesses tokens, the other can be
// used to probe which addresses are registered.
app.use("/api/auth/forgot-password", failOpen(authLimiter));
app.use("/api/auth/reset-password", failOpen(authLimiter));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Global error handler ──────────────────────────────────────────────────────
// Express 5 forwards async errors automatically. This normalises them into
// a consistent { error: string } response with proper status codes.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const status =
    typeof (err as { status?: number }).status === "number"
      ? (err as { status: number }).status
      : 500;

  const message =
    process.env.NODE_ENV !== "production" && err instanceof Error
      ? err.message
      : "An unexpected error occurred";

  logger.error({ err, url: req.url, method: req.method }, "Unhandled error");

  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

export default app;
