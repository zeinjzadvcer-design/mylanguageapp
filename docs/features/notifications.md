# Feature: Student notifications

## What it does
Students get in-app notifications under a bell in the header, with an unread count. Tapping one opens the page it is about and marks it read.

| Notification | When | Opens |
|---|---|---|
| Subscription active | A payment is approved: by staff, by the Syriatel Cash SMS match, or by the crypto check | `/subscription` |
| Payment not accepted | A payment is rejected, with the reason the student is given | `/subscription` |
| Time for today's lesson | Once a day from 6 pm Damascus time, to students who have not touched a lesson that day | `/learn`, or `/placement` before the placement test |
| A new quiz is available | A practice quiz is published at a level the student has reached, or the student reaches a level that has quizzes | `/quizzes` |
| Your level test is open | Passing a lesson opens the level's evaluation | `/quizzes` |

Students can turn the daily reminder off on their profile page. Staff accounts get no notifications.

## Where the code lives
- `lib/db/src/schema/notifications.ts`: the `notifications` table; `student_profiles.lesson_reminders` holds the reminder setting.
- `artifacts/api-server/src/services/notifications.ts`: creating, reading and the background sweep.
- `artifacts/api-server/src/services/notification-policy.ts`: when the reminder is due, and the keys that stop repeats. Pure, with tests.
- `artifacts/api-server/src/routes/notifications.ts`: `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `GET`/`PUT /notifications/settings`.
- `artifacts/ascension/src/components/notification-bell.tsx`: the bell and the list.

## How it works
1. A notification stores its kind and the facts it needs (plan names, a quiz title, a reason). The app turns those into text in the student's current language, so switching language changes old notifications too.
2. Every notification has a dedupe key, and a unique index on (student, key) makes sending twice a no-op. That is what lets the sweep run every few minutes on any number of servers, and stops a retried payment approval from announcing itself twice.
3. Payment decisions notify from `subscription-activation.ts`, after the transaction commits, so every way a payment is settled is covered and a rolled-back approval says nothing.
4. The sweep runs every 5 minutes. It sends the daily reminder and announces quizzes at levels students reached in the last day; level changes happen inside transactions in several places, so they are picked up here rather than at each of them.
5. Sending never throws. A failed notification is logged and never undoes a payment approval or a lesson completion.
6. Notifications older than 90 days are deleted by the sweep.

## Settings
| Variable | Default | Meaning |
|---|---|---|
| `REMINDER_HOUR` | `18` | Local hour the daily reminder starts going out. It stops at 22:00 so nobody is woken at night. |
| `REMINDER_TIMEZONE` | `Asia/Damascus` | Whose day and hour count. |
| `NOTIFICATION_SWEEP_INTERVAL_MS` | `300000` | How often the sweep runs. |
| `NOTIFICATIONS_SWEEP_ENABLED` | on | Set to `false` to stop the sweep on an instance. |

## Limits
- In-app only: nothing reaches a student while the app is closed. Browser push or email can be added later as another way to deliver the same rows.
- The bell checks for new notifications once a minute and whenever the tab regains focus, not instantly.
- A level test published after a student has already finished the level's lessons is not announced; they see it the next time they pass a lesson there, or on the quizzes page.
- "Studied today" means a lesson or lesson block was touched; time spent only on vocabulary or practice calls still gets a reminder.
