/**
 * Wiring background jobs to the code that runs them.
 *
 * Kept apart from `jobs.ts` so the queue does not import the services it runs:
 * the grading runner enqueues nothing, but a future handler will, and a cycle
 * between the queue and its handlers is a hard problem to unpick later.
 *
 * Imported once for its side effects, from `app.ts`.
 */

import { registerJobHandler } from "./jobs";
import { gradeLessonActivity, gradeQuizAttempt, gradeSpeakingActivity } from "./grading-runner";
import { analyseEvaluation } from "./practice-evaluation";

registerJobHandler("grade_quiz_attempt", async ({ attemptId }) => {
  await gradeQuizAttempt(attemptId);
});

registerJobHandler("assess_speaking_activity", async ({ activityAttemptId }) => {
  await gradeSpeakingActivity(activityAttemptId);
});

registerJobHandler("grade_lesson_activity", async ({ activityAttemptId }) => {
  await gradeLessonActivity(activityAttemptId);
});

registerJobHandler("analyse_peer_call", async ({ evaluationId }) => {
  await analyseEvaluation(evaluationId);
});
