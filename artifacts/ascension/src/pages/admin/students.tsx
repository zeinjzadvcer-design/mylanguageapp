import { Fragment, useState } from "react";
import { useGetAdminStudents, useGetAdminReferrals } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlacementReview } from "@/components/placement-review";
import { ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import { useI18n } from "@/lib/i18n";

export default function AdminStudents() {
  const [page, setPage] = useState(1);
  // Which student's placement is open. One at a time: each panel fetches its
  // own review, and expanding them all would be a query per row.
  const [openStudent, setOpenStudent] = useState<number | null>(null);
  const limit = 10;
  const { t, dateLocale } = useI18n();
  const as = t.admin.students;
  const referralLabel = (source: string) =>
    source === "unknown" ? as.unknown : t.auth.referral[source] ?? source;
  
  const [referralFilter, setReferralFilter] = useState<string | null>(null);

  const { data, isLoading, error } = useGetAdminStudents({
    page, limit, ...(referralFilter ? { referralSource: referralFilter } : {}),
  });
  const { data: referrals } = useGetAdminReferrals();

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-destructive">
        {as.loadError}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-foreground">{as.title}</h1>
        <div className="text-sm font-medium text-muted-foreground bg-secondary px-3 py-1 rounded-full">
          {as.total(data.total)}
        </div>
      </div>

      {/* Acquisition channels — click one to filter the list below. */}
      {referrals && referrals.items.length > 0 && (
        <Card>
          <CardContent className="p-4 flex flex-wrap gap-2">
            <button
              onClick={() => { setReferralFilter(null); setPage(1); }}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                referralFilter === null ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
              }`}
            >
              {as.all(referrals.total)}
            </button>
            {referrals.items.map((r) => (
              <button
                key={r.source}
                onClick={() => { setReferralFilter(r.source); setPage(1); }}
                className={`rounded-full px-3 py-1 text-sm transition-colors ${
                  referralFilter === r.source ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
                }`}
              >
                {referralLabel(r.source)} ({r.count})
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{as.name}</TableHead>
                <TableHead className="text-start">{as.email}</TableHead>
                <TableHead className="text-start">{as.country}</TableHead>
                <TableHead className="text-start">{as.referral}</TableHead>
                <TableHead className="text-start">{as.joined}</TableHead>
                <TableHead className="text-start">{as.level}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.students.map((student) => (
                <Fragment key={student.id}>
                  <TableRow>
                    <TableCell className="font-medium">{student.name}</TableCell>
                    <TableCell className="text-muted-foreground font-mono" dir="ltr">{student.email}</TableCell>
                    <TableCell>{student.country || "-"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {student.referralSource
                        ? referralLabel(student.referralSource)
                        : "-"}
                    </TableCell>
                    <TableCell>
                      {format(new Date(student.createdAt), "d MMM yyyy", { locale: dateLocale })}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        onClick={() =>
                          setOpenStudent((id) => (id === student.id ? null : student.id))
                        }
                      >
                        {openStudent === student.id ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        {as.review}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {openStudent === student.id && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-3">
                        <PlacementReview studentId={student.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
              {data.students.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    {as.empty}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {data.total > limit && (
        <div className="flex justify-between items-center bg-card p-4 rounded-xl border border-border">
          <Button 
            variant="outline" 
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            {t.quiz.prev}
          </Button>
          <span className="text-sm text-muted-foreground font-medium">
            {as.page(page, Math.ceil(data.total / limit))}
          </span>
          <Button 
            variant="outline" 
            onClick={() => setPage(p => p + 1)}
            disabled={page >= Math.ceil(data.total / limit)}
          >
            {t.quiz.next}
          </Button>
        </div>
      )}
    </div>
  );
}
