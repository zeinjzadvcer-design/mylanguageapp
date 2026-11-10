# Feature Docs & Quality Review

This folder has one file per feature: what it does, how it works, and a plain-English quality check (what's solid, what's missing or risky). It's meant to be read by whoever is reviewing commits on this repo, not just the person who wrote the code.

**Scope of this pass:** the core student learning flow only — sign up/login, the placement test, lessons, quizzes, progress tracking, and the planned AI chat feature. Admin/CMS tools and subscriptions/payments were not reviewed yet; do those next if you want the same treatment.

**Depth of this pass:** a quick read-through of each feature's code, looking for bugs, missing pieces, and things that will hurt once you have real users — not a deep security or load-testing audit.

## At a glance

| Feature | File | Overall | Top issue |
|---|---|---|---|
| Sign up / log in | [auth.md](auth.md) | Good | Validation gap fixed; the first administrator is now created at start from `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| Placement test | [placement-test.md](placement-test.md) | Good | No way to retake a placement test once completed |
| Lessons & levels | [lessons.md](lessons.md) | Very good | `GET /levels` loads every lesson in the database instead of just the current curriculum's — will slow down once German/more curricula are added |
| Quizzes | [quizzes.md](quizzes.md) | Very good | Quiz time limits are shown to students but not actually enforced by the server |
| Progress tracking / dashboard | [progress-tracking.md](progress-tracking.md) | Good, one broken feature | The "streak" counter is never updated — it will always show 0 |
| AI chat ("talk to AI") | [ai-chat.md](ai-chat.md) | Not built yet | Only the plumbing (quotas, provider interface) exists; no actual conversation feature or endpoint |
| Level evaluation & promotion | [level-evaluation.md](level-evaluation.md) | New | Evaluations containing speaking or writing blocks stay ungraded — nothing grades them yet |
| Media storage & recordings | [media-uploads.md](media-uploads.md) | New | Recordings are stored but nothing transcribes or scores them yet |
| AI configuration panel | [ai-configuration.md](ai-configuration.md) | New | No audit trail of who changed a limit |
| Open-answer grading | [open-answer-grading.md](open-answer-grading.md) | New | Background jobs are in-process: a restart loses one, and nothing retries pending work |
| Pronunciation & fluency | [pronunciation.md](pronunciation.md) | New | Not phoneme-level: catches words the recogniser hears wrong, not subtle vowel errors |
| CMS authoring | [cms-authoring.md](cms-authoring.md) | New | No quiz preview, and reference audio still cannot be attached to a block from the UI |
| Grading recovery & marking | [grading-recovery.md](grading-recovery.md) | New | Nothing alerts when the human queue grows — the signal that AI is misconfigured |
| Skill profile & weaknesses | [weakness-engine.md](weakness-engine.md) | New | No history: computed fresh each time, so there is no progress-over-time view |
| AI conversation tutor | [conversation-tutor.md](conversation-tutor.md) | New | The per-plan daily limit counts model calls, so it can silently truncate a long block |
| Multi-skill placement | [placement.md](placement.md) | New | Listening, speaking and pronunciation are still not assessed; no CMS screen for questions |
| Student-to-student voice practice | [voice-practice.md](voice-practice.md) | New | No TURN relay, so roughly 10–20% of calls will not connect — the UI says so rather than hanging |
| Staff accounts & permissions | [staff-accounts.md](staff-accounts.md) | New | One role per account; roles are defined in code, so a change takes a deploy |
| Payments & plan access | [payments.md](payments.md) | New | Migrations never run against a database; sanctions screening on crypto senders is recorded but not checked |

## What this tells you overall

The core learning loop — the part where a student actually studies and gets graded — is the strongest part of the codebase. Scoring, grading, and unlock rules are done properly on the server, answer keys are never leaked to the browser, and a lot of the classic scaling mistakes (fetching everything and filtering in code, querying once per row in a loop) have already been found and fixed in most places. It's clear real care went into this part.

The rougher edges are smaller and more fixable: one feature is silently non-functional rather than broken (the streak counter), one repeated performance mistake reappeared in a spot that wasn't fixed yet (`GET /levels`), and a couple of features are announced-but-not-enforced (quiz time limits, AI chat). None of these are "the app doesn't work" problems — they're the kind of thing worth fixing before or shortly after you scale past a handful of users, especially once German is added and traffic grows toward 10k users.

## Suggested priority order
1. Fix `GET /levels` to filter by curriculum before it becomes a real slowdown (cheap fix, compounds with scale).
2. Decide what to do about the streak counter (build it or hide it) — showing a permanently-wrong number erodes trust in the product.
3. Decide if quiz time limits need real enforcement before they're used for anything that matters.
4. Scope out the real "talk to AI" feature separately — it's a new build, not a fix.
5. Decide whether to run a TURN relay for voice practice, or accept that some calls will not connect.

*Reviewed: 2026-08-29. Admin/CMS tools and subscriptions were out of scope for this pass.*
