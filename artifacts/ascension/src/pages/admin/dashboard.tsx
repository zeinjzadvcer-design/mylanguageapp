import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetAdminStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, CreditCard, BookOpen, TrendingUp, ChevronLeft, ShieldAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useCan } from "@/lib/permissions";

/**
 * How many practice-call reports are waiting. Only the count is needed here;
 * the queue itself lives in the CMS. A failure leaves the card without a
 * number rather than breaking the dashboard.
 */
async function fetchOpenReportCount(): Promise<number | null> {
  const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
  const r = await fetch(`${base}/cms/practice/reports?status=open&limit=1`, { credentials: "include" });
  if (!r.ok) return null;
  const body = (await r.json()) as { counts?: { open?: number } };
  return body.counts?.open ?? null;
}

export default function AdminDashboard() {
  const { data: stats, isLoading, error } = useGetAdminStats();
  const can = useCan();
  const { data: openReports } = useQuery({
    queryKey: ["admin-open-practice-reports"],
    queryFn: fetchOpenReportCount,
    enabled: can("practice_reports.manage"),
  });
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
        {([
          { href: "/admin/students", title: ad.studentsTitle, body: ad.studentsBody, permission: "students.manage" },
          { href: "/admin/lessons", title: ad.lessonsTitle, body: ad.lessonsBody, permission: "content.publish" },
          { href: "/admin/payments", title: ad.paymentsTitle, body: ad.paymentsBody, permission: "payments.review" },
          { href: "/admin/ai", title: ad.aiTitle, body: ad.aiBody, permission: "settings.manage" },
          { href: "/admin/staff", title: ad.staffTitle, body: ad.staffBody, permission: "staff.manage" },
        ] as const).filter(({ permission }) => can(permission)).map(({ href, title, body }) => (
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

        {/* Reports students file from a peer practice call. The queue lives in
            the CMS (Practice Reports); without this card an admin had no way
            to find it from here, or to know anything was waiting. */}
        {can("practice_reports.manage") && (
          <Card className={`hover:border-primary/50 transition-colors ${openReports ? "border-rose-200" : ""}`}>
            <Link href="/cms/practice-reports" className="block h-full">
              <CardHeader>
                <CardTitle className="flex justify-between items-center text-xl">
                  <span className="flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-rose-500" />
                    {ad.reportsTitle}
                    {!!openReports && (
                      <span className="rounded-full bg-rose-100 text-rose-700 text-sm px-2.5 py-0.5 tabular-nums">
                        {openReports}
                      </span>
                    )}
                  </span>
                  <ChevronLeft className="h-5 w-5 text-muted-foreground ltr:-scale-x-100" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">{ad.reportsBody}</p>
              </CardContent>
            </Link>
          </Card>
        )}
      </div>
    </div>
  );
}
