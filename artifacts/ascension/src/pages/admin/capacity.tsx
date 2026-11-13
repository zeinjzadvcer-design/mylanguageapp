/**
 * Capacity: how many voice calls and how many students in lessons the site
 * takes at once, set by an administrator, with what is happening now.
 *
 * Both limits apply within seconds and never cut anyone off: a call already
 * running carries on, and so does a student already in a lesson. See
 * services/lesson-load.ts on the server for how lessons decide.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertCircle, ArrowLeft, BookOpen, Gauge, Mic } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  type Capacity,
} from "@/lib/ai-admin-api";

/** How often the live numbers refresh while the page is open. */
const REFRESH_MS = 10_000;

export default function AdminCapacity() {
  const { t } = useI18n();
  const c = t.capacity;
  const { toast } = useToast();
  const [data, setData] = useState<Capacity | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getCapacity());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      toast({ title: c.saved });
    } catch (e) {
      toast({
        variant: "destructive",
        title: c.saveFailed,
        description: e instanceof AiAdminError ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

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

      {loadFailed && !data && (
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span>{c.loadFailed}</span>
        </div>
      )}

      {!data && !loadFailed && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      )}

      {data && (
        <>
          {/* Lessons */}
          <Card className="border-2">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                <h2 className="font-bold">{c.lessonsTitle}</h2>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{c.lessonsBody}</p>
              <div className="grid gap-4 sm:grid-cols-2">
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
                  onSave={(v) => save(() => updateLessonCapacity(v))}
                />
                <div>
                  <Label className="text-xs text-muted-foreground">{c.lessonsNow}</Label>
                  <p className="text-2xl font-bold tabular-nums" dir="ltr">
                    {data.lessons.activeLearners}
                    {data.lessons.maxActiveLearners !== null && (
                      <span className="text-base font-medium text-muted-foreground"> / {data.lessons.maxActiveLearners}</span>
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

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
            </CardContent>
          </Card>

          {/* Voice calls */}
          <Card className="border-2">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Mic className="h-5 w-5 text-primary" />
                <h2 className="font-bold">{c.callsTitle}</h2>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{c.callsBody}</p>
              <div className="grid gap-4 sm:grid-cols-2">
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
                  onSave={(v) => save(() => updatePracticeSettings(v))}
                />
                <div>
                  <Label className="text-xs text-muted-foreground">{c.callsNow}</Label>
                  <p className="text-2xl font-bold tabular-nums" dir="ltr">
                    {data.calls.liveCalls}
                    {data.calls.maxConcurrentCalls !== null && (
                      <span className="text-base font-medium text-muted-foreground"> / {data.calls.maxConcurrentCalls}</span>
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
