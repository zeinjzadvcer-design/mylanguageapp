/**
 * The AI conversation tutor, from the student's side.
 *
 * Spec section 4D: about ten minutes on the lesson's topic. Section 7 says the
 * duration and usage must be limited — so the remaining turns and minutes are
 * shown throughout rather than sprung on the student when it stops. A
 * conversation that ends without warning feels like a fault; one with a visible
 * budget feels like an exercise.
 *
 * The student can type or speak. Speaking reuses the recorder and the upload
 * path already built for pronunciation practice — a spoken turn is transcribed
 * and becomes the message.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useMicRecorder } from "@/hooks/use-mic-recorder";
import { useSpeech } from "@/hooks/use-speech";
import { useI18n } from "@/lib/i18n";
import { uploadRecording, MediaUploadError } from "@/lib/media-api";
import {
  startConversation,
  sendTurn,
  endConversation,
  getActiveConversation,
  ConversationError,
  type ConversationTurn,
} from "@/lib/conversation-api";
import {
  MessageSquare,
  Send,
  Mic,
  StopCircle,
  Volume2,
  VolumeX,
  SlidersHorizontal,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

/**
 * Conversations whose greeting has been read aloud, so it is read once when the
 * block opens and not again each time the student comes back to it. Kept in
 * memory for moving around the lesson and in sessionStorage for a reload.
 */
const greetedSessions = new Set<number>();
const greetedKey = (sessionId: number) => `enstep.tutorGreeting.${sessionId}`;

