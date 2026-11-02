/**
 * Student quiz runner — used for ordinary quizzes and for level evaluations,
 * which are the same thing with a `kind` of `level_evaluation` on the server.
 *
 * Nothing here decides anything that matters. Answers are saved as the student
 * goes and graded server-side on submit; the score, the pass/fail verdict and
 * any promotion all arrive in the submit response. This screen only collects
 * and displays.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useMicRecorder } from "@/hooks/use-mic-recorder";
import { uploadRecording, MediaUploadError } from "@/lib/media-api";
import { BlockMedia } from "@/components/block-media";
import { useI18n } from "@/lib/i18n";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  Trophy,
  AlertCircle,
  RotateCcw,
  Loader2,
  Mic,
  StopCircle,
} from "lucide-react";
import {
  getQuiz,
  startAttempt,
  saveResponse,
  submitAttempt,
  QuizApiError,
  type StudentQuiz,
  type StudentQuizBlock,
  type QuizAttempt,
  type QuizSubmitResult,
} from "@/lib/quiz-api";

/** Blocks that only present something — they carry no answer to collect. */
const PASSIVE_TYPES = new Set(["text", "explanation", "video", "audio"]);

type AnswerMap = Record<number, unknown>;

/** Blocks whose answer is an uploaded recording rather than a value. */
const MEDIA_TYPES = new Set(["speaking_prompt"]);

