import { useGetAdminLessons } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Plus } from "lucide-react";
import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";

export default function AdminLessons() {
  const { data: lessons, isLoading, error } = useGetAdminLessons();
  const { t, lang, pick } = useI18n();
  const al = t.admin.lessons;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !lessons) {
    return (
      <div className="p-8 text-center text-destructive">
        {al.loadError}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-foreground">{al.title}</h1>
          <p className="text-muted-foreground mt-1">{al.subtitle}</p>
        </div>
        <Button asChild>
          <Link href="/cms/lessons/new">
            <Plus className="me-2 h-4 w-4" />
            {al.add}
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-start w-16">{al.id}</TableHead>
                <TableHead className="text-start">{al.lessonTitle}</TableHead>
                <TableHead className="text-start">{al.type}</TableHead>
                <TableHead className="text-start">{al.duration}</TableHead>
                <TableHead className="text-start">{al.status}</TableHead>
                <TableHead className="text-center w-24">{al.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lessons.map((lesson) => (
                <TableRow key={lesson.id}>
                  <TableCell className="font-mono text-muted-foreground">{lesson.id}</TableCell>
                  <TableCell>
                    <div className="font-bold text-foreground">{pick(lesson.titleAr, lesson.title)}</div>
                    {lang === "ar" && (
                      <div className="text-xs text-muted-foreground" dir="ltr">{lesson.title}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{t.level.lessonTypes[lesson.lessonType] ?? lesson.lessonType}</Badge>
                  </TableCell>
                  <TableCell>{t.common.minutes(lesson.estimatedMinutes)}</TableCell>
                  <TableCell>
                    {lesson.isPublished ? (
                      <Badge className="bg-mint-soft text-mint-foreground hover:bg-mint-soft border-mint/40">{al.published}</Badge>
                    ) : (
                      <Badge variant="secondary">{al.draft}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/cms/lessons/${lesson.id}/edit`}>{al.edit}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {lessons.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    {al.empty}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