function wasGreeted(sessionId: number): boolean {
  if (greetedSessions.has(sessionId)) return true;
  try {
    return window.sessionStorage.getItem(greetedKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

function markGreeted(sessionId: number): void {
  greetedSessions.add(sessionId);
  try {
    window.sessionStorage.setItem(greetedKey(sessionId), "1");
  } catch {
    // Memory alone still covers moving around the lesson.
  }
}

interface Props {
  lessonId: number;
  blockId: number;
  /** What the block asks them to talk about. */
  prompt?: string | null;
}

export function ConversationBlock({ lessonId, blockId, prompt }: Props) {
  const { toast } = useToast();
  const { t } = useI18n();
  const cv = t.conversation;
  const mic = useMicRecorder();
  const speech = useSpeech();
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  /** Which tutor message is being replayed, to show it on its button. */
  const [replaying, setReplaying] = useState<number | null>(null);
  // Cleared when a new message arrives, whose own reading then takes over.
  // Not on "speech stopped": replaying one line cancels the one in flight, and
  // that cancellation reports a stop just after the new line has started.
  useEffect(() => {
    setReplaying(null);
  }, [turns.length]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Which part of the wait the student is in.
   *
   * A typed turn waits on one model call. A SPOKEN turn waits on an upload,
   * then a transcription, then the model — and until now all of that was one
   * undifferentiated spinner, so ten seconds looked identical to a hang. The
   * wait is not shortened by naming its stages, but it stops being a mystery,
   * and "Listening…" tells the student their recording arrived.
   */
  const [stage, setStage] = useState<"idle" | "uploading" | "listening" | "thinking">("idle");
  const [starting, setStarting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [turnsRemaining, setTurnsRemaining] = useState<number | null>(null);
  const [minutesRemaining, setMinutesRemaining] = useState<number | null>(null);
  const [vocabUsed, setVocabUsed] = useState<string[]>([]);
  const [targetVocab, setTargetVocab] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Reads the greeting aloud, once per conversation.
   *
   * Counted as done only when the browser actually starts speaking. After a
   * reload the browser may refuse to speak until the student has clicked
   * something; marking that attempt as done meant the greeting was never heard.
   */
  // The latest speech controller, for the delayed greeting retry below: the
  // listener is attached once, and reading `speech` from that render would
  // ignore a mute pressed in between.
  const speechRef = useRef(speech);
  speechRef.current = speech;

  const greetOnce = (id: number, text: string) => {
    if (wasGreeted(id)) return;
    speechRef.current.speak(text, () => markGreeted(id));
  };

  // Resume whatever is open, so a reload does not lose the thread.
  useEffect(() => {
    let cancelled = false;
    let retryCleanup: (() => void) | null = null;
    void getActiveConversation()
      .then(({ session }) => {
        if (cancelled || !session || session.lessonId !== lessonId) return;

        // Another dialogue part of this lesson. Only one conversation can be
        // open at a time, so one the student walked away from would block this
        // part from starting at all; it is closed, and this part starts fresh.
        // Sessions from before blocks were recorded have no block id and are
        // resumed as before.
        if (session.blockId != null && session.blockId !== blockId) {
          void endConversation(session.sessionId).catch(() => {
            // Starting will report the open conversation if this failed.
          });
          return;
        }
        setSessionId(session.sessionId);
        setTurns(session.turns);
        setTurnsRemaining(session.turnsRemaining);
        setMinutesRemaining(session.minutesRemaining);
        setVocabUsed(session.vocabularyUsed);

        // Opening the block on a conversation that has only the greeting so
        // far is the start of that conversation for the student, so the
        // greeting is read — once. Further along, it is not: the student has
        // moved on, and every line has its own replay button.
        const [first] = session.turns;
        if (session.turns.length === 1 && first?.role === "tutor") {
          const id = session.sessionId;
          greetOnce(id, first.content);
          // If the browser refused (no click yet on a freshly loaded page),
          // try again on the student's first click anywhere.
          const retry = () => greetOnce(id, first.content);
          document.addEventListener("pointerdown", retry, { once: true });
          retryCleanup = () => document.removeEventListener("pointerdown", retry);
        }
      })
      .catch(() => {
        // Not being able to resume is not worth an error; the student can start
        // a new conversation.
      });
    return () => {
      cancelled = true;
      retryCleanup?.();
    };
  // greetOnce reads the latest speech settings through a ref; re-running this
  // effect for it would refetch the conversation on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId, blockId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const reportError = (e: unknown) => {
    if (e instanceof ConversationError) {
      // 429 is their allowance, 503 is the deployment. Both are "not now",
      // neither is the student's mistake, and neither is a crash.
      if (e.status === 429 || e.status === 503) {
        setUnavailable(e.message);
        return;
      }
      toast({ title: cv.cannotContinue, description: e.message, variant: "destructive" });
      return;
    }
    toast({ title: cv.error, variant: "destructive" });
  };

  const begin = async () => {
    setStarting(true);
    setUnavailable(null);
    try {
      const r = await startConversation(lessonId, blockId);
      setSessionId(r.sessionId);
      setTurns([{ role: "tutor", content: r.greeting }]);
      greetOnce(r.sessionId, r.greeting);
      setTurnsRemaining(r.maxTurns);
      setMinutesRemaining(r.maxMinutes);
      setTargetVocab(r.targetVocabulary);
      setEnded(false);
    } catch (e) {
      reportError(e);
    } finally {
      setStarting(false);
    }
  };

  const submit = async (message: string) => {
    if (!sessionId || !message.trim()) return;
    setBusy(true);
    setStage("thinking");
    setTurns((t) => [...t, { role: "student", content: message }]);
    setDraft("");

    try {
      const r = await sendTurn(sessionId, { message });
      setTurns((t) => [...t, { role: "tutor", content: r.reply }]);
      speech.speak(r.reply);
      setTurnsRemaining(r.turnsRemaining);
      setMinutesRemaining(r.minutesRemaining);
      setVocabUsed(r.vocabularyUsed);
      if (r.ended) setEnded(true);
    } catch (e) {
      // Put the message back rather than losing what they wrote.
      setTurns((t) => t.slice(0, -1));
      setDraft(message);
      if (e instanceof ConversationError && (e.code === "TURN_LIMIT" || e.code === "TIME_LIMIT")) {
        setEnded(true);
        toast({ title: cv.endedTitle, description: e.message });
      } else {
        reportError(e);
      }
    } finally {
      setBusy(false);
      setStage("idle");
      mic.reset();
    }
  };

  // A spoken turn: upload, transcribe through the speaking path, then send the
  // transcript as the message.
  useEffect(() => {
    if (mic.status !== "done" || !mic.blob || mic.durationSec <= 0 || !sessionId) return;

    let cancelled = false;
    setBusy(true);
    setStage("uploading");

    uploadRecording(mic.blob, "lesson_activity", mic.durationSec)
      .then((r) => {
        if (cancelled) return;
        // Uploaded. What remains is transcription and then the reply — the
        // longest stretch of a spoken turn, and the part worth labelling.
        setStage("listening");
        // The server transcribes the recording and uses that as the turn — the
        // client has no way to know what was said until it comes back.
        return sendTurn(sessionId, { mediaId: r.mediaId });
      })
      .then((r) => {
        if (cancelled || !r) return;
        // Show what was actually heard, so a misheard turn is visible rather
        // than leaving the student wondering why the reply makes no sense.
        setTurns((t) => [
          ...t,
          { role: "student", content: r.transcript ?? "🎤" },
          { role: "tutor", content: r.reply },
        ]);
        speech.speak(r.reply);
        setTurnsRemaining(r.turnsRemaining);
        setMinutesRemaining(r.minutesRemaining);
        setVocabUsed(r.vocabularyUsed);
        if (r.ended) setEnded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof MediaUploadError) {
          toast({
            title: cv.uploadFailed,
            description: cv.typeInstead,
            variant: "destructive",
          });
        } else {
          reportError(e);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
          setStage("idle");
          mic.reset();
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.status, mic.blob, mic.durationSec, sessionId]);

  if (unavailable) {
    return (
      <Card className="border-2 border-amber-200 bg-amber-50">
        <CardContent className="p-5 flex gap-3">
          <AlertCircle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <p className="font-bold">{cv.unavailable}</p>
            <p>{unavailable}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!sessionId) {
    return (
      <Card className="border-2">
        <CardContent className="p-6 text-center space-y-3">
          <MessageSquare className="h-10 w-10 mx-auto text-primary" />
          <h3 className="font-bold text-lg">{cv.title}</h3>
          {prompt && <p className="text-sm text-muted-foreground">{prompt}</p>}
          <p className="text-xs text-muted-foreground">
            {cv.intro}
          </p>
          <Button onClick={begin} disabled={starting} className="rounded-xl gap-2" size="lg">
            {starting && <Loader2 className="h-4 w-4 animate-spin" />}
            {cv.start}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-2">
      <CardContent className="p-4 space-y-3">
        {/* The budget, visible throughout — section 7 requires it to be bounded,
            and a bound the student cannot see feels like a fault when it hits. */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            {cv.label}
            {/* Hidden entirely where the browser cannot speak, rather than
                shown as a control that does nothing. */}
            {speech.available && (
              <button
                type="button"
                onClick={() => speech.setEnabled(!speech.enabled)}
                title={speech.enabled ? cv.muteTutor : cv.unmuteTutor}
                aria-label={speech.enabled ? cv.muteTutor : cv.unmuteTutor}
                className="p-1 rounded-md hover:bg-secondary transition-colors"
              >
                {speech.enabled ? (
                  <Volume2
                    className={`h-3.5 w-3.5 ${speech.speaking ? "text-primary animate-pulse" : ""}`}
                  />
                ) : (
                  <VolumeX className="h-3.5 w-3.5 opacity-60" />
                )}
              </button>
            )}
            {/* Only worth offering when there is a choice to make. */}
            {speech.available && speech.voices.length > 1 && (
              <button
                type="button"
                onClick={() => setVoicePanelOpen((o) => !o)}
                title={cv.chooseVoice}
                aria-label={cv.chooseVoice}
                aria-expanded={voicePanelOpen}
                className={`p-1 rounded-md hover:bg-secondary transition-colors ${voicePanelOpen ? "bg-secondary" : ""}`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
          <span className="tabular-nums">
            {turnsRemaining !== null && cv.turnsLeft(turnsRemaining)}
            {minutesRemaining !== null && ` · ${t.common.minutes(minutesRemaining)}`}
          </span>
        </div>

        {/* The voices are the browser's own, so the list differs per device —
            and the one ranked best automatically is not always the one that
            sounds best to this student. Remembered per browser. */}
        {voicePanelOpen && (
          <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-2">
            <label className="block text-xs text-muted-foreground" htmlFor={`voice-${blockId}`}>
              {cv.voiceLabel}
            </label>
            <div className="flex gap-2">
              <select
                id={`voice-${blockId}`}
                value={speech.voiceName ?? ""}
                onChange={(e) => speech.setVoiceName(e.target.value || null)}
                className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                dir="ltr"
              >
                <option value="">{cv.voiceAuto}</option>
                {speech.voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
              <Button type="button" size="sm" variant="outline" onClick={speech.preview}>
                <Volume2 className="h-3.5 w-3.5 me-1" />
                {cv.voiceTry}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {cv.voiceHint}
            </p>
          </div>
        )}

        <div ref={scrollRef} className="max-h-80 overflow-y-auto space-y-2 ps-1">
          {turns.map((turn, i) => (
            <div
              key={i}
              className={`flex items-end gap-1 ${turn.role === "student" ? "justify-start" : "justify-end"}`}
            >
              {/* Every tutor line can be heard again: the greeting was spoken
                  once, before the student had a chance to choose a voice, and a
                  learner often needs a sentence a second time anyway. */}
              {turn.role !== "student" && speech.available && (
                <button
                  type="button"
                  onClick={() => {
                    setReplaying(i);
                    speech.replay(turn.content);
                  }}
                  title={cv.replay}
                  aria-label={cv.replay}
                  className="shrink-0 p-1.5 rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                >
                  <Volume2
                    className={`h-4 w-4 ${replaying === i && speech.speaking ? "text-primary animate-pulse" : ""}`}
                  />
                </button>
              )}
              <div
                dir="ltr"
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  turn.role === "student"
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-foreground"
                }`}
              >
                {turn.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-end">
              <div className="bg-secondary rounded-2xl px-3 py-2 flex items-center gap-2">
                {/* Three pulsing dots rather than a spinner. A spinner says
                    "loading"; dots in a chat bubble say "composing a reply",
                    which is what is actually happening and reads as shorter
                    even when it is not. */}
                <span className="flex gap-1" aria-hidden="true">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
                {/* Named stages, because a spoken turn waits on an upload, a
                    transcription and then the model — and one unlabelled
                    spinner for all three made ten seconds look like a hang. */}
                <span className="text-xs text-muted-foreground">
                  {stage === "uploading"
                    ? cv.uploading
                    : stage === "listening"
                      ? cv.listening
                      : cv.typing}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Target words they have actually used — counted, not guessed. */}
        {targetVocab.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t pt-2" dir="ltr">
            {targetVocab.map((w) => {
              const used = vocabUsed.includes(w);
              return (
                <span
                  key={w}
                  className={`text-xs font-mono px-2 py-0.5 rounded-lg border flex items-center gap-1 ${
                    used
                      ? "bg-mint-soft border-mint/40 text-mint-foreground"
                      : "bg-background text-muted-foreground"
                  }`}
                >
                  {used && <CheckCircle2 className="h-3 w-3" />}
                  {w}
                </span>
              );
            })}
          </div>
        )}

        {ended ? (
          <div className="text-center space-y-2 pt-2 border-t">
            <CheckCircle2 className="h-6 w-6 mx-auto text-mint-foreground" />
            <p className="text-sm font-medium">{cv.endedWell}</p>
            {vocabUsed.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {cv.wordsUsed(vocabUsed.length)}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-end gap-2 border-t pt-3">
            <Textarea
              dir="ltr"
              rows={2}
              value={draft}
              disabled={busy}
              placeholder="Write your reply…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit(draft);
                }
              }}
              className="rounded-xl resize-none"
            />
            <div className="flex flex-col gap-1.5">
              <Button
                size="icon"
                disabled={busy || !draft.trim()}
                onClick={() => void submit(draft)}
                className="rounded-xl"
              >
                <Send className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant={mic.status === "recording" ? "destructive" : "outline"}
                disabled={busy || mic.status === "unsupported"}
                onClick={() => (mic.status === "recording" ? mic.stop() : void mic.start())}
                className="rounded-xl"
                title={cv.speakInstead}
                aria-label={cv.speakInstead}
              >
                {mic.status === "recording" ? (
                  <StopCircle className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}

        {sessionId && !ended && (
          <button
            onClick={() => {
              void endConversation(sessionId).then(() => setEnded(true));
            }}
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
          >
            {cv.end}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
