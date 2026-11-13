/**
 * Capacity: how many voice calls and how many students in lessons the site
 * takes at once, set by an administrator, with what is happening now and a
 * suggested limit for each measured from the server's own use.
 *
 * Both limits apply within seconds and never cut anyone off: a call already
 * running carries on, and so does a student already in a lesson. See
 * services/lesson-load.ts and services/capacity-advice.ts on the server.
 */

import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertCircle, ArrowLeft, BookOpen, Gauge, Lightbulb, Mic } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import { NullableNumberField } from "@/components/nullable-number-field";
import {
  AiAdminError,
  getCapacity,
  updateLessonCapacity,
  updatePracticeSettings,
  type CapacityAdvice,
  type Suggestion,
} from "@/lib/ai-admin-api";

/** How often the live numbers refresh while the page is open. */
const REFRESH_MS = 10_000;
const CAPACITY_KEY = ["admin", "capacity"] as const;

type Limit = "lessons" | "calls";

export default function AdminCapacity() {
  const { t } = useI18n();
  const c = t.capacity;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // refetchInterval pauses while the tab is hidden.
  const { data, isError } = useQuery({
    queryKey: CAPACITY_KEY,
    queryFn: getCapacity,
    refetchInterval: REFRESH_MS,
  });

  const save = useMutation({
    mutationFn: ({ limit, value }: { limit: Limit; value: number | null }) =>
      limit === "lessons" ? updateLessonCapacity(value) : updatePracticeSettings(value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CAPACITY_KEY });
      toast({ title: c.saved });
    },
    onError: (e) =>
      toast({
        variant: "destructive",
        title: c.saveFailed,
        description: e instanceof AiAdminError ? e.message : undefined,
      }),
  });
  const busy = save.isPending;
  const wholeNumber = (n: number) => Number.isInteger(n) && n >= 1;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-start gap-3">
        <Link href="/admin" className="mt-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5 rtl:-scale-x-100" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{c.title}</h1>
          <p className="text-sm text-muted-foreground">{c.subtitle}</p>
        </div>
      </div>

      {isError && !data && (
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{c.loadFailed}</span>
        </div>
      )}

      {!data && !isError && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      )}

      {data && (
        <>
          <LimitCard
            icon={<BookOpen className="h-5 w-5 text-primary" />}
            title={c.lessonsTitle}
            body={c.lessonsBody}
            nowLabel={c.lessonsNow}
            now={data.lessons.activeLearners}
            max={data.lessons.maxActiveLearners}
            suggestion={data.advice.lessons}
            advice={data.advice}
            noSuggestion={c.noSuggestion}
            field={
              <NullableNumberField
                id="max-active-learners"
                label={c.lessonsLimit}
                value={data.lessons.maxActiveLearners}
                min={1}
                step={1}
                isValid={wholeNumber}
                invalidHint={c.wholeNumber}
                disabled={busy}
                saveLabel={c.save}
                onSave={(value) => save.mutate({ limit: "lessons", value })}
              />
            }
            onUse={(value) => save.mutate({ limit: "lessons", value })}
            busy={busy}
          />

          {/* Server load: the automatic trigger, whatever the limit above */}
          <Card className="border-2">
            <CardContent className="p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Gauge className="h-5 w-5 text-primary" />
                  <h2 className="font-bold">{c.serverTitle}</h2>
                </div>
                <Badge variant={data.lessons.overloaded ? "destructive" : "secondary"}>
                  {data.lessons.overloaded ? c.statusOverloaded : c.statusOk}
                </Badge>
              </div>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>{c.lag(data.lessons.loopLagMs, data.lessons.lagLimitMs)}</li>
                <li>{c.dbWaiting(data.lessons.dbWaiting, data.lessons.dbWaitingLimit)}</li>
              </ul>
              {data.advice.measuredMinutes > 0 && (
                <div className="pt-2 border-t space-y-1">
                  <p className="text-xs font-medium">{c.usageTitle}</p>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    <li>{c.cpuUse(Math.round(data.advice.cpuShare * 100))}</li>
                    <li>{c.dbUse(Math.round(data.advice.dbShare * 100))}</li>
                    {data.advice.callInLearners !== null && <li>{c.callCost(data.advice.callInLearners)}</li>}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <LimitCard
            icon={<Mic className="h-5 w-5 text-primary" />}
            title={c.callsTitle}
            body={c.callsBody}
            nowLabel={c.callsNow}
            now={data.calls.liveCalls}
            max={data.calls.maxConcurrentCalls}
            suggestion={data.advice.calls}
            advice={data.advice}
            noSuggestion={data.advice.lessons.basis === "insufficient" ? c.noSuggestion : c.noCallSuggestion}
            field={
              <NullableNumberField
                id="max-concurrent-calls"
                label={c.callsLimit}
                value={data.calls.maxConcurrentCalls}
                min={1}
                step={1}
                isValid={wholeNumber}
                invalidHint={c.wholeNumber}
                disabled={busy}
                saveLabel={c.save}
                onSave={(value) => save.mutate({ limit: "calls", value })}
              />
            }
            onUse={(value) => save.mutate({ limit: "calls", value })}
            busy={busy}
          />

          <p className="text-xs text-muted-foreground leading-relaxed">{c.adviceNote}</p>
        </>
      )}
    </div>
  );
}

function LimitCard({
  icon,
  title,
  body,
  nowLabel,
  now,
  max,
  field,
  suggestion,
  advice,
  noSuggestion,
  onUse,
  busy,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  nowLabel: string;
  now: number;
  max: number | null;
  field: ReactNode;
  suggestion: Suggestion;
  advice: CapacityAdvice;
  noSuggestion: string;
  onUse: (value: number) => void;
  busy: boolean;
}) {
  return (
    <Card className="border-2">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="font-bold">{title}</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field}
          <div>
            <Label className="text-xs text-muted-foreground">{nowLabel}</Label>
            <p className="text-2xl font-bold tabular-nums" dir="ltr">
              {now}
              {max !== null && <span className="text-base font-medium text-muted-foreground"> / {max}</span>}
            </p>
          </div>
        </div>
        <SuggestionLine
          suggestion={suggestion}
          minutes={advice.measuredMinutes}
          current={max}
          noSuggestion={noSuggestion}
          onUse={onUse}
          busy={busy}
        />
      </CardContent>
    </Card>
  );
}

function SuggestionLine({
  suggestion,
  minutes,
  current,
  noSuggestion,
  onUse,
  busy,
}: {
  suggestion: Suggestion;
  minutes: number;
  current: number | null;
  noSuggestion: string;
  onUse: (value: number) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const c = t.capacity;
  if (suggestion.value === null || suggestion.value < 1) {
    return <p className="text-xs text-muted-foreground">{noSuggestion}</p>;
  }
  const value = suggestion.value;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-secondary/50 p-3">
      <Lightbulb className="h-4 w-4 text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{c.suggested(value)}</p>
        <p className="text-xs text-muted-foreground">
          {suggestion.basis === "measured" ? c.basisMeasured(minutes) : c.basisEstimated(minutes)}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="rounded-xl"
        disabled={busy || current === value}
        onClick={() => onUse(value)}
      >
        {c.useSuggested}
      </Button>
    </div>
  );
}
