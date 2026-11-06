/**
 * The student's quiz list.
 *
 * Published quizzes existed, the API served them, and the runner at
 * /quiz/:id worked — but nothing linked to any of it, so the only way in was
 * typing a URL. This is that missing entry point.
 *
 * Level evaluations are the same table with `kind: "level_evaluation"`; they
 * are reached from the level page as a progression gate, so this list is the
 * practice quizzes a student can take on their own.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { listQuizzes, type QuizListItem } from "@/lib/quiz-api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GraduationCap, Clock, Trophy, CheckCircle2, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n";

function QuizCard({ quiz }: { quiz: QuizListItem }) {
  const { t, pick } = useI18n();
  const q = t.quizzes;
  const exhausted =
    quiz.attemptsRemaining !== null && quiz.attemptsRemaining <= 0 && !quiz.activeAttemptId;
  const timeLimit = quiz.timeLimitSec ? q.minutes(Math.round(quiz.timeLimitSec / 60)) : null;

  return (
    <Card className="border-2 border-border hover:border-primary/30 transition-colors">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 flex-1">
            <h3 className="text-lg font-bold text-foreground">{pick(quiz.titleAr, quiz.title)}</h3>
            {pick(quiz.descriptionAr, quiz.description) && (
              <p className="text-sm text-muted-foreground leading-relaxed">{pick(quiz.descriptionAr, quiz.description)}</p>
            )}
          </div>
          {quiz.passed && (
            <Badge className="shrink-0 bg-mint text-accent-foreground hover:bg-mint">
              <CheckCircle2 className="h-3 w-3 me-1" /> {q.passed}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {timeLimit && (
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> {timeLimit}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Trophy className="h-3.5 w-3.5" /> {q.passMark(quiz.passingScore)}
          </span>
          {quiz.bestScore !== null && (
            <span className="font-medium text-foreground">
              {q.bestScore(Math.round(quiz.bestScore))}
            </span>
          )}
          <span>
            {quiz.attemptsRemaining === null
              ? q.attemptsUsed(quiz.attemptsUsed)
              : q.attemptsLeft(quiz.attemptsRemaining, quiz.maxAttempts ?? quiz.attemptsRemaining)}
          </span>
        </div>

        <div className="pt-1">
          {exhausted ? (
            <Button disabled className="w-full md:w-auto">
              {q.noAttempts}
            </Button>
          ) : (
            <Link href={`/quiz/${quiz.id}`}>
              <Button className="w-full md:w-auto">
                {quiz.activeAttemptId ? (
                  <>
                    <RotateCcw className="h-4 w-4 me-1" /> {q.resume}
                  </>
                ) : quiz.attemptsUsed > 0 ? (
                  q.retake
                ) : (
                  q.start
                )}
              </Button>
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Quizzes() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["student-quizzes"],
    queryFn: listQuizzes,
  });
  const { t } = useI18n();
  const q = t.quizzes;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-destructive">{q.loadError}</div>
    );
  }

  const all = data.quizzes ?? [];
  // A level evaluation is a gate: starting one is refused until the level's
  // lessons are done, so it is shown apart rather than as a practice quiz.
  const quizzes = all.filter((q) => q.kind !== "level_evaluation");
  const evaluations = all.filter((q) => q.kind === "level_evaluation");

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold text-foreground">{q.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {q.subtitle}
        </p>
      </div>

      {all.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 flex flex-col items-center text-center gap-3">
            <GraduationCap className="h-12 w-12 text-muted-foreground/40" />
            <p className="text-muted-foreground">
              {q.empty}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {quizzes.map((quiz) => (
            <QuizCard key={quiz.id} quiz={quiz} />
          ))}
        </div>
      )}

      {evaluations.length > 0 && (
        <div className="space-y-3 pt-4">
          <div>
            <h2 className="text-xl font-bold text-foreground">{q.levelTitle}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {q.levelBody}
            </p>
          </div>
          {evaluations.map((quiz) => (
            <QuizCard key={quiz.id} quiz={quiz} />
          ))}
        </div>
      )}
    </div>
  );
}
