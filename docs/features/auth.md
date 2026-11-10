# Feature: Sign Up / Log In (Auth)

## What it does
Lets a person create an account, log in, log out, and check who is currently logged in. A brand-new account is automatically enrolled in the default curriculum (currently English-for-Arabic-speakers) so they're ready to take the placement test.

## Where the code lives
- `artifacts/api-server/src/routes/auth.ts` — the 4 endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `artifacts/api-server/src/middlewares/auth.ts` — `requireAuth` and `requirePermission`, used by every other protected route (see [staff-accounts.md](staff-accounts.md))
- `lib/db/src/schema/users.ts` — `users` table and `student_profiles` table (one profile per user, created at registration)
- Sessions are stored in Postgres (`session` table) via `connect-pg-simple`, not in a token — the browser just holds a cookie
- `artifacts/api-server/src/services/bootstrap-admin.ts` — creates the first administrator at server start (see below); tests in `bootstrap-admin.test.ts`

## How it works
1. Register: checks name/email/password are present and password is at least 6 characters, checks the email isn't already used, hashes the password with bcrypt, creates the user row, then creates a matching `student_profiles` row and enrolls them in the first active curriculum.
2. Login: looks up the user by email, compares the password against the stored hash, and starts a session if it matches.
3. Both register and login store `userId`, `role`, `name`, `email` in the session so later requests don't need to hit the database just to know who's asking.
4. Logout destroys the session server-side.
5. **The first administrator.** Registration hard-codes `role: "student"` and the staff screen cannot grant `admin`, so an empty database has no way in. On start the API creates one administrator from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, which come from the root `.env` (copied from `.env.example`, defaults `admin@example.com` / `admin@1234`). A deployment changes the values in its own `.env`; there is no `NODE_ENV` branch, so the behaviour is identical everywhere.

   It runs once: **if any administrator already exists, nothing happens** — keyed on the count of administrators, not on the email, so deleting the default after promoting your own account is permanent rather than undone by the next restart. It also refuses to touch an existing non-administrator account that happens to hold `ADMIN_EMAIL`, which would otherwise be a silent privilege escalation.

   `ADMIN_PASSWORD` is held to the same `passwordSchema` a student's password is — an administrator on a weaker standard than a student would be the wrong way round — and a rejection is logged rather than silently skipped.

   The account gets no `student_profiles` row: an administrator is not a learner, `/dashboard` already handles a user without a profile, and inventing an enrolment would put a fake student in every progress query.
6. Every other protected route checks `req.session.userId` (and sometimes `req.session.role`) through the middleware — this is the single gate the whole app relies on.

## Quality check

**Solid:**
- Passwords are hashed with bcrypt, never stored or logged in plain text.
- Login and register are both rate-limited (10 attempts / 15 min per IP) — see `app.ts` — so basic brute-forcing is covered.
- Sessions live in Postgres, so restarting the API server doesn't log everyone out, and it works across multiple server instances (important once you're past one box).
- Cookies are `httpOnly`, and `secure` + proper `sameSite` in production.
- `requireAuth`/`requirePermission` are used consistently everywhere else in the codebase — this part is trustworthy.

**Issues found:**
1. ~~Register/login don't use the validation rules that already exist.~~ **Fixed.** `POST /auth/register` now runs `validate(res, registerSchema, req.body)`, which checks the email is really an email and applies `passwordSchema` (8+ characters, a letter, a number, not on the weak list). `POST /auth/login` still parses its own body, but it only reads two fields and compares them against a hash, so nothing is skipped there that matters.
2. **No email verification.** Anyone can sign up with an email they don't own. Fine for a v1 with 10k users, but worth planning for before you rely on email for password resets or notifications.
3. **No "forgot password" flow.** If someone forgets their password today, there's no way for them to get back in on their own — support would have to do it manually in the database.
4. **Duplicate-email race condition (minor, low risk).** If the exact same email registers twice at the exact same instant, the "already registered" check can miss it and the second insert will fail at the database level instead of returning a clean "email already registered" message. It'll show a generic error rather than break anything, but the error message won't be as friendly as it should be.

## Suggested next steps
- Switch `auth.ts` to use `registerSchema`/`loginSchema` from `lib/validate.ts` (small change, closes gap #1).
- Decide if email verification and password reset are needed before or shortly after launch — likely yes, since users will lose access to their account otherwise.
