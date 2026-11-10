# Feature: Staff accounts and permissions

## What it does
An administrator can create accounts for team members from **Admin → Staff accounts** and choose a role for each. Someone in a role sees only the pages that role covers, and the API refuses everything else.

| Role | Can do | Cannot do |
|---|---|---|
| `content_manager` | Create and edit lessons, quizzes, vocabulary, placement questions and media; submit them for review | Publish; marking student work; languages, curricula and levels; payments; students; settings |
| `payments_manager` | Payment queue and receipts, approving and rejecting; prices and exchange rate options; seeing the receiving accounts | Changing the Syriatel Cash QR or account details, the crypto wallet or the SMS forwarder token; lessons, students, settings |
| `admin` | Everything | Cannot be created or changed from the panel |

## Where the code lives
- `artifacts/api-server/src/services/access-policy.ts`: the permission list and what each role holds. The only place that decides who may do what.
- `artifacts/api-server/src/middlewares/auth.ts`: `requirePermission(...)`, the guard every staff route uses.
- `artifacts/api-server/src/routes/admin-staff.ts`: creating accounts and changing roles.
- `artifacts/ascension/src/lib/permissions.ts`: `useCan()`, and which staff area each permission opens.
- `artifacts/ascension/src/pages/admin/staff.tsx`: the staff screen.

## How it works
1. A route asks for a permission, never for a role. `requirePermission` reads the role from the database on each request, so a change applies at once.
2. `GET /auth/me` returns the caller's `permissions`. The frontend tests those and holds no copy of which role may do what.
3. Every role change ends that person's sessions, so they sign in again.
4. Removing access turns the account into a student account, with a student profile, rather than deleting it, because payment reviews and lesson history refer to it. Adding the same email again offers to restore it.
   Admins approve and publish what content managers submit. An admin can also set a new password from the staff screen, for when the emailed reset link is not available.
   Only someone holding `payments.approve_own` can approve a payment from their own account; by default that is administrators alone.
5. Payments staff are not `unmetered` and have `usesStudentApp: false`: they get no free access to lessons, and the student pages redirect to the payments screen.

## Adding a role
1. Add the name to `USER_ROLES` in `lib/db/src/schema/users.ts`. No migration: the column is plain text.
2. Add its entry to `ROLES` in `access-policy.ts`. The API will not compile until you do.

That is all. The role appears in the staff screen, and routes and menus follow from its permissions.

## Adding an area of the product
1. Add a permission to `PERMISSIONS` in `access-policy.ts` and to the `Permission` schema in `lib/api-spec/openapi.yaml`, then run `pnpm --filter @workspace/api-spec run codegen`.
2. Guard its routes with `requirePermission("...")` and its page with `permission="..."` in `App.tsx`.
3. If it is someone's main workspace, add it to `STAFF_PANELS` in `permissions.ts`.

## Limits
- One role per account. Someone doing two jobs needs a role that combines them.
- Roles are defined in code, so changing what a role can do takes a deploy.

## Giving payments staff more access
Add any of these to `payments_manager` in `ROLES`. Each works alone, and the screen and API follow:

| Permission | Unlocks |
|---|---|
| `payments.wallet` | Syriatel Cash QR code and account details |
| `payments.crypto` | Crypto wallet address and QR code |
| `payments.sms_token` | Issuing the SMS forwarder token |

These decide where money goes or can activate subscriptions, so they start with administrators only. Removing `payments.settings` from the role leaves it review-only, and the settings sections disappear. Every field of the settings endpoint is assigned a permission in `PAYMENT_SETTING_PERMISSIONS`; a new field is refused for everyone until it is added there.
