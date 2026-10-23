import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLesson,
  useCompleteLesson,
  useStartLesson,
  useSubmitLessonActivity,
  getGetDashboardQueryKey,
  getGetLevelsQueryKey,
  getGetLevelQueryKey,
  getGetLessonQueryKey,
  getGetLessonsQueryKey,
  getGetLessonProgressQueryKey,
} from "@workspace/api-client-react";
import type {
  ContentBlock,
  LessonActivityResult,
  LessonProgress,
  LessonCompletionError,
} from "@workspace/api-client-react";
import { BlockMedia } from "@/components/block-media";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { uploadRecording, MediaUploadError } from "@/lib/media-api";
import { pollAttemptVerdict, type AttemptVerdict } from "@/lib/speech-api";
import { ConversationBlock } from "@/components/conversation-block";
import { useMicRecorder } from "@/hooks/use-mic-recorder";
import {
  ArrowRight,
  Volume2,
  Mic,
  CheckCircle2,
  XCircle,
  PlayCircle,
  Loader2,
  StopCircle,
  Play,
  Square,
  AlertCircle,
} from "lucide-react";

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function genClientId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Returns true if the string looks like a usable URL (http/https). */
function isUsableUrl(url?: string | null): boolean {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

// ──────────────────────────────────────────────────────────────────────
// Per-block state
// ──────────────────────────────────────────────────────────────────────
interface BlockState {
  submitted: boolean;
  submitting: boolean;
  result: LessonActivityResult | null;
  // MCQ
  selectedOptionId?: string;
  // Open-ended
  responseText?: string;
  // Speaking / pronunciation
  recordingDurationSeconds?: number;
  hasRecording?: boolean;
  /** Set once the recording has been uploaded and confirmed by the server. */
  mediaId?: number;
  uploading?: boolean;
  uploadError?: string;
  /** Filled in once the background speech assessment reports back. */
  speechVerdict?: AttemptVerdict;
  awaitingVerdict?: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Block header (title, instructions, required badge, duration)
// ──────────────────────────────────────────────────────────────────────
function BlockHeader({ block }: { block: ContentBlock }) {
  const title = block.titleAr || block.title;
  const instructions = block.instructionsAr || block.instructions;
  return (
    <div className="space-y-2 mb-6">
      {title && (
        <h2 className="text-xl font-bold text-foreground">{title}</h2>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {block.isRequired ? (
          <Badge variant="default" className="text-xs">مطلوب</Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">اختياري</Badge>
        )}
        {block.estimatedMinutes && (
          <span className="text-xs text-muted-foreground">{block.estimatedMinutes} دقيقة</span>
        )}
      </div>
      {instructions && (
        <p className="text-sm text-muted-foreground leading-relaxed">{instructions}</p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Optional illustration media
// ──────────────────────────────────────────────────────────────────────
/**
 * The image and/or audio a content manager attached to this block.
 *
 * Deliberately NOT tied to a block type. Several types have a media field of
 * their own with grading meaning — a pronunciation block's reference recording
 * is what its score is measured against — but most types had no way to carry a
 * picture at all. These two fields are purely illustrative: shown if present,
 * absent otherwise, and never read by a grader.
 *
 * Renders nothing when neither is set, which is the common case, so it is safe
 * to mount in every block type.
 *
 * PLACEMENT: immediately after whatever the block presents as its question or
 * subject — the MCQ question card, the open-ended prompt, the speaking passage,
 * the spelled word — and before the controls the student acts with. A picture
 * that belongs to a question is part of reading it, so it has to arrive before
 * the student starts answering rather than below the whole block where it would
 * be missed. On passive blocks, which have no question, it follows the header.
 */
function BlockIllustration({ block }: { block?: ContentBlock | null }) {
  if (!block) return null;
  const imageId = block.imageMediaId;
  const audioId = block.audioMediaId;
  if (!imageId && !audioId) return null;

  return (
    <div className="mt-6 space-y-3">
      {imageId ? <BlockMedia mediaId={imageId} kind="image" /> : null}
      {audioId ? <BlockMedia mediaId={audioId} kind="audio" /> : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Audio widget
// ──────────────────────────────────────────────────────────────────────
function AudioWidget({ url, label }: { url: string; label?: string }) {
  return (
    <div className="mt-4 space-y-1">
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
      <audio controls className="w-full rounded-lg" src={url} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// MCQ block
// ──────────────────────────────────────────────────────────────────────
function McqBlock({
  block,
  state,
  onSelect,
  questionIndex = 0,
}: {
  block: ContentBlock;
  state: BlockState;
  onSelect: (optionId: string) => void;
  questionIndex?: number;
}) {
  const result = state.result;
  // A block may hold several questions; fall back to the singular fields for
  // content authored before that was possible.
  const questions = block.questions ?? [];
  const active = questions[questionIndex];
  const question = active?.question ?? block.question;
  const questionAr = active?.questionAr ?? block.questionAr;
  const options = active?.options ?? block.options ?? [];

  return (
    <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
      <BlockHeader block={block} />

      {questions.length > 1 && (
        <p className="text-center text-sm text-muted-foreground">
          سؤال {questionIndex + 1} من {questions.length}
        </p>
      )}

      <div className="p-6 bg-secondary rounded-2xl text-center space-y-4">
        {questionAr && (
          <h3 className="text-lg font-medium text-muted-foreground">{questionAr}</h3>
        )}
        {question && (
          <h2 className="text-2xl font-bold font-serif" dir="ltr">{question}</h2>
        )}
      </div>

      <BlockIllustration block={block} />

      {isUsableUrl(block.audioUrl) && <AudioWidget url={block.audioUrl!} label={block.audioNote ?? undefined} />}

      <div className="space-y-3" dir="ltr">
        {options.map((option) => {
          const isSelected = state.selectedOptionId === option.id;
          const hasResult = !!result;
          const isCorrect = hasResult && result.correct === true && isSelected;
          const isWrong = hasResult && result.correct === false && isSelected;
          const isCorrectUnselected = hasResult && result.correct === false && !isSelected;
          // We don't know which option is actually correct from the API (no correctOptionId exposed),
          // so we only show feedback on the selected option.
          let cls = "border-border hover:border-primary/40 bg-card";
          if (!hasResult && isSelected) cls = "border-primary bg-primary/5 shadow-sm";
          if (isCorrect) cls = "border-emerald-500 bg-emerald-50";
          if (isWrong) cls = "border-rose-500 bg-rose-50";
          if (hasResult && !isSelected) cls = "border-border opacity-60 bg-card";

          return (
            <button
              key={option.id}
              disabled={state.submitted || state.submitting}
              onClick={() => onSelect(option.id)}
              className={`w-full p-4 rounded-xl border-2 text-left transition-all duration-200 flex items-center justify-between ${cls}`}
            >
              <div>
                <span className="text-lg font-medium text-foreground">{option.text}</span>
                {option.textAr && (
                  <span className="block text-sm text-muted-foreground" dir="rtl">{option.textAr}</span>
                )}
              </div>
              {isCorrect && <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />}
              {isWrong && <XCircle className="h-5 w-5 text-rose-600 shrink-0" />}
            </button>
          );
        })}
      </div>

      {result && (result.explanationAr || result.explanation) && (
        <div className={`p-4 rounded-xl border ${result.correct ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200"}`}>
          <p className="text-sm font-medium">
            {result.correct ? "✅ إجابة صحيحة" : "❌ إجابة خاطئة"}
          </p>
          {(result.explanationAr || result.explanation) && (
            <p className="text-sm mt-1 text-muted-foreground">
              {result.explanationAr || result.explanation}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Open-ended block
// ──────────────────────────────────────────────────────────────────────
function OpenEndedBlock({
  block,
  state,
  onChange,
  onRecordingDone,
  onUploadState,
}: {
  block: ContentBlock;
  state: BlockState;
  onChange: (text: string) => void;
  onRecordingDone: (durationSec: number) => void;
  onUploadState: (patch: {
    uploading?: boolean;
    mediaId?: number;
    uploadError?: string;
  }) => void;
}) {
  const mic = useMicRecorder();

  // Spec 4C allows either. Writing and speaking are different skills, and a
  // student who can say it but not spell it should still be able to answer.
  const [mode, setMode] = useState<"text" | "voice">("text");

  // Same upload-on-stop as the speaking block: the transfer happens while the
  // student reviews their playback, so Continue stays instant.
  useEffect(() => {
    if (mode !== "voice") return;
    if (mic.status !== "done" || !mic.blob || mic.durationSec <= 0) return;

    let cancelled = false;
    onRecordingDone(mic.durationSec);
    onUploadState({ uploading: true, uploadError: undefined });

    uploadRecording(mic.blob, "lesson_activity", mic.durationSec)
      .then((r) => {
        if (!cancelled) onUploadState({ uploading: false, mediaId: r.mediaId });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onUploadState({
          uploading: false,
          uploadError:
            err instanceof MediaUploadError && err.status === 503
              ? "خدمة تخزين الصوت غير مفعّلة حالياً."
              : "تعذّر رفع التسجيل. أعد المحاولة.",
        });
      });

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, mic.status, mic.blob, mic.durationSec]);

  return (
    <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
      <BlockHeader block={block} />

      {block.contentAr && (
        <p className="text-lg leading-relaxed text-foreground" dir="rtl">{block.contentAr}</p>
      )}
      {block.content && (
        <div className="p-6 bg-secondary/50 rounded-2xl border border-border">
          <p className="text-xl leading-relaxed font-serif text-foreground" dir="ltr">{block.content}</p>
        </div>
      )}
      {block.promptAr && (
        <p className="text-base font-medium text-foreground">{block.promptAr}</p>
      )}
      {block.prompt && (
        <p className="text-sm text-muted-foreground" dir="ltr">{block.prompt}</p>
      )}

      <BlockIllustration block={block} />

      {isUsableUrl(block.audioUrl) && <AudioWidget url={block.audioUrl!} label={block.audioNote ?? undefined} />}

      {!state.submitted && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant={mode === "text" ? "default" : "outline"}
            size="sm"
            className="flex-1 rounded-xl"
            onClick={() => setMode("text")}
          >
            كتابة
          </Button>
          <Button
            type="button"
            variant={mode === "voice" ? "default" : "outline"}
            size="sm"
            className="flex-1 rounded-xl gap-2"
            onClick={() => setMode("voice")}
          >
            <Mic className="h-4 w-4" />
            تسجيل صوتي
          </Button>
        </div>
      )}

      {/* After submitting, show the answer that was actually given. Falling
          back to the textarea on `submitted` regardless of mode meant a spoken
          answer was replaced by an empty disabled box — the recording gone and
          the block looking as though it had reset. A voice answer keeps its
          recorder panel, which reports the saved recording. */}
      {state.submitted && mode === "voice" && !state.responseText ? (
        <p className="text-xs text-center text-emerald-600">تم إرسال تسجيلك الصوتي.</p>
      ) : mode === "text" || state.submitted ? (
        <textarea
          className="w-full border rounded-xl p-4 text-foreground bg-background resize-none min-h-[120px] focus:outline-none focus:ring-2 focus:ring-primary/40"
          placeholder="اكتب إجابتك هنا..."
          value={state.responseText ?? ""}
          disabled={state.submitted}
          onChange={(e) => onChange(e.target.value)}
          dir="ltr"
        />
      ) : (
        <div className="space-y-3">
          {state.uploading && (
            <p className="text-xs text-center text-muted-foreground">جارٍ رفع التسجيل…</p>
          )}
          {state.uploadError && (
            <p className="text-xs text-center text-destructive">{state.uploadError}</p>
          )}
          {state.mediaId !== undefined && !state.uploading && (
            <p className="text-xs text-center text-emerald-600">تم حفظ التسجيل.</p>
          )}

          <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-border rounded-3xl bg-secondary/20 gap-4">
            {mic.status === "idle" && (
              <>
                <button
                  onClick={mic.start}
                  className="h-24 w-24 rounded-full bg-primary flex items-center justify-center text-primary-foreground shadow-lg hover:scale-105 transition-transform"
                >
                  <Mic className="h-10 w-10" />
                </button>
                <p className="text-lg font-medium text-foreground">انقر للتحدث</p>
              </>
            )}
            {mic.status === "recording" && (
              <button
                onClick={mic.stop}
                className="h-24 w-24 rounded-full bg-rose-500 flex items-center justify-center text-white shadow-lg animate-pulse"
              >
                <StopCircle className="h-10 w-10" />
              </button>
            )}
            {mic.status === "done" && (
              <div className="w-full space-y-3">
                <audio controls className="w-full rounded-lg" src={mic.playbackUrl ?? undefined} />
                <p className="text-sm text-muted-foreground text-center">
                  مدة التسجيل: {mic.durationSec} ثانية
                </p>
                <Button variant="outline" size="sm" onClick={mic.reset} className="w-full">
                  إعادة التسجيل
                </Button>
              </div>
            )}
            {mic.status === "unsupported" && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <AlertCircle className="h-5 w-5 text-amber-500" />
                <span>التسجيل الصوتي غير مدعوم في هذا المتصفح.</span>
              </div>
            )}
            {mic.status === "denied" && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <AlertCircle className="h-5 w-5 text-rose-500" />
                <span>لم يتم السماح بالوصول للميكروفون. يرجى السماح من إعدادات المتصفح.</span>
              </div>
            )}
          </div>
        </div>
      )}

      {state.result && <OpenEndedVerdict result={state.result} />}
    </div>
  );
}

/**
 * What came back for a written answer.
 *
 * Three outcomes, and the difference matters to the student: graded with
 * feedback, awaiting a mark (AI unavailable — their answer is safe and a
 * teacher will look at it), or just the teacher's prepared explanation.
 */
function OpenEndedVerdict({ result }: { result: LessonActivityResult }) {
  const feedback = result.feedbackAr || result.feedback;
  const explanation = result.explanationAr || result.explanation;
  const dims = result.dimensions;

  if (result.evaluationStatus === "pending") {
    return (
      <div className="p-4 rounded-xl border bg-blue-50 border-blue-200">
        <p className="text-sm text-blue-900">
          تم استلام إجابتك وسيتم تقييمها لاحقاً.
        </p>
      </div>
    );
  }

  if (!feedback && !explanation) return null;

  const passed = result.correct === true;

  return (
    <div
      className={`p-4 rounded-xl border space-y-3 ${
        feedback
          ? passed
            ? "bg-emerald-50 border-emerald-200"
            : "bg-amber-50 border-amber-200"
          : "bg-secondary/50"
      }`}
    >
      {feedback && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium flex-1">{feedback}</p>
          {result.score !== null && result.score !== undefined && (
            <span className="text-lg font-bold tabular-nums shrink-0">
              {Math.round(result.score)}%
            </span>
          )}
        </div>
      )}

      {dims && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 border-t border-black/5">
          {(
            [
              ["الصلة", dims.relevance],
              ["القواعد", dims.grammar],
              ["المفردات", dims.vocabulary],
              ["الوضوح", dims.clarity],
              ["المستوى", dims.levelAppropriate],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="text-center">
              <div className="text-sm font-bold tabular-nums">
                {value === undefined ? "—" : Math.round(value)}
              </div>
              <div className="text-[10px] text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>
      )}

      {explanation && (
        <p className="text-sm text-muted-foreground border-t border-black/5 pt-2">
          {explanation}
        </p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Speaking / pronunciation block (with MediaRecorder)
// ──────────────────────────────────────────────────────────────────────
function SpeakingBlock({
  block,
  state,
  onRecordingDone,
  onUploadState,
}: {
  block: ContentBlock;
  state: BlockState;
  onRecordingDone: (durationSec: number) => void;
  onUploadState: (patch: {
    uploading?: boolean;
    mediaId?: number;
    uploadError?: string;
  }) => void;
}) {
  const mic = useMicRecorder();

  // Upload as soon as the recording stops, rather than on submit: the student
  // is reviewing their playback anyway, so the transfer happens in time they
  // were already spending, and pressing Continue stays instant.
  useEffect(() => {
    if (mic.status !== "done" || !mic.blob || mic.durationSec <= 0) return;

    let cancelled = false;
    onRecordingDone(mic.durationSec);
    onUploadState({ uploading: true, uploadError: undefined });

    uploadRecording(mic.blob, "lesson_activity", mic.durationSec)
      .then((r) => {
        if (!cancelled) onUploadState({ uploading: false, mediaId: r.mediaId });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onUploadState({
          uploading: false,
          uploadError:
            err instanceof MediaUploadError && err.status === 503
              ? "خدمة تخزين الصوت غير مفعّلة حالياً."
              : "تعذّر رفع التسجيل. أعد المحاولة.",
        });
      });

    return () => {
      cancelled = true;
    };
  // onRecordingDone/onUploadState are recreated each render; depending on them
  // would restart the upload on every keystroke elsewhere in the page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.status, mic.blob, mic.durationSec]);

  return (
    <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
      <BlockHeader block={block} />

      {block.promptAr && (
        <div className="text-center space-y-2 mb-4">
          <h3 className="text-xl font-bold text-foreground">{block.promptAr}</h3>
        </div>
      )}
      {block.prompt && (
        <p className="text-muted-foreground text-center" dir="ltr">{block.prompt}</p>
      )}
      {block.contentAr && (
        <p className="text-lg leading-relaxed text-foreground text-center" dir="rtl">{block.contentAr}</p>
      )}
      {block.content && (
        <div className="p-6 bg-secondary/50 rounded-2xl border text-center">
          <p className="text-2xl font-bold font-serif" dir="ltr">{block.content}</p>
        </div>
      )}

      <BlockIllustration block={block} />

      {isUsableUrl(block.exampleAudio) && (
        <AudioWidget url={block.exampleAudio!} label="استمع للمثال الصوتي" />
      )}
      {isUsableUrl(block.audioUrl) && !isUsableUrl(block.exampleAudio) && (
        <AudioWidget url={block.audioUrl!} label={block.audioNote ?? undefined} />
      )}
      {/* Reference audio attached through the CMS picker is a media id, not a
          URL. For a read-aloud block this is the model pronunciation the
          student listens to before recording their own attempt. */}
      {!isUsableUrl(block.exampleAudio) && !isUsableUrl(block.audioUrl) && (
        <BlockMedia mediaId={block.referenceMediaId} kind="audio" />
      )}

      {/* What happens to the recording. Automatic assessment exists now, but it
          can still come back unavailable (speech provider off, out of quota), in
          which case the attempt stays pending for a teacher — so this does not
          promise a score, it says the recording is kept and assessed when it
          can be. The actual outcome is reported below by SpeechVerdictCard. */}
      <div className="text-xs text-muted-foreground bg-secondary/50 border border-border rounded-lg p-3 leading-relaxed">
        ملاحظة: يُحفظ تسجيلك ويُقيَّم تلقائياً بعد الإرسال. إذا تعذّر التقييم التلقائي، يبقى تسجيلك محفوظاً ليراجعه معلّم.
      </div>

      {state.uploading && (
        <p className="text-xs text-center text-muted-foreground">جارٍ رفع التسجيل…</p>
      )}
      {state.uploadError && (
        <p className="text-xs text-center text-destructive">{state.uploadError}</p>
      )}
      {state.mediaId !== undefined && !state.uploading && !state.speechVerdict && (
        <p className="text-xs text-center text-emerald-600">تم حفظ التسجيل.</p>
      )}

      {state.awaitingVerdict && (
        <p className="text-xs text-center text-muted-foreground">جارٍ تقييم نطقك…</p>
      )}

      {state.speechVerdict && <SpeechVerdictCard verdict={state.speechVerdict} />}

      <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-border rounded-3xl bg-secondary/20 gap-4">
        {mic.status === "idle" && (
          <button
            onClick={mic.start}
            disabled={state.submitted}
            className="h-24 w-24 rounded-full bg-primary flex items-center justify-center text-primary-foreground shadow-lg hover:scale-105 transition-transform"
          >
            <Mic className="h-10 w-10" />
          </button>
        )}
        {mic.status === "recording" && (
          <button
            onClick={mic.stop}
            className="h-24 w-24 rounded-full bg-rose-500 flex items-center justify-center text-white shadow-lg animate-pulse"
          >
            <StopCircle className="h-10 w-10" />
          </button>
        )}
        {mic.status === "done" && (
          <div className="w-full space-y-3">
            <audio controls className="w-full rounded-lg" src={mic.playbackUrl ?? undefined} />
            <p className="text-sm text-muted-foreground text-center">
              مدة التسجيل: {mic.durationSec} ثانية
            </p>
            {!state.submitted && (
              <Button variant="outline" size="sm" onClick={mic.reset} className="w-full">
                إعادة التسجيل
              </Button>
            )}
          </div>
        )}
        {mic.status === "unsupported" && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            <span>التسجيل الصوتي غير مدعوم في هذا المتصفح.</span>
          </div>
        )}
        {mic.status === "denied" && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <AlertCircle className="h-5 w-5 text-rose-500" />
            <span>لم يتم السماح بالوصول للميكروفون. يرجى السماح من إعدادات المتصفح.</span>
          </div>
        )}

        {mic.status === "idle" && (
          <p className="text-lg font-medium text-foreground">انقر للتحدث</p>
        )}
      </div>
    </div>
  );
}

/**
 * What the speech assessment found.
 *
 * Two scores rather than one, because they mean different things and a student
 * who reads accurately but haltingly should be told which of the two to work
 * on. The words they missed are named, because "practise these three words" is
 * advice and "72%" is not.
 */
function SpeechVerdictCard({ verdict }: { verdict: AttemptVerdict }) {
  if (verdict.evaluationStatus === "pending") {
    return (
      <div className="p-4 rounded-xl border bg-blue-50 border-blue-200">
        <p className="text-sm text-blue-900">
          تم استلام تسجيلك وسيتم تقييمه قريباً.
        </p>
      </div>
    );
  }

  const metrics = verdict.speechMetrics;
  const problems = metrics?.problemWords ?? [];
  const passed = verdict.correct === true;

  return (
    <div
      className={`p-4 rounded-xl border space-y-3 ${
        passed ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"
      }`}
    >
      <div className="flex items-center justify-around gap-2 text-center">
        {verdict.pronunciationScore !== null && (
          <div>
            <div className="text-2xl font-bold tabular-nums">
              {Math.round(verdict.pronunciationScore)}%
            </div>
            <div className="text-[11px] text-muted-foreground">النطق</div>
          </div>
        )}
        {!metrics?.fluencyUnavailable && verdict.fluencyScore !== null && (
          <div>
            <div className="text-2xl font-bold tabular-nums">
              {Math.round(verdict.fluencyScore)}%
            </div>
            <div className="text-[11px] text-muted-foreground">الطلاقة</div>
          </div>
        )}
        {metrics?.speechRate !== undefined && (
          <div>
            <div className="text-2xl font-bold tabular-nums">
              {Math.round(metrics.speechRate)}
            </div>
            <div className="text-[11px] text-muted-foreground">كلمة/دقيقة</div>
          </div>
        )}
      </div>

      {verdict.feedbackAr && (
        <p className="text-sm font-medium border-t border-black/5 pt-2">
          {verdict.feedbackAr}
        </p>
      )}

      {problems.length > 0 && (
        <div className="border-t border-black/5 pt-2">
          <p className="text-xs text-muted-foreground mb-1">تدرّب على هذه الكلمات:</p>
          <div className="flex flex-wrap gap-1.5" dir="ltr">
            {problems.slice(0, 8).map((w) => (
              <span
                key={w}
                className="text-xs font-mono bg-background border rounded-lg px-2 py-0.5"
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      )}

      {verdict.transcript && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            ما سمعناه
          </summary>
          <p className="mt-1 text-muted-foreground" dir="ltr">
            {verdict.transcript}
          </p>
        </details>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Vocabulary block
// ──────────────────────────────────────────────────────────────────────
function VocabularyBlock({ block }: { block: ContentBlock }) {
  return (
    <div className="space-y-4 animate-in slide-in-from-right-4 duration-300">
      <BlockHeader block={block} />
      <BlockIllustration block={block} />
      {(!block.vocabularyItems || block.vocabularyItems.length === 0) && (
        <p className="text-muted-foreground text-sm">لا توجد مفردات.</p>
      )}
      {(block.vocabularyItems ?? []).map((vocab) => (
        <Card key={vocab.id} className="overflow-hidden border-2 border-border hover:border-primary/30 transition-colors">
          <CardContent className="p-0 flex items-stretch">
            <div className="w-16 bg-primary/5 flex items-center justify-center border-r border-border">
              <Volume2 className="h-6 w-6 text-primary" />
            </div>
            <div className="p-4 flex-1">
              <div className="flex justify-between items-start mb-2">
                <div className="text-xl font-bold text-foreground" dir="ltr">{vocab.word}</div>
                <div className="text-lg font-bold text-primary">{vocab.translation}</div>
              </div>
              {vocab.pronunciation && (
                <div className="text-sm text-muted-foreground mb-3 font-mono" dir="ltr">/{vocab.pronunciation}/</div>
              )}
              {isUsableUrl(vocab.audioNote) && (
                <AudioWidget url={vocab.audioNote!} />
              )}
              {vocab.exampleSentence && (
                <div className="mt-4 pt-4 border-t border-border/50 text-left space-y-1" dir="ltr">
                  <p className="text-sm italic text-foreground">{vocab.exampleSentence}</p>
                  {vocab.exampleSentenceAr && (
                    <p className="text-sm text-muted-foreground text-right" dir="rtl">{vocab.exampleSentenceAr}</p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Passive text-like blocks (text, dialogue, explanation, pronunciation_guide, review, spelling)
// ──────────────────────────────────────────────────────────────────────
function TextBlock({ block }: { block: ContentBlock }) {
  return (
    <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
      <BlockHeader block={block} />
      <BlockIllustration block={block} />
      {block.contentAr && (
        <p className="text-lg md:text-xl leading-relaxed text-foreground text-right" dir="rtl">
          {block.contentAr}
        </p>
      )}
      {block.content && (
        <div className="p-6 bg-secondary/50 rounded-2xl border border-border">
          <p className="text-xl md:text-2xl leading-relaxed text-foreground font-serif text-left" dir="ltr">
            {block.content}
          </p>
        </div>
      )}
      {isUsableUrl(block.audioUrl) ? (
        <AudioWidget url={block.audioUrl!} label={block.audioNote ?? undefined} />
      ) : (
        /* Audio attached through the CMS picker is stored as a media id, not a
           URL — reading and pronunciation blocks both reach the student here. */
        <BlockMedia mediaId={block.referenceMediaId} kind="audio" />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Audio placeholder block
// ──────────────────────────────────────────────────────────────────────
function AudioPlaceholderBlock({ block }: { block: ContentBlock }) {
  return (
    <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
      <BlockHeader block={block} />
      <BlockIllustration block={block} />
      {isUsableUrl(block.audioUrl) ? (
        <AudioWidget url={block.audioUrl!} label={block.audioNote ?? "استمع للمقطع الصوتي"} />
      ) : block.referenceMediaId ? (
        /* Uploaded through the CMS picker: playable only via a signed URL. */
        <BlockMedia mediaId={block.referenceMediaId} kind="audio" />
      ) : (
        <Card className="border-border">
          <CardContent className="p-8 flex flex-col items-center justify-center text-center">
            <PlayCircle className="h-16 w-16 text-primary mb-4" />
            <h3 className="text-xl font-bold mb-2">استمع للمقطع الصوتي</h3>
            {block.audioNote && (
              <p className="text-sm text-muted-foreground mt-2">{block.audioNote}</p>
            )}
          </CardContent>
        </Card>
      )}
      {block.contentAr && (
        <p className="text-lg leading-relaxed text-foreground" dir="rtl">{block.contentAr}</p>
      )}
      {block.content && (
        <p className="text-lg leading-relaxed text-foreground font-serif" dir="ltr">{block.content}</p>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Main Lesson Component
// ──────────────────────────────────────────────────────────────────────
export default function Lesson({ params }: { params: { lessonId: string } }) {
  const lessonId = parseInt(params.lessonId, 10);
  const { data: lesson, isLoading, error } = useGetLesson(lessonId);
  const startLesson = useStartLesson();
  const submitActivity = useSubmitLessonActivity();
  const completeLesson = useCompleteLesson();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // All hooks must be unconditional
  const [currentBlockIndex, setCurrentBlockIndex] = useState(0);
  /** Which question of a multi-question block is on screen. */
  const [questionIndex, setQuestionIndex] = useState(0);
  const [blockStates, setBlockStates] = useState<Record<number, BlockState>>({});
  const [finishResult, setFinishResult] = useState<LessonProgress | null>(null);
  const [startTime] = useState(Date.now());
  const initialized = useRef(false);

  useEffect(() => {
    if (lesson && !initialized.current) {
      initialized.current = true;
      startLesson.mutate({ lessonId });
    }
  // startLesson is stable (from useMutation), lessonId is a primitive
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson, lessonId]);

  // ── Loading / error guards ────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6 mt-10">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !lesson) {
    return (
      <div className="p-8 text-center mt-20">
        <h2 className="text-xl font-bold text-destructive mb-4">حدث خطأ في تحميل الدرس</h2>
        <Link href="/learn">
          <Button>العودة للمنهج</Button>
        </Link>
      </div>
    );
  }

  const blocks = lesson.contentBlocks ?? [];
  const currentBlock = blocks[currentBlockIndex] ?? null;
  const isLastBlock = currentBlockIndex === blocks.length - 1;
  const progress = blocks.length > 0 ? ((currentBlockIndex + 1) / blocks.length) * 100 : 100;

  // ── Per-block helpers ──────────────────────────────────────────────
  const getBlockState = (blockId: number): BlockState =>
    blockStates[blockId] ?? { submitted: false, submitting: false, result: null };

  // Patches merge onto `prev`, never onto the render-time `blockStates`.
  // A finished recording calls this twice in the same tick — once to record
  // that audio exists, once to start the upload — and reading the stale
  // snapshot meant the second call overwrote `hasRecording` with the value
  // from before the first. Continue then refused a recording that had in fact
  // uploaded fine.
  const setBlockField = (blockId: number, patch: Partial<BlockState>) => {
    setBlockStates(prev => ({
      ...prev,
      [blockId]: {
        ...(prev[blockId] ?? { submitted: false, submitting: false, result: null }),
        ...patch,
      },
    }));
  };

  // ── Submit a single block via API ──────────────────────────────────
  const doSubmitBlock = (block: ContentBlock, extraPatch?: Partial<BlockState>) => {
    const st = { ...getBlockState(block.id), ...(extraPatch ?? {}) };
    setBlockField(block.id, { submitting: true });

    const payload: {
      clientSubmissionId: string;
      exerciseId?: number;
      selectedOptionId?: string;
      responseText?: string;
      recordingDurationSeconds?: number;
      mediaId?: number;
    } = { clientSubmissionId: genClientId() };

    if (block.type === "mcq" && st.selectedOptionId) {
      payload.selectedOptionId = st.selectedOptionId;
      // Name the question when the block holds more than one, or the server
      // would grade the answer against the first every time.
      const q = block.questions?.[questionIndex];
      if (q) payload.exerciseId = q.exerciseId;
    } else if (block.type === "open_ended") {
      // Either form counts, and an open-ended answer can be spoken: the server
      // transcribes the recording into the same answer a typed one would have
      // been. Sending only `responseText` dropped a voice answer on the floor —
      // the attempt arrived with nothing attached, so there was nothing to
      // grade and it sat pending for a teacher who had no recording either.
      if (st.responseText) payload.responseText = st.responseText;
      if (st.recordingDurationSeconds !== undefined) {
        payload.recordingDurationSeconds = st.recordingDurationSeconds;
      }
      if (st.mediaId !== undefined) payload.mediaId = st.mediaId;
    } else if (
      (block.type === "speaking_prompt" || block.type === "pronunciation_guide") &&
      st.recordingDurationSeconds !== undefined
    ) {
      payload.recordingDurationSeconds = st.recordingDurationSeconds;
      // Only sent once the upload was confirmed; the server rejects an id that
      // is not a finished recording of this student's.
      if (st.mediaId !== undefined) payload.mediaId = st.mediaId;
    }
    // passive blocks: just clientSubmissionId

    submitActivity.mutate(
      { lessonId, blockId: block.id, data: payload },
      {
        onSuccess: (result) => {
          setBlockField(block.id, { submitted: true, submitting: false, result });
          // Invalidate lesson detail so completedBlockIds updates
          queryClient.invalidateQueries({ queryKey: getGetLessonQueryKey(lessonId) });

          // A recording is assessed in the background, so the submit response
          // can only say "pending". Without this the student would record,
          // upload, and never find out how they did.
          if (result.evaluationStatus === "pending" && payload.mediaId !== undefined) {
            setBlockField(block.id, { awaitingVerdict: true });
            void pollAttemptVerdict(lessonId, result.attemptId).then((verdict) => {
              setBlockField(block.id, {
                awaitingVerdict: false,
                ...(verdict ? { speechVerdict: verdict } : {}),
              });
            });
          }
        },
        onError: () => {
          setBlockField(block.id, { submitting: false });
          toast({
            variant: "destructive",
            title: "خطأ",
            description: "تعذّر إرسال إجابتك، حاول مجدداً.",
          });
        },
      }
    );
  };

  // ── "Continue" button handler ──────────────────────────────────────
  const handleContinue = () => {
    if (!currentBlock) {
      moveNext();
      return;
    }

    const st = getBlockState(currentBlock.id);

    // If already submitted, just move
    if (st.submitted) {
      moveNext();
      return;
    }

    // Validate required fields before submitting
    if (currentBlock.isRequired) {
      if (currentBlock.type === "mcq" && !st.selectedOptionId) {
        toast({ variant: "destructive", title: "الرجاء اختيار إجابة أولاً" });
        return;
      }
      if (currentBlock.type === "open_ended") {
        // Either form counts: the server transcribes a recording into the same
        // answer a typed one would have been.
        const typed = (st.responseText ?? "").trim() !== "";
        if (!typed && !st.hasRecording) {
          toast({ variant: "destructive", title: "الرجاء كتابة إجابة أو تسجيلها أولاً" });
          return;
        }
      }
      if (
        (currentBlock.type === "speaking_prompt" || currentBlock.type === "pronunciation_guide") &&
        !st.hasRecording
      ) {
        toast({ variant: "destructive", title: "الرجاء تسجيل إجابة صوتية أولاً" });
        return;
      }
    }

    doSubmitBlock(currentBlock);
  };

  const moveNext = () => {
    // Work through the questions on this block before leaving it.
    const total = currentBlock?.questions?.length ?? 0;
    if (total > 1 && questionIndex < total - 1) {
      setQuestionIndex(i => i + 1);
      // Each question collects its own answer, so clear the previous verdict.
      setBlockField(currentBlock.id, {
        submitted: false, submitting: false, result: null, selectedOptionId: undefined,
      });
      return;
    }
    setQuestionIndex(0);
    if (isLastBlock) {
      handleFinish();
    } else {
      setCurrentBlockIndex(prev => prev + 1);
    }
  };

  // After submission the user clicks Continue again to advance.
  // Goes through moveNext so a block holding several questions steps to the
  // next question rather than jumping straight out of the block.
  const handleContinueAfterSubmit = () => {
    moveNext();
  };

  // ── Finish lesson ──────────────────────────────────────────────────
  const handleFinish = () => {
    const timeSpentSeconds = Math.floor((Date.now() - startTime) / 1000);
    completeLesson.mutate(
      { lessonId, data: { timeSpentSeconds } },
      {
        onSuccess: async (data) => {
          // Invalidate everything that might reference this lesson's state
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetLevelsQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetLevelQueryKey(lesson.levelId) }),
            queryClient.invalidateQueries({ queryKey: getGetLessonQueryKey(lessonId) }),
            queryClient.invalidateQueries({ queryKey: getGetLessonsQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getGetLessonProgressQueryKey(lessonId) }),
          ]);
          setFinishResult(data);
        },
        onError: (err: unknown) => {
          // 422 — missing required blocks
          const apiError = err as { status?: number; data?: LessonCompletionError };
          if (apiError?.status === 422 && apiError?.data?.missingRequiredBlockIds) {
            const ids = apiError.data.missingRequiredBlockIds;
            const missing = blocks.filter(b => ids.includes(b.id));
            const names = missing.map(b => b.titleAr || b.title || `بلوك #${b.id}`).join("، ");
            toast({
              variant: "destructive",
              title: "الدرس غير مكتمل",
              description: `يجب إكمال: ${names}`,
            });
            // Navigate to first missing block
            const firstMissingIdx = blocks.findIndex(b => ids.includes(b.id));
            if (firstMissingIdx >= 0) setCurrentBlockIndex(firstMissingIdx);
          } else {
            toast({
              variant: "destructive",
              title: "خطأ",
              description: "لم نتمكن من حفظ نتيجتك. تأكد من اتصالك بالإنترنت.",
            });
          }
        },
      }
    );
  };

  // ── Finish screen ──────────────────────────────────────────────────
  if (finishResult) {
    const score = finishResult.lastScore ?? finishResult.bestScore ?? 0;
    const passed = finishResult.passed;
    const xpEarned = finishResult.xpEarned;

    return (
      <div dir="rtl" className="min-h-[100dvh] flex items-center justify-center p-4 bg-background">
        <Card className="max-w-lg w-full text-center shadow-xl border-t-8 border-t-primary">
          <CardContent className="pt-10 pb-8 px-6 space-y-6">
            <div className={`h-24 w-24 rounded-full flex items-center justify-center mx-auto mb-4 ${passed ? 'bg-emerald-100' : 'bg-rose-100'}`}>
              {passed ? (
                <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              ) : (
                <XCircle className="h-12 w-12 text-rose-500" />
              )}
            </div>

            <h2 className="text-3xl font-bold text-foreground">
              {passed ? "أحسنت العمل!" : "حاول مرة أخرى"}
            </h2>

            <div className="flex justify-center gap-8 py-6">
              <div className="text-center">
                <div className="text-4xl font-bold text-foreground mb-1" dir="ltr">{score}%</div>
                <div className="text-sm text-muted-foreground">النتيجة</div>
              </div>
              <div className="w-px bg-border"></div>
              <div className="text-center">
                <div className="text-4xl font-bold text-amber-500 mb-1" dir="ltr">+{xpEarned}</div>
                <div className="text-sm text-muted-foreground">XP</div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 pt-4">
              <Button
                onClick={() => setLocation(`/learn/${lesson.levelId}`)}
                className="flex-1 h-14 text-lg rounded-xl"
              >
                الاستمرار
              </Button>
              {lesson.isCompleted && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setFinishResult(null);
                    setCurrentBlockIndex(0);
                  }}
                  className="flex-1 h-14 text-lg rounded-xl"
                >
                  مراجعة الدرس
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Determine if Continue is disabled ─────────────────────────────
  const currentState = currentBlock ? getBlockState(currentBlock.id) : null;
  const isSubmitting = currentState?.submitting ?? false;
  const isAlreadySubmitted = currentState?.submitted ?? false;

  // Continue is disabled during submit or if MCQ required and nothing selected yet
  let isContinueDisabled = isSubmitting || completeLesson.isPending;
  if (currentBlock && !isAlreadySubmitted && !isSubmitting) {
    if (currentBlock.type === "mcq" && currentBlock.isRequired && !currentState?.selectedOptionId) {
      isContinueDisabled = true;
    }
    // Submitting mid-upload sends the attempt without its recording, and the
    // answer is then unrecoverable: the upload finishes into state nobody reads
    // again. The wait is the length of one upload and the button says why.
    if (currentState?.uploading) {
      isContinueDisabled = true;
    }
  }

  /**
   * Blocks that ask the student to DO something, so an optional one needs a way
   * past it. Truly passive blocks — a reading passage, a vocabulary list — are
   * left out because their "متابعة" already advances and a second button
   * offering to skip reading would be noise.
   *
   * `dialogue` belongs here even though the server records it as a passive
   * attempt: it carries the AI tutor, so an optional conversation a student does
   * not want to have was a dead end — the only button on screen submitted the
   * block and started the tutor.
   */
  const SKIPPABLE_TYPES = [
    "mcq",
    "open_ended",
    "speaking_prompt",
    "pronunciation_guide",
    "dialogue",
  ];
  const canSkipCurrentBlock =
    !!currentBlock &&
    !currentBlock.isRequired &&
    !isAlreadySubmitted &&
    SKIPPABLE_TYPES.includes(currentBlock.type);

  // Label for continue button
  const continueLabel = () => {
    if (completeLesson.isPending || isSubmitting) {
      return <Loader2 className="h-5 w-5 animate-spin" />;
    }
    // Questions left on this block means Continue, even on the last block —
    // otherwise it offers to finish the lesson mid-way through the questions.
    const totalQuestions = currentBlock?.questions?.length ?? 0;
    const moreQuestionsHere = totalQuestions > 1 && questionIndex < totalQuestions - 1;
    if (isLastBlock && !moreQuestionsHere) return "إنهاء الدرس";
    return "متابعة";
  };

  const handleContinueBtn = () => {
    if (isAlreadySubmitted) {
      handleContinueAfterSubmit();
    } else {
      handleContinue();
    }
  };

  // ── Block renderer ─────────────────────────────────────────────────
  const renderBlock = () => {
    if (!currentBlock) return null;
    const st = getBlockState(currentBlock.id);

    switch (currentBlock.type) {
      case "text":
      case "explanation":
      case "review":
        return <TextBlock block={currentBlock} />;

      case "dialogue":
        return (
          <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <BlockHeader block={currentBlock} />
            <BlockIllustration block={currentBlock} />
            {/* `content` is NOT shown. For a dialogue block it is the script the
                tutor follows (services/conversation.ts reads it as `script`),
                so printing it here handed the student both halves of the
                conversation — their own lines included — before they said a
                word. The prompt below, and the tutor itself, are the exercise.
                The Arabic field is the translation OF that script, so it is
                withheld for the same reason. */}
            {isUsableUrl(currentBlock.audioUrl) && <AudioWidget url={currentBlock.audioUrl!} label={currentBlock.audioNote ?? undefined} />}

            {/* The tutor itself. Bounded by the block's configuration — the
                student sees the remaining turns and minutes throughout. */}
            <ConversationBlock
              lessonId={lessonId}
              blockId={currentBlock.id}
              prompt={currentBlock.promptAr ?? currentBlock.prompt}
            />
          </div>
        );

      case "pronunciation_guide":
        // Read-aloud: listen to the reference, then record an attempt.
        return (
          <SpeakingBlock
            block={currentBlock}
            state={st}
            onRecordingDone={(dur) => setBlockField(currentBlock.id, { recordingDurationSeconds: dur, hasRecording: true })}
            onUploadState={(patch) => setBlockField(currentBlock.id, patch)}
          />
        );

      case "spelling":
        return (
          <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <BlockHeader block={currentBlock} />
            {currentBlock.contentAr && (
              <p className="text-lg leading-relaxed text-foreground" dir="rtl">{currentBlock.contentAr}</p>
            )}
            {/* The CMS labels this field "Word to spell" and saves it to
                `prompt`; `content` is the older home for the same thing. In a
                lesson this block teaches the word rather than testing it — the
                quiz player is where spelling is answered blind — so showing it
                is the point. */}
            {(currentBlock.content || currentBlock.prompt) && (
              <div className="p-6 bg-secondary/50 rounded-2xl border border-border text-center">
                <p className="text-4xl font-bold font-serif tracking-widest" dir="ltr">
                  {currentBlock.content || currentBlock.prompt}
                </p>
              </div>
            )}
            <BlockIllustration block={currentBlock} />
            {isUsableUrl(currentBlock.audioUrl) && <AudioWidget url={currentBlock.audioUrl!} label={currentBlock.audioNote ?? undefined} />}
          </div>
        );

      case "vocabulary_list":
        return <VocabularyBlock block={currentBlock} />;

      case "mcq":
        return (
          <McqBlock
            block={currentBlock}
            state={st}
            questionIndex={questionIndex}
            onSelect={(optionId) => setBlockField(currentBlock.id, { selectedOptionId: optionId })}
          />
        );

      case "open_ended":
        return (
          <OpenEndedBlock
            block={currentBlock}
            state={st}
            onChange={(text) => setBlockField(currentBlock.id, { responseText: text })}
            onRecordingDone={(dur) =>
              setBlockField(currentBlock.id, {
                recordingDurationSeconds: dur,
                hasRecording: true,
              })
            }
            onUploadState={(patch) => setBlockField(currentBlock.id, patch)}
          />
        );

      case "speaking_prompt":
        // Both record. The difference is on the server: a pronunciation block
        // carries a set passage, so the transcript is aligned against it for an
        // accuracy score; an open speaking prompt is scored on fluency alone.
        return (
          <SpeakingBlock
            block={currentBlock}
            state={st}
            onRecordingDone={(dur) => setBlockField(currentBlock.id, { recordingDurationSeconds: dur, hasRecording: true })}
            onUploadState={(patch) => setBlockField(currentBlock.id, patch)}
          />
        );

      case "audio_placeholder":
        return <AudioPlaceholderBlock block={currentBlock} />;

      default:
        return (
          <div className="space-y-4">
            <BlockHeader block={currentBlock} />
            <BlockIllustration block={currentBlock} />
            <p className="text-muted-foreground text-sm">نوع المحتوى: {currentBlock.type}</p>
          </div>
        );
    }
  };

  // ── Layout ─────────────────────────────────────────────────────────
  return (
    <div dir="rtl" className="min-h-[100dvh] flex flex-col bg-background">
      {/* Top Bar */}
      <header className="h-16 border-b border-border flex items-center px-4 md:px-8 shrink-0">
        <Link href={`/learn/${lesson.levelId}`}>
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowRight className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1 mx-4">
          <Progress value={progress} className="h-2" />
        </div>
        <span className="text-sm text-muted-foreground shrink-0">
          {currentBlockIndex + 1}/{blocks.length}
        </span>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        {/* Bottom padding clears the fixed controls — and on mobile the bottom
            nav underneath them too, or the last option cannot be scrolled to. */}
        <div className="max-w-2xl mx-auto w-full p-4 md:p-8 pb-56 md:pb-40">
          {blocks.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground">لا يوجد محتوى في هذا الدرس بعد.</div>
          ) : (
            renderBlock()
          )}
        </div>
      </main>

      {/* Bottom Bar */}
      {/* The sidebar is on the RIGHT (the UI is RTL), so the bar must be inset
          from the right on desktop — md:left-64 pushed it under the sidebar.
          On mobile it sits above the 16-unit bottom nav rather than beneath it. */}
      <div className="fixed bottom-16 md:bottom-0 left-0 right-0 md:right-64 p-4 border-t border-border bg-card/80 backdrop-blur-md shrink-0 z-10">
        <div className="max-w-2xl mx-auto w-full flex justify-between items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => { setQuestionIndex(0); setCurrentBlockIndex(prev => prev - 1); }}
            disabled={currentBlockIndex === 0 || isSubmitting}
            className="text-muted-foreground"
          >
            السابق
          </Button>

          {/* Without this an unanswered optional activity is a dead end. */}
          {canSkipCurrentBlock && (
            <Button
              variant="outline"
              size="lg"
              onClick={moveNext}
              disabled={isSubmitting || completeLesson.isPending}
              className="h-14 rounded-xl"
            >
              تخطي
            </Button>
          )}

          <Button
            size="lg"
            className="flex-1 md:flex-none md:w-48 h-14 rounded-xl text-lg font-bold shadow-md"
            onClick={handleContinueBtn}
            disabled={isContinueDisabled}
          >
            {continueLabel()}
          </Button>
        </div>
      </div>
    </div>
  );
}