/** Shape one answer for the save endpoint. */
function responsePayload(blockType: string, value: unknown): { response?: unknown; mediaId?: number } {
  if (MEDIA_TYPES.has(blockType)) {
    return typeof value === "number" ? { mediaId: value } : {};
  }
  return { response: value };
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export default function Quiz({ params }: { params: { quizId: string } }) {
  const quizId = parseInt(params.quizId, 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { t, lang, pick } = useI18n();
  const qz = t.quiz;

  const [quiz, setQuiz] = useState<StudentQuiz | null>(null);
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [index, setIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<QuizSubmitResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Submitting must happen exactly once even if the timer fires while the
  // student is already pressing the button.
  const submitGuard = useRef(false);

  // ── Load the quiz and open an attempt ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    if (isNaN(quizId)) {
      setLoadError(qz.invalidId);
      return;
    }

    (async () => {
      try {
        const loaded = await getQuiz(quizId);
        // Starting the attempt is what enforces the evaluation gate, so it must
        // happen before the student can answer anything.
        const started = await startAttempt(quizId);
        if (cancelled) return;
        setQuiz(loaded);
        setAttempt(started);
        if (loaded.timeLimitSec) {
          const elapsed = Math.floor(
            (Date.now() - new Date(started.startedAt).getTime()) / 1000,
          );
          setSecondsLeft(Math.max(0, loaded.timeLimitSec - elapsed));
        }
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof QuizApiError ? e.message : qz.loadFailed,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [quizId]);

  const blocks = useMemo(() => quiz?.blocks ?? [], [quiz]);
  const current = blocks[index];

  // ── Countdown ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (secondsLeft === null || result) return;
    if (secondsLeft <= 0) {
      void handleSubmit(true);
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
    // handleSubmit is stable enough for this effect's purpose: it reads the
    // latest attempt from state and guards against running twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, result]);

  // ── Answering ──────────────────────────────────────────────────────────────
  const setAnswer = (blockId: number, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [blockId]: value }));
  };

  /**
   * Persist the current block's answer. Failures are surfaced but do not block
   * navigation — the answer stays in local state and is written again on
   * submit, so a flaky save does not cost the student their work.
   */
  const persist = async (block: StudentQuizBlock) => {
    if (!attempt) return;
    if (PASSIVE_TYPES.has(block.type)) return;
    const value = answers[block.id];
    if (value === undefined) return;
    try {
      await saveResponse(attempt.id, block.id, responsePayload(block.type, value));
    } catch {
      toast({
        title: qz.notSaved,
        description: qz.notSavedBody,
        variant: "destructive",
      });
    }
  };

  const goNext = async () => {
    if (current) await persist(current);
    setIndex((i) => Math.min(i + 1, blocks.length - 1));
  };

  const goPrev = async () => {
    if (current) await persist(current);
    setIndex((i) => Math.max(i - 1, 0));
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (auto = false) => {
    if (!attempt || submitGuard.current) return;
    submitGuard.current = true;
    setSubmitting(true);

    try {
      // Flush every answer the student gave, not just the visible one — a
      // block answered and then navigated past may not have been persisted if
      // its save failed earlier.
      for (const block of blocks) {
        if (PASSIVE_TYPES.has(block.type)) continue;
        if (answers[block.id] === undefined) continue;
        try {
          await saveResponse(
            attempt.id,
            block.id,
            responsePayload(block.type, answers[block.id]),
          );
        } catch {
          // Reported below if the submit itself then fails.
        }
      }

      const submitted = await submitAttempt(attempt.id);
      setResult(submitted);
      if (auto) {
        toast({ title: qz.timeUp, description: qz.timeUpBody });
      }
    } catch (e) {
      submitGuard.current = false;
      toast({
        title: qz.submitFailed,
        description: e instanceof QuizApiError ? e.message : qz.tryAgain,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center space-y-4">
        <AlertCircle className="h-10 w-10 mx-auto text-destructive" />
        <p className="text-destructive font-medium">{loadError}</p>
        <Button variant="outline" onClick={() => setLocation("/learn")} className="rounded-xl">
          {t.level.backToCurriculum}
        </Button>
      </div>
    );
  }

  if (!quiz || !attempt) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (result) {
    return <QuizResult quiz={quiz} result={result} onLeave={() => setLocation("/learn")} />;
  }

  const answered = blocks.filter(
    (b) => !PASSIVE_TYPES.has(b.type) && answers[b.id] !== undefined,
  ).length;
  const answerable = blocks.filter((b) => !PASSIVE_TYPES.has(b.type)).length;
  const isLast = index === blocks.length - 1;

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold truncate">{pick(quiz.titleAr, quiz.title)}</h1>
            {lang === "ar" && (
              <p className="text-sm text-muted-foreground truncate" dir="ltr">
                {quiz.title}
              </p>
            )}
          </div>
          {secondsLeft !== null && (
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-xl font-bold tabular-nums shrink-0 ${
                secondsLeft <= 60 ? "bg-destructive/10 text-destructive" : "bg-muted"
              }`}
            >
              <Clock className="h-4 w-4" />
              {formatClock(secondsLeft)}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {qz.questionOf(index + 1, blocks.length)}
            </span>
            <span>
              {qz.answeredOf(answered, answerable)}
            </span>
          </div>
          <Progress value={((index + 1) / blocks.length) * 100} className="h-2" />
        </div>

        {pick(quiz.instructionsAr, quiz.instructions) && index === 0 && (
          <p className="text-sm bg-muted/50 rounded-xl p-3">{pick(quiz.instructionsAr, quiz.instructions)}</p>
        )}
      </div>

      {/* Current block */}
      <Card className="border-2">
        <CardContent className="p-5 md:p-7 space-y-5">
          {current && <QuizBlock block={current} value={answers[current.id]} onChange={setAnswer} />}
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          onClick={goPrev}
          disabled={index === 0 || submitting}
          className="rounded-xl gap-2"
        >
          <ArrowRight className="h-4 w-4 ltr:-scale-x-100" />
          {qz.prev}
        </Button>

        {isLast ? (
          <Button
            onClick={() => handleSubmit(false)}
            disabled={submitting}
            className="rounded-xl gap-2"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {qz.submit}
          </Button>
        ) : (
          <Button onClick={goNext} disabled={submitting} className="rounded-xl gap-2">
            {qz.next}
            <ArrowLeft className="h-4 w-4 ltr:-scale-x-100" />
          </Button>
        )}
      </div>

      {answered < answerable && isLast && (
        <p className="text-xs text-center text-amber-600">
          {qz.unanswered(answerable - answered)}
        </p>
      )}
    </div>
  );
}

// ─── One block ────────────────────────────────────────────────────────────────

function QuizBlock({
  block,
  value,
  onChange,
}: {
  block: StudentQuizBlock;
  value: unknown;
  onChange: (blockId: number, value: unknown) => void;
}) {
  const { t, lang, pick } = useI18n();
  const qz = t.quiz;
  const heading = pick(block.titleAr, block.title);
  const instructions = pick(block.instructionsAr, block.instructions);
  const prompt = pick(block.promptAr, block.prompt);
  // Option text may be English or Arabic; let the browser pick its direction
  // and align it with the page.
  const optionAlign = lang === "ar" ? "text-right" : "text-left";
  const options = block.config.options ?? [];

  const shell = (children: React.ReactNode) => (
    <>
      {heading && <h2 className="text-lg font-bold">{heading}</h2>}
      {instructions && <p className="text-sm text-muted-foreground">{instructions}</p>}
      {block.content && (
        <p className="leading-relaxed whitespace-pre-wrap" dir="ltr">
          {block.content}
        </p>
      )}
      {prompt && <p className="font-medium">{prompt}</p>}
      {children}
    </>
  );

  switch (block.type) {
    case "text":
    case "explanation":
      return shell(null);

    case "video":
    case "audio":
    case "listening":
      return shell(
        <div className="space-y-3">
          {block.referenceMediaId ? (
            <BlockMedia
              mediaId={block.referenceMediaId}
              kind={block.type === "video" ? "video" : "audio"}
            />
          ) : (
            <p className="text-sm bg-muted/60 rounded-xl p-3 text-muted-foreground">
              {qz.noMedia}
            </p>
          )}
          {block.type === "listening" && (
            <Textarea
              dir="ltr"
              rows={4}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(block.id, e.target.value)}
              placeholder="Your answer"
              className="rounded-xl"
            />
          )}
        </div>,
      );

    case "mcq":
      return shell(
        <div className="space-y-2">
          {options.map((o) => {
            const selected = value === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange(block.id, o.id)}
                className={`w-full text-start p-4 rounded-xl border-2 transition-colors ${
                  selected
                    ? "border-primary bg-primary/5 font-medium"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <span dir="auto" className={`block ${optionAlign}`}>
                  {pick(o.textAr, o.text)}
                </span>
              </button>
            );
          })}
        </div>,
      );

    case "multi_select": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return shell(
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{qz.selectAll}</p>
          {options.map((o) => {
            const on = selected.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() =>
                  onChange(
                    block.id,
                    on ? selected.filter((s) => s !== o.id) : [...selected, o.id],
                  )
                }
                className={`w-full text-start p-4 rounded-xl border-2 flex items-center gap-3 transition-colors ${
                  on ? "border-primary bg-primary/5 font-medium" : "border-border hover:border-primary/40"
                }`}
              >
                <span
                  className={`h-5 w-5 rounded border-2 shrink-0 flex items-center justify-center ${
                    on ? "bg-primary border-primary text-primary-foreground" : "border-border"
                  }`}
                >
                  {on && <CheckCircle2 className="h-3.5 w-3.5" />}
                </span>
                <span dir="auto" className={`flex-1 ${optionAlign}`}>
                  {pick(o.textAr, o.text)}
                </span>
              </button>
            );
          })}
        </div>,
      );
    }

    case "speaking_prompt":
      return shell(
        <SpeakingAnswer
          value={typeof value === "number" ? value : null}
          onUploaded={(mediaId) => onChange(block.id, mediaId)}
        />,
      );

    case "spelling":
      return shell(
        <Input
          dir="ltr"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(block.id, e.target.value)}
          placeholder="Type the word"
          className="rounded-xl text-lg"
        />,
      );

    case "writing":
    case "image_describe": {
      const text = typeof value === "string" ? value : "";
      const min = block.config.minWords;
      const count = wordCount(text);
      return shell(
        <div className="space-y-2">
          {/* The image is the question here — without it there is nothing to describe. */}
          <BlockMedia mediaId={block.referenceMediaId} kind="image" />
          <Textarea
            dir="ltr"
            rows={7}
            value={text}
            onChange={(e) => onChange(block.id, e.target.value)}
            placeholder="Write your answer in English"
            className="rounded-xl"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{qz.words(count)}</span>
            {min !== undefined && (
              <span className={count < min ? "text-amber-600" : ""}>{qz.minWords(min)}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {qz.gradedLater}
          </p>
        </div>,
      );
    }

    default:
      return shell(
        <p className="text-sm text-muted-foreground">{qz.questionType(block.type)}</p>,
      );
  }
}

