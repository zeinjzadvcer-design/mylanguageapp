import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetAdminLessons } from "@workspace/api-client-react";
import { cmsApi } from "@/lib/cms-api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  const [levelId, setLevelId] = useState<string>("");
  const { data: levels } = useQuery({
    queryKey: ["cms-levels"],
    queryFn: () => cmsApi.levels.list(),
  });

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

  const shown = levelId ? lessons.filter((l) => String(l.levelId) === levelId) : lessons;

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

      <Select value={levelId} onValueChange={(v) => setLevelId(v === "all" ? "" : v)}>
        <SelectTrigger className="w-56">
          <SelectValue placeholder={al.allLevels} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{al.allLevels}</SelectItem>
          {(levels ?? []).map((lv: { id: number; code: string; name?: string | null; nameAr?: string | null }) => (
            <SelectItem key={lv.id} value={String(lv.id)}>
              {lv.code}
              {pick(lv.nameAr, lv.name) ? ` — ${pick(lv.nameAr, lv.name)}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
              {shown.map((lesson) => (
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
              {shown.length === 0 && (
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
