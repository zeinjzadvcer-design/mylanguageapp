/**
 * CMS Lesson Preview — runs the lesson in the real student player, clearly
 * labelled "Preview Mode". Never records progress.
 *
 * This used to be a separate rendering of the raw rows, and it drifted from
 * what students saw: attached images were never shown, audio was listed as a
 * storage key instead of played, and multi-question blocks showed only their
 * first question. Mounting the student player itself means an author sees
 * exactly what a student would, and the two cannot drift apart again.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { LessonDetail } from "@workspace/api-client-react";
import { cmsApi } from "@/lib/cms-api";
import { CMSLayout, StatusBadge } from "@/components/cms-layout";
import { LessonPlayer } from "@/pages/lesson";
import { ArrowLeft, Eye } from "lucide-react";

interface Props { lessonId: number }

export default function LessonPreviewPage({ lessonId }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["cms-preview", lessonId],
    queryFn: () => cmsApi.lessons.preview(lessonId),
  });

  const exitHref = `/cms/lessons/${lessonId}/edit`;

  // The player takes the student lesson shape. Progress fields have no
  // meaning here, so they describe a student opening the lesson fresh.
  const lesson: LessonDetail | null = data
    ? {
        id: data.lesson.id,
        levelId: data.lesson.levelId,
        levelCode: data.lesson.levelCode ?? "",
        title: data.lesson.title,
        titleAr: data.lesson.titleAr,
        description: data.lesson.description ?? null,
        descriptionAr: (data.lesson as { descriptionAr?: string | null }).descriptionAr ?? null,
        order: data.lesson.order,
        lessonType: data.lesson.lessonType as LessonDetail["lessonType"],
        estimatedMinutes: data.lesson.estimatedMinutes,
        state: "AVAILABLE",
        isUnlocked: true,
        isCompleted: false,
        bestScore: null,
        xpReward: data.lesson.xpReward,
        passingScore: data.lesson.passingScore,
        contentBlocks: data.studentBlocks,
        completedBlockIds: [],
        objectives: data.lesson.objectives ?? null,
        objectivesAr: data.lesson.objectivesAr ?? null,
      }
    : null;

  return (
    <CMSLayout>
      <div className="space-y-4">
        {/* Preview banner */}
        <div className="flex items-center justify-between rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
          <div className="flex items-center gap-2 text-amber-800 flex-wrap">
            <Eye className="h-4 w-4" />
            <span className="text-sm font-semibold">Preview Mode</span>
            {data && <StatusBadge status={data.lesson.status} />}
            <span className="text-sm text-amber-600">
              — exactly what a student sees. Nothing is recorded, uploaded or sent to AI.
            </span>
          </div>
          <Link href={exitHref} className="text-xs text-amber-700 hover:text-amber-900 flex items-center gap-1 shrink-0">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to editor
          </Link>
        </div>

        {isLoading && <div className="py-12 text-center text-gray-400 text-sm">Loading preview…</div>}
        {error && <div className="py-12 text-center text-red-400 text-sm">Failed to load preview</div>}

        {data && data.contentBlocks.some((b) => !b.isActive) && (
          <p className="text-xs text-gray-500">
            Inactive blocks are hidden here, as they are from students.
          </p>
        )}

        {lesson && (
          <div className="max-w-3xl mx-auto">
            <LessonPlayer
              // Remount on refetch so the walk-through restarts from the top
              // with the content as it is now, not half-way through the old one.
              key={`${lessonId}:${data!.lesson.contentVersion}:${data!.lesson.updatedAt ?? ""}`}
              lesson={lesson}
              preview={{ answerKeys: data!.answerKeys, exitHref }}
            />
          </div>
        )}
      </div>
    </CMSLayout>
  );
}