// ─── Speaking answer ──────────────────────────────────────────────────────────

/**
 * Record, upload, and report the resulting media id as the answer.
 *
 * The upload runs as soon as recording stops rather than on submit: the student
 * is listening back anyway, so the transfer costs time they were already
 * spending, and an exam submit stays instant. The answer is only reported once
 * the server has confirmed the file — an unconfirmed recording would be
 * rejected on save.
 */
function SpeakingAnswer({
  value,
  onUploaded,
}: {
  value: number | null;
  onUploaded: (mediaId: number) => void;
}) {
  const mic = useMicRecorder();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const sp = t.speaking;

  useEffect(() => {
    if (mic.status !== "done" || !mic.blob || mic.durationSec <= 0) return;

    let cancelled = false;
    setUploading(true);
    setError(null);

    uploadRecording(mic.blob, "quiz_response", mic.durationSec)
      .then((r) => {
        if (cancelled) return;
        setUploading(false);
        onUploaded(r.mediaId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setUploading(false);
        setError(
          err instanceof MediaUploadError && err.status === 503
            ? sp.storageOff
            : sp.uploadFailed,
        );
      });

    return () => {
      cancelled = true;
    };
  // onUploaded is recreated each render; depending on it would restart the
  // upload every time the parent re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.status, mic.blob, mic.durationSec]);

  return (
    <div className="flex flex-col items-center gap-4 p-6 border-2 border-dashed rounded-2xl bg-muted/20">
      {mic.status === "idle" && (
        <>
          <button
            type="button"
            onClick={mic.start}
            className="h-20 w-20 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg hover:scale-105 transition-transform"
            aria-label={sp.startRecording}
          >
            <Mic className="h-8 w-8" />
          </button>
          <p className="text-sm font-medium">{sp.tapToSpeak}</p>
        </>
      )}

      {mic.status === "recording" && (
        <>
          <button
            type="button"
            onClick={mic.stop}
            className="h-20 w-20 rounded-full bg-rose-500 text-white flex items-center justify-center shadow-lg animate-pulse"
            aria-label={sp.stopRecording}
          >
            <StopCircle className="h-8 w-8" />
          </button>
          <p className="text-sm font-medium">{sp.recording}</p>
        </>
      )}

      {mic.status === "done" && (
        <div className="w-full space-y-3">
          <audio controls className="w-full rounded-lg" src={mic.playbackUrl ?? undefined} />
          <p className="text-xs text-center text-muted-foreground">
            {sp.duration(mic.durationSec)}
          </p>
          {uploading && (
            <p className="text-xs text-center text-muted-foreground">{sp.uploading}</p>
          )}
          {error && <p className="text-xs text-center text-destructive">{error}</p>}
          {value !== null && !uploading && !error && (
            <p className="text-xs text-center text-mint-foreground">{sp.saved}</p>
          )}
          <Button variant="outline" size="sm" onClick={mic.reset} className="w-full rounded-xl">
            {sp.reRecord}
          </Button>
        </div>
      )}

      {mic.status === "denied" && (
        <p className="text-sm text-center text-muted-foreground">
          {sp.denied}
        </p>
      )}
      {mic.status === "unsupported" && (
        <p className="text-sm text-center text-muted-foreground">
          {sp.unsupported}
        </p>
      )}

      <p className="text-xs text-muted-foreground text-center">
        {sp.savedForReview}
      </p>
    </div>
  );
}

// ─── Result ───────────────────────────────────────────────────────────────────

function QuizResult({
  quiz,
  result,
  onLeave,
}: {
  quiz: StudentQuiz;
  result: QuizSubmitResult;
  onLeave: () => void;
}) {
  const [, setLocation] = useLocation();
  const { t, lang, pick } = useI18n();
  const qz = t.quiz;
  const pending = result.pendingReviewCount > 0;
  const score = Math.round(result.score ?? 0);

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
      <Card className="border-2 overflow-hidden">
        <CardContent className="p-8 text-center space-y-4">
          {pending ? (
            <Clock className="h-14 w-14 mx-auto text-blue-500" />
          ) : result.passed ? (
            <CheckCircle2 className="h-14 w-14 mx-auto text-mint-foreground" />
          ) : (
            <XCircle className="h-14 w-14 mx-auto text-destructive" />
          )}

          <h1 className="text-2xl font-bold">
            {pending ? qz.pending : result.passed ? qz.passed : qz.failed}
          </h1>

          <div className="text-5xl font-bold tabular-nums">{score}%</div>
          <p className="text-sm text-muted-foreground">
            {t.evaluation.passMark(result.passingScore)}
          </p>

          {pending && (
            <p className="text-sm bg-blue-50 text-blue-800 rounded-xl p-3">
              {qz.pendingCount(result.pendingReviewCount)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Promotion */}
      {result.promotion?.promoted && (
        <Card className="border-2 border-mint/50 bg-mint-soft">
          <CardContent className="p-6 text-center space-y-2">
            <Trophy className="h-10 w-10 mx-auto text-mint-foreground" />
            <h2 className="text-xl font-bold text-mint-foreground">{qz.promoted}</h2>
            <p className="text-mint-foreground">
              {qz.newLevel} <span className="font-bold">{pick(result.promotion.toLevelNameAr, result.promotion.toLevelName)}</span>
              <span className="mx-2 font-serif" dir="ltr">
                ({result.promotion.toLevelCode})
              </span>
            </p>
          </CardContent>
        </Card>
      )}

      {result.promotion?.curriculumCompleted && (
        <Card className="border-2 border-primary/30 bg-lavender">
          <CardContent className="p-6 text-center space-y-2">
            <Trophy className="h-10 w-10 mx-auto text-primary" />
            <h2 className="text-xl font-bold text-lavender-foreground">{qz.curriculumDone}</h2>
            <p className="text-lavender-foreground">{qz.curriculumDoneBody}</p>
          </CardContent>
        </Card>
      )}

      {/* Remediation */}
      {result.remediation && result.remediation.length > 0 && (
        <Card className="border-2">
          <CardContent className="p-6 space-y-3">
            <h2 className="font-bold flex items-center gap-2">
              <RotateCcw className="h-4 w-4" />
              {qz.reviewBefore}
            </h2>
            <div className="space-y-2">
              {result.remediation.map((l) => (
                <button
                  key={l.lessonId}
                  type="button"
                  onClick={() => setLocation(`/lesson/${l.lessonId}`)}
                  className="w-full text-start p-3 rounded-xl border hover:border-primary/40 transition-colors flex items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="block font-medium truncate">{pick(l.titleAr, l.title)}</span>
                    {lang === "ar" && (
                      <span className="block text-xs text-muted-foreground truncate" dir="ltr">
                        {l.title}
                      </span>
                    )}
                  </span>
                  <span className="text-xs shrink-0 text-muted-foreground">
                    {l.bestScore === null ? t.evaluation.notStudied : `${Math.round(l.bestScore)}%`}
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Button onClick={onLeave} className="w-full rounded-xl" size="lg">
        {t.level.backToCurriculum}
      </Button>
      <p className="text-center text-xs text-muted-foreground" dir="ltr">
        {quiz.title}
      </p>
    </div>
  );
}
