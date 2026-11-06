/**
 * Reviewing and overriding a student's placement.
 *
 * Spec section 2: "The administrator must be able to review/override the
 * placement." Review comes first, and it needs the per-skill breakdown — an
 * administrator cannot judge "58%" but can judge "reading 80, grammar 35".
 *
 * Where the AI moved the level, that is shown as a change from the computed one
 * rather than presented as fact. An assignment nobody can trace is one nobody
 * can defend to the student who asks about it.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  getPlacementReview,
  overrideLevel,
  PlacementAdminError,
} from "@/lib/placement-admin-api";
import { AlertCircle, Sparkles, History, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function PlacementReview({ studentId }: { studentId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [levelId, setLevelId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const { t, lang, pick, locale } = useI18n();
  const pr = t.placementReview;

  const { data, isLoading } = useQuery({
    queryKey: ["placement-review", studentId],
    queryFn: () => getPlacementReview(studentId),
  });

  const overrideMut = useMutation({
    mutationFn: () => overrideLevel(studentId, Number(levelId), note.trim()),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["placement-review", studentId] });
      setNote("");
      setLevelId("");
      toast({ title: pr.changed, description: pr.newLevel(lang === "ar" ? r.toLevelNameAr : r.toLevelCode) });
    },
    onError: (e: Error) =>
      toast({
        title: pr.changeFailed,
        description: e instanceof PlacementAdminError ? e.message : undefined,
        variant: "destructive",
      }),
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!data) return null;

  const { placement, currentLevelId, levels, history, placementCompleted } = data;
  const currentLevel = levels.find((l) => l.id === currentLevelId);
  const adjusted =
    placement?.computedLevelCode &&
    placement.computedLevelCode !== placement.assignedLevelCode;

  return (
    <div className="space-y-4 bg-secondary/30 rounded-xl p-4">
      {!placementCompleted && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4" />
          {pr.notPlaced}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <span className="text-xs text-muted-foreground">{pr.currentLevel}</span>
          <p className="font-bold">
            {currentLevel ? `${pick(currentLevel.nameAr, currentLevel.name)} (${currentLevel.code})` : "—"}
          </p>
        </div>
        {placement && (
          <div className="text-end">
            <span className="text-xs text-muted-foreground">{pr.testScore}</span>
            <p className="font-bold tabular-nums">
              {placement.score}/{placement.total}
            </p>
          </div>
        )}
      </div>

      {/* An AI adjustment is shown as a change, not baked in silently. */}
      {adjusted && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 flex gap-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>
            {pr.byTest} <strong>{placement.computedLevelCode}</strong> — {pr.adjustedTo}{" "}
            <strong>{placement.assignedLevelCode}</strong>
            {placement.adjustmentReason ? ` (${placement.adjustmentReason})` : ""}
          </span>
        </div>
      )}

      {/* The breakdown is what makes a review possible at all. */}
      {placement?.skillScores && Object.keys(placement.skillScores).length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">{pr.bySkill}</span>
          {Object.entries(placement.skillScores).map(([skill, score]) => (
            <div key={skill} className="space-y-0.5">
              <div className="flex justify-between text-xs">
                <span>{t.skills[skill] ?? skill}</span>
                <span className="tabular-nums">{score}%</span>
              </div>
              <Progress
                value={score}
                className={`h-1.5 ${
                  score >= 80
                    ? "[&>div]:bg-mint"
                    : score <= 55
                      ? "[&>div]:bg-amber-500"
                      : ""
                }`}
              />
            </div>
          ))}
        </div>
      )}

      {placement?.analysisAr && (
        <p className="text-sm bg-background rounded-lg p-2.5 border">{placement.analysisAr}</p>
      )}

      {placement?.writingSample && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {pr.writing}
            {placement.writingScore !== null && ` (${Math.round(placement.writingScore)}%)`}
          </summary>
          <p className="mt-1 p-2 bg-background rounded-lg border" dir="ltr">
            {placement.writingSample}
          </p>
        </details>
      )}

      {/* Override. A note is required — an unexplained level change is
          indistinguishable from a mistake six months later. */}
      <div className="border-t pt-3 space-y-2">
        <span className="text-xs font-bold">{pr.override}</span>
        <div className="grid gap-2 sm:grid-cols-2">
          <select
            value={levelId}
            onChange={(e) => setLevelId(e.target.value ? Number(e.target.value) : "")}
            className="h-9 rounded-lg border bg-background px-2 text-sm"
          >
            <option value="">{pr.chooseLevel}</option>
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {pick(l.nameAr, l.name)}
              </option>
            ))}
          </select>
          <Textarea
            rows={1}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={pr.reason}
            className="text-sm rounded-lg"
          />
        </div>
        <Button
          size="sm"
          disabled={!levelId || !note.trim() || overrideMut.isPending}
          onClick={() => overrideMut.mutate()}
          className="rounded-lg gap-2"
        >
          {overrideMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {pr.save}
        </Button>
      </div>

      {history.length > 0 && (
        <details className="text-xs border-t pt-2">
          <summary className="cursor-pointer text-muted-foreground flex items-center gap-1.5">
            <History className="h-3.5 w-3.5" />
            {pr.history(history.length)}
          </summary>
          <ul className="mt-2 space-y-1">
            {history.map((h) => (
              <li key={h.id} className="flex justify-between gap-2 text-muted-foreground">
                <span>
                  {h.fromLevel ? `${h.fromLevel.code} ${lang === "ar" ? "←" : "→"} ` : ""}
                  <strong className="text-foreground">{h.toLevel?.code ?? "—"}</strong>
                  {" · "}
                  {h.reason === "placement"
                    ? pr.reasonPlacement
                    : h.reason === "evaluation"
                      ? pr.reasonEvaluation
                      : pr.reasonAdmin}
                  {h.note ? ` — ${h.note}` : ""}
                </span>
                <span className="shrink-0 tabular-nums">
                  {new Date(h.createdAt).toLocaleDateString(locale)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
