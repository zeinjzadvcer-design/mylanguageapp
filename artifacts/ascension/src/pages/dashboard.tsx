import { Link } from "wouter";
import { SkillProfileCard } from "@/components/skill-profile-card";
import { useQueryClient } from "@tanstack/react-query";
import { useGetDashboard, getGetDashboardQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Flame, Star, Play, CheckCircle2, BookOpen, Target } from "lucide-react";
import { format } from "date-fns";
import { useI18n } from "@/lib/i18n";

export default function Dashboard() {
  const { data: dashboard, isLoading, error } = useGetDashboard();
  const { t, lang, pick, dateLocale } = useI18n();
  const d = t.dashboard;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
        <Skeleton className="h-12 w-64 rounded-xl" />
        <div className="grid md:grid-cols-3 gap-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-2xl" />)}
        </div>
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-destructive">{t.common.loadError}</h2>
        <Button className="mt-4" onClick={() => window.location.reload()}>{t.common.retry}</Button>
      </div>
    );
  }

  const { student, currentCurriculum, currentLevel, nextLesson, weeklyProgress, recentActivity, lessonStateCounts } = dashboard;
  const notPlaced = !currentLevel;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">

      {/* Welcome Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            {d.hello(student.name.split(' ')[0])}
          </h1>
          {currentLevel ? (
            <p className="text-muted-foreground mt-2 text-lg">
              {d.currentLevel}{" "}
              <span className="font-bold text-primary">{pick(currentLevel.nameAr, currentLevel.name)} ({currentLevel.code})</span>
            </p>
          ) : (
            <p className="text-muted-foreground mt-2 text-lg">
              {d.notPlaced}
            </p>
          )}
          {currentCurriculum && (
            <p className="text-sm text-muted-foreground mt-1">
              {d.curriculum} <span className="font-medium">{currentCurriculum.nameInLearnerLanguage || currentCurriculum.name}</span>
            </p>
          )}
        </div>

        {student.subscriptionPlan === "free" && (
          <Link href="/subscription">
            <Button variant="outline" className="text-mint-foreground border-mint/50 bg-mint-soft/60 hover:bg-mint-soft">
              {d.upgrade}
            </Button>
          </Link>
        )}
      </div>

      {/* Placement CTA */}
      {notPlaced && (
        <Card className="border-2 border-primary/40 bg-primary/5 shadow-md">
          <CardContent className="p-6 flex flex-col md:flex-row items-center gap-6">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Target className="h-8 w-8 text-primary" />
            </div>
            <div className="flex-1 text-center md:text-start">
              <h3 className="text-xl font-bold text-foreground mb-1">{d.placementTitle}</h3>
              <p className="text-muted-foreground text-sm">
                {d.placementBody}
              </p>
            </div>
            <Link href="/placement">
              <Button size="lg" className="rounded-xl h-12 px-8 shrink-0">
                {d.startTest}
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-lavender border-primary/15 shadow-sm">
          <CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2">
            <div className="h-12 w-12 rounded-full bg-card flex items-center justify-center">
              <Flame className="h-6 w-6 text-primary" />
            </div>
            <div className="text-3xl font-bold text-lavender-foreground">{weeklyProgress.streakDays}</div>
            <p className="text-sm font-medium text-lavender-foreground/80">{d.streak}</p>
          </CardContent>
        </Card>

        <Card className="bg-mint-soft border-mint/30 shadow-sm">
          <CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2">
            <div className="h-12 w-12 rounded-full bg-card flex items-center justify-center">
              <Star className="h-6 w-6 text-mint-foreground" />
            </div>
            <div className="text-3xl font-bold text-mint-foreground">{student.totalXp || 0}</div>
            <p className="text-sm font-medium text-mint-foreground/80">{d.totalXp}</p>
          </CardContent>
        </Card>

        <Card className="bg-mint-soft border-mint/30 shadow-sm">
          <CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2">
            <div className="h-12 w-12 rounded-full bg-card flex items-center justify-center">
              <BookOpen className="h-6 w-6 text-mint-foreground" />
            </div>
            <div className="text-3xl font-bold text-mint-foreground">{weeklyProgress.lessonsThisWeek}</div>
            <p className="text-sm font-medium text-mint-foreground/80">{d.lessonsThisWeek}</p>
          </CardContent>
        </Card>

        <Card className="bg-lavender border-primary/15 shadow-sm">
          <CardContent className="p-6 flex flex-col items-center justify-center text-center space-y-2">
            <div className="h-12 w-12 rounded-full bg-card flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-primary" />
            </div>
            <div className="text-3xl font-bold text-lavender-foreground">{student.totalLessonsCompleted}</div>
            <p className="text-sm font-medium text-lavender-foreground/80">{d.totalLessons}</p>
          </CardContent>
        </Card>
      </div>

      {/* Lesson state counts */}
      {lessonStateCounts && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: d.available, value: lessonStateCounts.available, color: "text-mint-foreground bg-mint-soft/60 border-mint/30" },
            { label: d.inProgress, value: lessonStateCounts.inProgress, color: "text-lavender-foreground bg-lavender/70 border-primary/15" },
            { label: d.completed, value: lessonStateCounts.completed, color: "text-primary bg-card border-primary/20" },
            { label: d.locked, value: lessonStateCounts.locked, color: "text-muted-foreground bg-muted/60 border-border" },
          ].map(({ label, value, color }) => (
            <div key={label} className={`rounded-xl border p-4 text-center ${color}`}>
              <div className="text-2xl font-bold">{value}</div>
              <div className="text-xs font-medium mt-1">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-8">
        {/* Next Lesson (Main Action) */}
        <div className="md:col-span-2 space-y-6">
          <h2 className="text-xl font-bold text-foreground">{d.nextLesson}</h2>

          {notPlaced ? (
            <Card className="border-dashed bg-secondary/50">
              <CardContent className="p-12 text-center">
                <div className="h-16 w-16 mx-auto bg-primary/10 rounded-full flex items-center justify-center mb-4">
                  <Target className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-xl font-bold mb-2">{d.placementFirst}</h3>
                <p className="text-muted-foreground mb-6 text-sm">{d.placementFirstBody}</p>
                <Link href="/placement">
                  <Button size="lg" className="rounded-xl">{d.startTest}</Button>
                </Link>
              </CardContent>
            </Card>
          ) : nextLesson ? (
            <Card className="overflow-hidden border-2 hover:border-primary transition-colors duration-300">
              <div className="h-2 w-full bg-gradient-to-r from-primary to-mint"></div>
              <CardContent className="p-6 md:p-8 flex flex-col md:flex-row items-center gap-6">
                <div className="flex-1 space-y-4 text-center md:text-start">
                  <div className="inline-block px-3 py-1 rounded-full bg-secondary text-secondary-foreground text-sm font-bold">
                    {t.common.lessonN(nextLesson.order)}
                  </div>
                  <h3 className="text-2xl font-bold text-foreground">
                    {pick(nextLesson.titleAr, nextLesson.title)}
                  </h3>
                  {/* In Arabic, the English title underneath is part of the lesson. */}
                  {lang === "ar" && nextLesson.titleAr && (
                    <p className="text-muted-foreground text-lg" dir="ltr">
                      {nextLesson.title}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground pt-2">
                    {d.lessonMeta(nextLesson.estimatedMinutes, nextLesson.xpReward)}
                  </p>
                </div>

                <Link href={`/lesson/${nextLesson.id}`}>
                  <Button size="lg" className="h-16 px-8 rounded-2xl text-lg w-full md:w-auto shadow-md hover:shadow-lg">
                    <Play className="me-2 h-6 w-6 fill-current" />
                    {d.startLesson}
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-dashed bg-secondary/50">
              <CardContent className="p-12 text-center">
                <div className="h-16 w-16 mx-auto bg-primary/10 rounded-full flex items-center justify-center mb-4">
                  <Star className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-2xl font-bold mb-2">{d.allDone}</h3>
                <p className="text-muted-foreground mb-6">{d.allDoneBody}</p>
                <Link href="/learn">
                  <Button size="lg" className="rounded-xl">{d.browseCurriculum}</Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Level Progress */}
          {currentLevel && (
            <div className="space-y-3 pt-4">
              <div className="flex justify-between text-sm font-medium">
                <span>{d.levelProgress(currentLevel.code)}</span>
                <span>{dashboard.levelProgressPercent}%</span>
              </div>
              <Progress value={dashboard.levelProgressPercent} className="h-3 rounded-full" />
              <p className="text-xs text-muted-foreground text-end">
                {d.completedOf(dashboard.totalLessonsCompleted, dashboard.totalLessonsInLevel)}
              </p>
            </div>
          )}
        </div>

        {/* Skills — strengths, weaknesses, and what to do about them */}
        <div className="space-y-6">
          <h2 className="text-xl font-bold text-foreground">{d.yourProgress}</h2>
          <SkillProfileCard />
        </div>

        {/* Recent Activity */}
        <div className="space-y-6">
          <h2 className="text-xl font-bold text-foreground flex items-center justify-between">
            <span>{d.recentActivity}</span>
          </h2>

          <Card>
            <CardContent className="p-0">
              {recentActivity && recentActivity.length > 0 ? (
                <div className="divide-y divide-border">
                  {recentActivity.map((activity, idx) => (
                    <div key={idx} className="p-4 flex items-start gap-4 hover:bg-secondary/30 transition-colors">
                      <div className="mt-1">
                        {activity.passed ? (
                          <CheckCircle2 className="h-5 w-5 text-mint-foreground" />
                        ) : (
                          <div className="h-5 w-5 rounded-full border-2 border-muted-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-foreground truncate">
                          {pick(activity.lessonTitleAr, activity.lessonTitle)}
                        </p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <span>{format(new Date(activity.completedAt), 'd MMMM', { locale: dateLocale })}</span>
                          <span>•</span>
                          <span dir="ltr">{activity.score}%</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  {d.noActivity}<br/> {d.startFirst}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
