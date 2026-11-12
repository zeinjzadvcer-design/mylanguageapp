import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { cmsApi, type LessonStatus } from "@/lib/cms-api";
import { CMSLayout, StatusBadge } from "@/components/cms-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useCan } from "@/lib/permissions";
import { Plus, Search, Copy, Archive, Eye, Pencil, RotateCcw, Star } from "lucide-react";

const STATUSES: LessonStatus[] = ["draft", "in_review", "approved", "published", "archived"];

export default function CMSLessonsList() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const can = useCan();
  const canPublish = can("content.publish");
  const canEdit = can("content.edit");

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");

  const { data, isLoading } = useQuery({
    queryKey: ["cms-lessons", page, search, status],
    queryFn: () => cmsApi.lessons.list({ page, limit: 20, search: search || undefined, status: status || undefined }),
    placeholderData: (prev: any) => prev,
  });

  const duplicateMut = useMutation({
    mutationFn: (id: number) => cmsApi.lessons.duplicate(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cms-lessons"] });
      toast({ title: "Lesson duplicated", description: "Opening copy…" });
      setLocation(`/cms/lessons/${result.id}/edit`);
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const archiveMut = useMutation({
    mutationFn: (id: number) => cmsApi.lessons.archive(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-lessons"] }); toast({ title: "Lesson archived" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const restoreMut = useMutation({
    mutationFn: (id: number) => cmsApi.lessons.restore(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-lessons"] }); toast({ title: "Lesson restored" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // One free lesson for the whole site: choosing another moves it.
  const freeMut = useMutation({
    mutationFn: (lessonId: number | null) => cmsApi.lessons.setFree(lessonId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["cms-lessons"] });
      toast({
        title: result.lessonId === null ? "Free lesson cleared" : "Free lesson set",
        description:
          result.lessonId === null
            ? "Free-plan students get one lesson a month in their track again."
            : "Free-plan students can open this lesson and no other.",
      });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalPages = data ? Math.ceil(data.total / 20) : 1;

  return (
    <CMSLayout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Lessons</h1>
            <p className="text-sm text-gray-500 mt-0.5">{data?.total ?? "—"} total</p>
          </div>
          {canEdit && (
            <Button onClick={() => setLocation("/cms/lessons/new")} size="sm">
              <Plus className="h-4 w-4 mr-1.5" /> New Lesson
            </Button>
          )}
        </div>

        {/* Filters */}
        <div className="flex gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search lessons…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="pl-8 text-sm"
            />
          </div>
          <Select value={status} onValueChange={v => { setStatus(v === "all" ? "" : v); setPage(1); }}>
            <SelectTrigger className="w-36 text-sm">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s.replace("_", " ")}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : !data?.lessons.length ? (
            <div className="p-8 text-center text-gray-400 text-sm">No lessons found</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Title</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden md:table-cell">Level</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden lg:table-cell">Type</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.lessons.map(l => (
                  <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 truncate max-w-xs">{l.title}</span>
                        {l.isFreeLesson && (
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              l.status === "published" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                            }`}
                            title={l.status === "published" ? undefined : "Not published, so students get no free lesson until it is published again or another is chosen."}
                          >
                            {l.status === "published" ? "Free lesson" : "Free lesson — inactive"}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 truncate">{l.titleAr}</div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-gray-600">{l.levelCode ?? `#${l.levelId}`}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={l.status} />
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-500 capitalize">{l.lessonType}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/cms/lessons/${l.id}/preview`} title="Preview" className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                          <Eye className="h-3.5 w-3.5" />
                        </Link>
                        {canEdit && (
                          <Link href={`/cms/lessons/${l.id}/edit`} title="Edit" className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                            <Pencil className="h-3.5 w-3.5" />
                          </Link>
                        )}
                        {/* Also on an unpublished free lesson, so the choice can be cleared. */}
                        {canEdit && (l.status === "published" || l.isFreeLesson) && (
                          <button
                            title={l.isFreeLesson ? "Free lesson — click to clear" : "Make this the free lesson"}
                            aria-pressed={Boolean(l.isFreeLesson)}
                            disabled={freeMut.isPending}
                            onClick={() => freeMut.mutate(l.isFreeLesson ? null : l.id)}
                            className={`p-1.5 rounded hover:bg-gray-100 ${l.isFreeLesson ? "text-amber-500" : "text-gray-400"}`}
                          >
                            <Star className="h-3.5 w-3.5" fill={l.isFreeLesson ? "currentColor" : "none"} />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            title="Duplicate"
                            onClick={() => duplicateMut.mutate(l.id)}
                            className="p-1.5 rounded hover:bg-gray-100 text-gray-500"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canPublish && l.status !== "archived" && (
                          <button
                            title="Archive"
                            onClick={() => archiveMut.mutate(l.id)}
                            className="p-1.5 rounded hover:bg-gray-100 text-red-400"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {canPublish && l.status === "archived" && (
                          <button
                            title="Restore"
                            onClick={() => restoreMut.mutate(l.id)}
                            className="p-1.5 rounded hover:bg-gray-100 text-green-500"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              Page {page} of {totalPages} ({data?.total} lessons)
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Previous</Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</Button>
            </div>
          </div>
        )}
      </div>
    </CMSLayout>
  );
}
