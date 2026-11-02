import { Link } from "wouter";
import { useGetLevels, useGetDashboard } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Lock, Unlock, CheckCircle2, ChevronLeft, Target } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export default function Learn() {
  const { data: levelsResponse, isLoading, error } = useGetLevels();
  const levels = levelsResponse?.levels;
  const { data: dashboard } = useGetDashboard();
  const { t, lang, pick } = useI18n();

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-48 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (error || !levels) {
    return (
      <div className="p-8 text-center text-destructive">
        {t.learn.loadError}
      </div>
    );
  }

  const currentLevel = dashboard?.currentLevel ?? null;
  const notPlaced = !currentLevel;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold text-foreground">{t.learn.title}</h1>
        <p className="text-muted-foreground mt-2">
          {t.learn.subtitle}
        </p>
      </div>

      {/* Placement CTA if not placed */}
      {notPlaced && (
        <div className="flex flex-col sm:flex-row items-center gap-4 p-5 rounded-2xl border-2 border-primary/30 bg-primary/5">
          <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <Target className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 text-center sm:text-start">
            <p className="font-bold text-foreground">{t.learn.notPlaced}</p>
            <p className="text-sm text-muted-foreground">{t.learn.notPlacedBody}</p>
          </div>
          <Link href="/placement">
            <Button className="rounded-xl shrink-0">{t.dashboard.startTest}</Button>
          </Link>
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {levels.map((level) => {
          const isCurrentLevel = currentLevel?.id === level.id;
          const progress = level.totalLessons > 0
            ? ((level.completedLessons || 0) / level.totalLessons) * 100
            : 0;

          return (
            <Link key={level.id} href={level.isUnlocked ? `/learn/${level.id}` : "#"}>
              <Card className={`relative overflow-hidden transition-all duration-300 h-full flex flex-col ${
                level.isUnlocked
                  ? "cursor-pointer hover:shadow-lg hover:border-primary/50"
                  : "opacity-75 bg-secondary/30"
              } ${isCurrentLevel ? "border-primary shadow-md ring-1 ring-primary/20" : ""}`}>

                {/* Status bar */}
                <div className={`h-1.5 w-full ${
                  level.isCompleted ? "bg-mint" :
                  isCurrentLevel ? "bg-primary" :
                  level.isUnlocked ? "bg-primary/40" : "bg-muted"
                }`} />

                <CardContent className="p-6 flex-1 flex flex-col">
                  <div className="flex justify-between items-start mb-4">
                    <div className="text-2xl font-black font-serif tracking-tighter" dir="ltr">
                      {level.code}
                    </div>
                    {level.isCompleted ? (
                      <CheckCircle2 className="h-6 w-6 text-mint-foreground" />
                    ) : level.isUnlocked ? (
                      <Unlock className="h-5 w-5 text-primary" />
                    ) : (
                      <Lock className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>

                  <h3 className="text-xl font-bold text-foreground mb-1">
                    {pick(level.nameAr, level.name)}
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6 line-clamp-2" dir="ltr">
                    {lang === "ar" ? level.name : ""}
                  </p>

                  <div className="mt-auto space-y-3">
                    <div className="flex justify-between text-xs font-medium text-muted-foreground">
                      <span>{t.learn.lessonsOf(level.completedLessons || 0, level.totalLessons)}</span>
                      {level.isUnlocked && <span>{Math.round(progress)}%</span>}
                    </div>

                    {level.isUnlocked && (
                      <Progress
                        value={progress}
                        className={`h-1.5 ${level.isCompleted ? "[&>div]:bg-mint" : ""}`}
                      />
                    )}
                  </div>

                  {level.isUnlocked && (
                    <div className="mt-6 flex items-center justify-between text-sm font-bold text-primary group-hover:text-primary/80">
                      <span>{level.isCompleted ? t.common.review : isCurrentLevel ? t.learn.continue : t.common.start}</span>
                      <ChevronLeft className="h-4 w-4 ltr:-scale-x-100" />
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
