import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPlacementTest,
  useSubmitPlacementTest,
  getGetDashboardQueryKey,
  getGetLevelsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { BlockMedia } from "@/components/block-media";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import type { PlacementTestResult } from "@workspace/api-client-react";

export default function Placement() {
  const { data: test, isLoading, error } = useGetPlacementTest();
  const submitTest = useSubmitPlacementTest();
  const [, setLocation] = useLocation();
  const { t, lang, pick } = useI18n();
  const pl = t.placement;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [started, setStarted] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  /** Written questions submit responseText, not a selectedOptionId. */
  const [writtenAnswers, setWrittenAnswers] = useState<Record<number, string>>({});
  const [result, setResult] = useState<PlacementTestResult | null>(null);

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !test) {
    return (
      <div className="p-8 text-center max-w-md mx-auto mt-20">
        <h2 className="text-xl font-bold text-destructive mb-4">{pl.loadError}</h2>
        <Button onClick={() => window.location.reload()}>{t.common.retry}</Button>
      </div>
    );
  }

  if (result) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-background">
        <Card className="max-w-lg w-full text-center border-primary shadow-2xl animate-in zoom-in-95 duration-500">
          <div className="h-3 w-full bg-gradient-to-r from-primary to-mint" />
          <CardContent className="pt-10 pb-8 px-6 space-y-6">
            <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-2">
              <CheckCircle2 className="h-10 w-10 text-primary" />
            </div>
            <h2 className="text-3xl font-bold text-foreground">{pl.resultTitle}</h2>

            <div className="p-6 bg-secondary rounded-2xl space-y-2">
              <p className="text-muted-foreground mb-2">{pl.yourLevel}</p>
              <div className="text-4xl font-bold text-primary" dir="ltr">{result.assignedLevelCode}</div>
              <div className="text-xl font-bold text-foreground">{pick(result.assignedLevelNameAr, result.assignedLevelName)}</div>
              {lang === "ar" && (
                <div className="text-sm text-muted-foreground" dir="ltr">{result.assignedLevelName}</div>
              )}
            </div>

            <p className="text-muted-foreground text-sm">
              {pl.basedOn(result.score, result.total, result.percentage)}
            </p>

            {pick(result.messageAr, result.message) && (
              <p className="text-sm font-medium text-foreground bg-secondary/60 p-3 rounded-lg">
                {pick(result.messageAr, result.message)}
              </p>
            )}

            <Button
              size="lg"
              className="w-full h-14 text-lg rounded-xl mt-4"
              onClick={() => setLocation("/dashboard")}
            >
              {pl.goHome}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Zero questions edge case
  if (test.questions.length === 0) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-background">
        <Card className="max-w-xl w-full border-border shadow-lg">
          <CardContent className="p-8 text-center space-y-6">
            <h1 className="text-2xl font-bold text-foreground">{pl.unavailableTitle}</h1>
            <p className="text-muted-foreground">{pl.unavailableBody}</p>
            <Button onClick={() => setLocation("/dashboard")}>{pl.backHome}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center p-4 bg-background">
        <Card className="max-w-xl w-full border-border shadow-lg">
          <CardContent className="p-8 text-center space-y-6">
            <div className="h-16 w-16 bg-lavender rounded-2xl flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🎯</span>
            </div>
            <h1 className="text-3xl font-bold text-foreground">{pl.introTitle}</h1>
            <p className="text-muted-foreground text-lg leading-relaxed">
              {pl.introBody(test.questions.length)}
            </p>
            <p className="text-sm text-mint-foreground font-medium bg-mint-soft p-3 rounded-lg">
              {pl.introNote}
            </p>
            <Button
              size="lg"
              className="w-full h-14 text-lg rounded-xl mt-4 bg-primary hover:bg-primary/90"
              onClick={() => setStarted(true)}
            >
              {pl.startNow}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const question = test.questions[currentIndex];
  // Written questions carry no options; the server scores them separately.
  const isWritten =
    (question as { type?: string }).type === "written" ||
    !question.options ||
    question.options.length === 0;
  const isLast = currentIndex === test.questions.length - 1;
  const progress = ((currentIndex + 1) / test.questions.length) * 100;

  const handleSelectOption = (optionId: string) => {
    setAnswers(prev => ({ ...prev, [question.id]: optionId }));
  };

  const handleSubmit = () => {
    const formattedAnswers: Array<{
      questionId: number;
      selectedOptionId?: string;
      responseText?: string;
    }> = Object.entries(answers).map(([qId, oId]) => ({
      questionId: parseInt(qId, 10),
      selectedOptionId: oId,
    }));

    // Blank written answers are omitted; the server treats them as unanswered.
    for (const [qId, text] of Object.entries(writtenAnswers)) {
      if (text.trim().length === 0) continue;
      formattedAnswers.push({ questionId: parseInt(qId, 10), responseText: text.trim() });
    }

    submitTest.mutate(
      { data: { answers: formattedAnswers } },
      {
        onSuccess: async (data) => {
          // Invalidate dashboard and levels before navigating
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetLevelsQueryKey() }),
          ]);
          setResult(data);
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: pl.submitErrorTitle,
            description: pl.submitErrorBody,
          });
        }
      }
    );
  };

  const handleNext = () => {
    if (isLast) {
      handleSubmit();
    } else {
      setCurrentIndex(prev => prev + 1);
    }
  };

  const handleSkip = () => {
    if (isLast) {
      handleSubmit();
    } else {
      setCurrentIndex(prev => prev + 1);
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col p-4 bg-background max-w-2xl mx-auto w-full pt-12 md:pt-24">
      {/* Progress */}
      <div className="mb-8 space-y-2">
        <div className="flex justify-between text-sm font-medium text-muted-foreground">
          <span>{pl.questionOf(currentIndex + 1, test.questions.length)}</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {/* Question Card */}
      <Card className="border-border shadow-md mb-6 animate-in slide-in-from-right-8 duration-300">
        <CardContent className="p-6 md:p-8 space-y-6">
          {/* A listening question is about a clip; without it there is nothing
              to answer. The passage below carries the transcript, if any. */}
          <BlockMedia mediaId={(question as { mediaId?: number | null }).mediaId} kind="audio" />
          <div dir="ltr" className="text-2xl font-bold text-foreground text-center my-4 font-serif">
            {question.questionText}
          </div>
          {question.questionTextAr && (
            <div className="text-muted-foreground text-center mb-8" dir="rtl">
              {question.questionTextAr}
            </div>
          )}

          {/* Without this a written question is unanswerable — it has no options. */}
          {isWritten ? (
            <div className="space-y-2" dir="ltr">
              <textarea
                value={writtenAnswers[question.id] ?? ""}
                onChange={e =>
                  setWrittenAnswers(prev => ({ ...prev, [question.id]: e.target.value }))
                }
                rows={6}
                maxLength={4000}
                placeholder="Write your answer in English…"
                className="w-full rounded-xl border-2 border-border bg-card p-4 text-base leading-relaxed text-foreground focus:border-primary focus:outline-none"
              />
              <div className="text-xs text-muted-foreground text-start" dir="rtl">
                {(writtenAnswers[question.id] ?? "").trim().length} / 4000
              </div>
            </div>
          ) : (
          <div className="space-y-3" dir="ltr">
            {question.options.map(option => (
              <button
                key={option.id}
                onClick={() => handleSelectOption(option.id)}
                className={`w-full p-4 rounded-xl border-2 text-left transition-all duration-200 flex items-center justify-between ${
                  answers[question.id] === option.id
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-border hover:border-primary/40 bg-card hover:bg-secondary/30"
                }`}
              >
                <span className="text-lg font-medium text-foreground">{option.text}</span>
                <div className={`h-5 w-5 rounded-full border flex items-center justify-center ${
                  answers[question.id] === option.id ? "border-primary bg-primary" : "border-muted-foreground"
                }`}>
                  {answers[question.id] === option.id && <div className="h-2 w-2 rounded-full bg-white" />}
                </div>
              </button>
            ))}
          </div>
          )}
        </CardContent>
      </Card>

      {/* Controls */}
      <div className="flex justify-between items-center mt-4">
        {/* Outlined, not ghost: as plain text this read as a label, not a control. */}
        <Button
          variant="outline"
          size="lg"
          onClick={handleSkip}
          className="h-12 px-6 rounded-xl border-2"
          disabled={submitTest.isPending}
        >
          {pl.skip}
        </Button>

        <Button
          onClick={handleNext}
          size="lg"
          className="h-12 px-8 rounded-xl"
          disabled={
            submitTest.isPending ||
            (isWritten
              ? (writtenAnswers[question.id] ?? "").trim().length === 0
              : !answers[question.id])
          }
        >
          {submitTest.isPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : isLast ? (
            pl.finish
          ) : (
            <>
              {pl.next}
              <ArrowLeft className="me-2 h-4 w-4 ltr:-scale-x-100" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
