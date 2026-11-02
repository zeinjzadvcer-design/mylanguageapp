import { Link } from "wouter";
import { useGetAdminStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, CreditCard, BookOpen, TrendingUp, ChevronLeft } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export default function AdminDashboard() {
  const { data: stats, isLoading, error } = useGetAdminStats();
  const { t } = useI18n();
  const ad = t.admin;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <div className="grid md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-32 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="p-8 text-center text-destructive">
        {ad.statsError}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold text-foreground">{ad.title}</h1>
        <p className="text-muted-foreground mt-2">
          {ad.subtitle}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-lavender border-primary/15 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-card flex items-center justify-center">
                <Users className="h-5 w-5 text-primary" />
              </div>
            </div>
            <div className="text-3xl font-bold text-lavender-foreground">{stats.totalStudents}</div>
            <p className="text-sm font-medium text-lavender-foreground/80">{ad.totalStudents}</p>
            {stats.newStudentsThisWeek && (
              <p className="text-xs text-lavender-foreground mt-2 font-bold">{ad.thisWeek(stats.newStudentsThisWeek)}</p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-mint-soft border-mint/30 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-card flex items-center justify-center">
                <CreditCard className="h-5 w-5 text-mint-foreground" />
              </div>
            </div>
            <div className="text-3xl font-bold text-mint-foreground">{stats.activeSubscriptions}</div>
            <p className="text-sm font-medium text-mint-foreground/80">{ad.activeSubscriptions}</p>
          </CardContent>
        </Card>

        <Card className="bg-lavender border-primary/15 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-card flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-primary" />
              </div>
            </div>
            <div className="text-3xl font-bold text-lavender-foreground">{stats.lessonsCompleted}</div>
            <p className="text-sm font-medium text-lavender-foreground/80">{ad.lessonsCompleted}</p>
          </CardContent>
        </Card>

        <Card className="bg-mint-soft border-mint/30 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-card flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-mint-foreground" />
              </div>
            </div>
            <div className="text-3xl font-bold text-mint-foreground" dir="ltr">{stats.avgScore}%</div>
            <p className="text-sm font-medium text-mint-foreground/80">{ad.avgScore}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {[
          { href: "/admin/students", title: ad.studentsTitle, body: ad.studentsBody },
          { href: "/admin/lessons", title: ad.lessonsTitle, body: ad.lessonsBody },
          { href: "/admin/ai", title: ad.aiTitle, body: ad.aiBody },
        ].map(({ href, title, body }) => (
          <Card key={href} className="hover:border-primary/50 transition-colors">
            <Link href={href} className="block h-full">
              <CardHeader>
                <CardTitle className="flex justify-between items-center text-xl">
                  <span>{title}</span>
                  <ChevronLeft className="h-5 w-5 text-muted-foreground ltr:-scale-x-100" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">{body}</p>
              </CardContent>
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
