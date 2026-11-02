/**
 * What the student is good at, what needs work, and what to do next.
 *
 * Spec section 12 asks for a simple progress view showing where they are, what
 * they are good at, and what they need to improve. Section 8 asks for advice on
 * where to put effort — singular, and pointing at material they already have.
 *
 * Two things this deliberately does not do:
 *
 *  - It does not show a score for a skill it has too little evidence for. A
 *    confident-looking "grammar: 40%" built on one answer is worse than an
 *    empty space: it is probably wrong, it is discouraging, and it teaches the
 *    student not to believe the rest of the page.
 *  - It does not offer AI conversation practice as a remedy. Every
 *    recommendation is a lesson or a word list from their own course.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  getSkillReport,
  type SkillSummary,
  type Recommendation,
} from "@/lib/skills-api";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  RotateCcw,
  Mic,
  BookOpen,
  Loader2,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";

function TrendIcon({ trend }: { trend: SkillSummary["trend"] }) {
  if (trend === "improving") return <TrendingUp className="h-3.5 w-3.5 text-mint-foreground" />;
  if (trend === "declining") return <TrendingDown className="h-3.5 w-3.5 text-rose-500" />;
  if (trend === "steady") return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  return null;
}

function barColour(score: number): string {
  if (score >= 82) return "[&>div]:bg-mint";
  if (score <= 65) return "[&>div]:bg-amber-500";
  return "[&>div]:bg-primary";
}

function RecommendationIcon({ kind }: { kind: Recommendation["kind"] }) {
  if (kind === "repeat_pronunciation" || kind === "practise_words") {
    return <Mic className="h-4 w-4" />;
  }
  if (kind === "redo_lesson") return <RotateCcw className="h-4 w-4" />;
  return <BookOpen className="h-4 w-4" />;
}

export function SkillProfileCard() {
  const [, setLocation] = useLocation();
  const [wantAdvice, setWantAdvice] = useState(false);
  const { t, lang, pick } = useI18n();
  const sk = t.skillCard;

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["skill-report", wantAdvice],
    queryFn: () => getSkillReport(wantAdvice),
  });

  if (isLoading) return <Skeleton className="h-56 w-full rounded-2xl" />;
  if (!data) return null;

  const { profile, focus, recommendations, advice, insufficientEvidence } = data;

  // Nothing supportable to say yet. Say that, rather than showing empty bars
  // that look like the student scored zero.
  if (insufficientEvidence) {
    return (
      <Card className="border-2">
        <CardContent className="p-6 text-center space-y-2">
          <Sparkles className="h-8 w-8 mx-auto text-muted-foreground" />
          <h3 className="font-bold">{sk.emptyTitle}</h3>
          <p className="text-sm text-muted-foreground">
            {sk.emptyBody}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Only skills with enough evidence behind them get a bar.
  const shown = profile.skills.filter(
    (s) => s.score !== null && s.confidence !== "none" && s.confidence !== "low",
  );

  return (
    <Card className="border-2">
      <CardContent className="p-5 space-y-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-bold">{sk.title}</h3>
          {focus && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-lavender text-lavender-foreground">
              {sk.focusOn(t.skills[focus] ?? focus)}
            </span>
          )}
        </div>

        <div className="space-y-2.5">
          {shown.map((s) => (
            <div key={s.skill} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5">
                  {t.skills[s.skill] ?? s.skill}
                  <TrendIcon trend={s.trend} />
                </span>
                <span className="tabular-nums font-medium">{s.score}%</span>
              </div>
              <Progress
                value={s.score ?? 0}
                className={`h-1.5 ${barColour(s.score ?? 0)}`}
              />
            </div>
          ))}
        </div>

        {/* Skills with some data but not enough to judge — named honestly
            rather than shown as a low bar. */}
        {profile.skills.some((s) => s.confidence === "low") && (
          <p className="text-xs text-muted-foreground">
            {profile.skills
              .filter((s) => s.confidence === "low")
              .map((s) => t.skills[s.skill] ?? s.skill)
              .join(lang === "ar" ? "، " : ", ")}
            {sk.notEnough}
          </p>
        )}

        {advice ? (
          <p className="text-sm bg-secondary/50 rounded-xl p-3 leading-relaxed">{advice}</p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full rounded-xl gap-2"
            disabled={isFetching}
            onClick={() => setWantAdvice(true)}
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {sk.advice}
          </Button>
        )}

        {recommendations.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-bold text-muted-foreground">{sk.startHere}</p>
            {recommendations.map((r, i) => (
              <button
                key={`${r.kind}-${r.lessonId}-${i}`}
                type="button"
                disabled={r.lessonId === null}
                onClick={() => r.lessonId && setLocation(`/lesson/${r.lessonId}`)}
                className={`w-full text-start p-3 rounded-xl border transition-colors flex items-start gap-3 ${
                  r.lessonId !== null
                    ? "hover:border-primary/40 cursor-pointer"
                    : "cursor-default bg-muted/30"
                }`}
              >
                <span className="text-muted-foreground shrink-0 mt-0.5">
                  <RecommendationIcon kind={r.kind} />
                </span>
                <span className="flex-1 min-w-0">
                  {(r.lessonTitleAr || r.lessonTitle) && (
                    <span className="block font-medium truncate">{pick(r.lessonTitleAr, r.lessonTitle)}</span>
                  )}
                  {/* The server words its reasons in Arabic only. */}
                  <span className="block text-xs text-muted-foreground">
                    {lang === "ar" ? r.reasonAr : sk.reasons[r.kind]}
                  </span>
                  {r.words && r.words.length > 0 && (
                    <span className="flex flex-wrap gap-1 mt-1.5" dir="ltr">
                      {r.words.slice(0, 6).map((w) => (
                        <span
                          key={w}
                          className="text-xs font-mono bg-background border rounded px-1.5 py-0.5"
                        >
                          {w}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
