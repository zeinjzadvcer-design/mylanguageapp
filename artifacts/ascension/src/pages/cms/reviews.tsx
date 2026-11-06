import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { cmsApi } from "@/lib/cms-api";
import { CMSLayout, StatusBadge } from "@/components/cms-layout";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";
import { CheckCircle, XCircle, Eye, Clock } from "lucide-react";

export default function ReviewsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: user } = useGetMe();
  const isReviewer = user?.role === "admin" || (user?.role as string) === "content_reviewer";

  const { data: queue, isLoading } = useQuery({
    queryKey: ["cms-review-queue"],
    queryFn: () => cmsApi.reviews.queue(),
    refetchInterval: 30_000,
  });

  const approveMut = useMutation({
    mutationFn: (id: number) => cmsApi.lessons.approve(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-review-queue"] }); toast({ title: "Lesson approved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, notes }: { id: number; notes: string }) => cmsApi.lessons.reject(id, notes),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-review-queue"] }); toast({ title: "Lesson rejected — returned to draft" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <CMSLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Review Queue</h1>
          <p className="text-sm text-gray-500 mt-0.5">Lessons awaiting review</p>
        </div>

        {isLoading && <div className="text-center py-8 text-gray-400 text-sm">Loading…</div>}

        {!isLoading && (!queue || queue.length === 0) && (
          <div className="rounded-lg border-2 border-dashed border-gray-200 p-12 text-center">
            <CheckCircle className="h-10 w-10 text-green-400 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">Review queue is empty</p>
            <p className="text-gray-400 text-sm mt-1">All submitted lessons have been reviewed</p>
          </div>
        )}

        <div className="space-y-3">
          {(queue ?? []).map((lesson: any) => (
            <div key={lesson.id} className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900 truncate">{lesson.title}</span>
                    <StatusBadge status={lesson.status} />
                  </div>
                  <div className="text-sm text-gray-500 mt-0.5">{lesson.titleAr}</div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                    <span>Level: {lesson.levelCode}</span>
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Submitted {new Date(lesson.updatedAt).toLocaleDateString()}</span>
                  </div>

                  {lesson.reviews?.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {lesson.reviews.map((r: any, i: number) => (
                        <div key={i} className="text-xs text-gray-500 bg-white rounded px-2 py-1 border border-gray-200">
                          <span className={`font-medium ${r.decision === "approved" ? "text-green-600" : "text-red-500"}`}>
                            {r.decision}
                          </span>
                          {r.notes && <span className="ml-2">{r.notes}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Link href={`/cms/lessons/${lesson.id}/preview`} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-white transition-colors">
                    <Eye className="h-3.5 w-3.5" /> Preview
                  </Link>

                  {isReviewer && (
                    <>
                      <Button size="sm" className="bg-green-600 hover:bg-green-700 text-xs h-7"
                        onClick={() => approveMut.mutate(lesson.id)}>
                        <CheckCircle className="h-3.5 w-3.5 mr-1" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs h-7 border-red-200 text-red-600 hover:bg-red-50"
                        onClick={() => {
                          const notes = window.prompt("Rejection notes (optional):") ?? "";
                          rejectMut.mutate({ id: lesson.id, notes });
                        }}>
                        <XCircle className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </CMSLayout>
  );
}
