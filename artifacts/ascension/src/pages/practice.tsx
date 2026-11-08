/**
 * Voice practice with another learner (spec section 11).
 *
 * The screen has five states and each one has to be honest about something:
 *
 *   preferences  Opting in is a decision, so it is made once, deliberately,
 *                next to the sentence explaining that calls are live, with a
 *                stranger, and not recorded.
 *   searching    An empty pool is normal in a small product. It says "nobody is
 *                available right now", not "error".
 *   ringing      Both people see who they were matched with and why, and either
 *                can say no without explaining.
 *   in call      Ending is one tap with no confirmation. Blocking and reporting
 *                are on this screen, not buried in a menu afterwards, because
 *                someone who needs to report something wants out now.
 *   failed       Without a TURN relay some calls cannot connect at all. The
 *                screen says that plainly instead of spinning forever.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  practiceApi,
  PracticeError,
  type PracticePreferences,
  type PracticeSessionView,
  type ReportReason,
  type CallEvaluation,
} from "@/lib/practice-api";
import { useVoiceCall } from "@/hooks/use-voice-call";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type Lang } from "@/lib/i18n";
import {
  Mic,
  MicOff,
  PhoneOff,
  Phone,
  Loader2,
  ShieldAlert,
  Ban,
  Users,
  Info,
  X,
} from "lucide-react";

const POLL_MS = 1000;

const REPORT_REASONS: ReportReason[] = ["harassment", "inappropriate", "spam", "language", "other"];

const EMPTY_PREFERENCES: PracticePreferences = {
  isAvailable: false,
  goals: [],
  interests: [],
  professionalField: null,
  availableHours: [],
};

/** Comma-separated text ↔ tag list, the simplest input that fits both languages. */
const toTags = (text: string) =>
  text
    .split(/[,،]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

/** Joins tags for display and editing, with the comma of the UI language. */
const fromTags = (tags: string[], lang: Lang) => tags.join(lang === "ar" ? "، " : ", ");

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * How far along each status is, so a stale poll cannot move the card backwards.
 * Terminal states rank highest: nothing supersedes them.
 */
const STATUS_ORDER: Record<CallEvaluation["status"], number> = {
  requested: 1,
  consented: 2,
  uploaded: 3,
  analyzing: 4,
  completed: 5,
  declined: 5,
  failed: 5,
  expired: 5,
};

/** Evaluation polling: quick while something is about to change, slow otherwise. */
const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 15_000;
const FAST_POLL_WINDOW_MS = 3 * 60_000;

export default function Practice() {
  const { toast } = useToast();
  const { t, lang } = useI18n();
  const pr = t.practice;
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["practice-profile"],
    queryFn: () => practiceApi.getProfile(),
  });

  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState<PracticeSessionView | null>(null);
  const [queued, setQueued] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [secondsWaiting, setSecondsWaiting] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);

  const call = useVoiceCall();
  const startedForRef = useRef<number | null>(null);

  // ── Opt-in evaluation ──────────────────────────────────────────────────────
  //
  // Recording has to begin DURING the call — there is no recording afterwards to
  // reach for, by design. So asking for feedback mid-call starts the recorder,
  // and the request itself is only created when the call ends and there is
  // something to submit. The other student is asked separately, and nothing is
  // uploaded until they agree.
  const [wantsEvaluation, setWantsEvaluation] = useState(false);
  const [evaluation, setEvaluation] = useState<CallEvaluation | null>(null);
  const [pendingConsent, setPendingConsent] = useState<CallEvaluation | null>(null);
  const [uploading, setUploading] = useState(false);
  /**
   * The real "is a request in flight" guard.
   *
   * It cannot be the `uploading` STATE: that state was both a dependency of the
   * effects below and set by them, so `setUploading(true)` changed the deps,
   * React ran the cleanup, `cancelled` became true, and the `finally` then
   * skipped clearing the flag — leaving the screen on "Sending…" forever
   * while no request had been made at all. A ref does not re-trigger the effect,
   * so the guard and the display are kept separate.
   */
  const inFlightRef = useRef(false);
  /**
   * Whether the page is still mounted, for the async work in the effects below.
   *
   * NOT a per-effect `cancelled` flag. Those effects depend on `call`, which is
   * a new object on every render, so their own `setUploading(true)` re-ran them
   * and marked the request already in flight as cancelled. Its result was then
   * thrown away: a created request never reached the card (and was sent again,
   * to be refused as a duplicate), and a failed upload never said so — the card
   * sat on "sending" with nothing happening.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /**
   * Until when evaluations are polled quickly. Raised whenever the other side
   * may act any second — a call just ended, or an evaluation moved a step — and
   * bounded, so a request nobody answers does not poll every two seconds for
   * the life of the page. Bumping `pollBoost` restarts the loop at once.
   */
  const fastPollUntilRef = useRef(0);
  const [pollBoost, setPollBoost] = useState(0);
  const boostPolling = useCallback(() => {
    fastPollUntilRef.current = Date.now() + FAST_POLL_WINDOW_MS;
    setPollBoost((n) => n + 1);
  }, []);
  /**
   * Evaluation ids whose upload has already been attempted.
   *
   * Without this the upload effect is an unbounded retry loop: the `catch`
   * swallows the failure and the `finally` releases the in-flight guard, but
   * `status` is still `consented` and the blob is still in memory — so the
   * effect's own conditions are met again and it fires immediately. One failed
   * upload became 104 requests in a few seconds, which exhausted the student's
   * rate-limit budget and locked them out of logging in.
   *
   * One attempt per evaluation. A retry is a deliberate action, not a spin.
   */
  const uploadAttemptedRef = useRef<Set<number>>(new Set());
  /**
   * Evaluations the student has dismissed with "Hide".
   *
   * Dismissing only cleared local state, so the next 15-second poll re-selected
   * the same finished evaluation and the card reappeared — and because it was
   * still occupying the card, a NEW call's result had nowhere to go. Remembered
   * here so a dismissal sticks for the life of the page.
   */
  const dismissedRef = useRef<Set<number>>(new Set());
  const endedSessionRef = useRef<PracticeSessionView | null>(null);

  /** Mid-call: start capturing both voices, or say plainly that we cannot. */
  const askForEvaluation = () => {
    if (call.startRecording()) {
      setWantsEvaluation(true);
      toast({
        title: pr.willRecord,
        description: pr.willRecordBody,
      });
    } else {
      toast({
        variant: "destructive",
        title: pr.recordUnsupported,
        description: pr.recordUnsupportedBody,
      });
    }
  };

  /** Any request waiting on THIS student's answer, found on load and on poll. */
  const refreshEvaluations = useCallback(async () => {
    try {
      const { evaluations } = await practiceApi.listEvaluations();
      setPendingConsent(evaluations.find((e) => e.awaitingYourConsent) ?? null);
      // Keep whichever of our own is still in flight, so the result appears
      // without the student having to go looking for it.
      setEvaluation((prev) => {
        // A finished evaluation is history. Re-adopting one keeps the card
        // showing an old call's feedback and leaves no room for the next one;
        // only work still in progress is worth pulling back in unprompted.
        // NOT limited to evaluations this student requested. Both participants
        // get their own feedback — that is the entire point of the feature —
        // and filtering on `isRequester` meant the person who consented never
        // saw a card at all, even though their feedback was sitting ready on
        // the server. The one state to leave alone is `requested`, which for
        // the other side means "you still have to answer": that is the consent
        // card's job, not this one's.
        const live = evaluations.filter(
          (e) =>
            !dismissedRef.current.has(e.id) &&
            !e.awaitingYourConsent &&
            (e.isRequester
              ? e.status === "requested" ||
                e.status === "consented" ||
                e.status === "uploaded" ||
                e.status === "analyzing" ||
                e.status === "completed"
              : // The consenting side has nothing to do while the uploader
                // uploads, but is shown where things stand: without the card
                // they saw nothing at all between agreeing and the result.
                e.status === "consented" ||
                e.status === "uploaded" ||
                e.status === "analyzing" ||
                e.status === "completed"),
        );
        const fresh =
          evaluations.find((e) => prev && e.id === prev.id && !dismissedRef.current.has(e.id)) ??
          // Newest first, so a fresh call's result supersedes an older one.
          live.sort((a, b) => b.id - a.id)[0];
        if (!fresh) return prev && dismissedRef.current.has(prev.id) ? null : prev;
        // The poll must not drag the card BACKWARDS. A 15-second poll that
        // still says `consented` was issued before the upload finished, and
        // applying it after the local state reached `uploaded` made the card
        // flip between "sending" and "sent" every poll. Later state wins.
        if (prev && prev.id === fresh.id && STATUS_ORDER[fresh.status] < STATUS_ORDER[prev.status]) {
          return prev;
        }
        return fresh;
      });
    } catch {
      // A failed poll here costs nothing; the next one catches up.
    }
  }, []);

  const profile = data?.profile ?? null;
  const limits = data?.limits;
  const optedIn = profile?.isAvailable === true;

  // ─── Polling ───────────────────────────────────────────────────────────────
  //
  // One timer covers both waiting for a partner and being in a call: the same
  // endpoint refreshes presence, delivers the pairing, and reports when the
  // other side has hung up.

  const shouldPoll = queued || session !== null;

  useEffect(() => {
    if (!shouldPoll) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const status = await practiceApi.poll();
        if (cancelled) return;
        setSession(status.session);
        setQueued(status.queued);
        setWaiting(status.waiting);
        setSecondsWaiting(status.secondsWaiting);
      } catch {
        // A dropped poll is not a dropped call; the next one catches up.
      }
    };

    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [shouldPoll]);

  // The call itself starts once, when the session becomes active on both sides.
  useEffect(() => {
    if (session?.status === "active" && startedForRef.current !== session.sessionId) {
      startedForRef.current = session.sessionId;
      void call.start({ sessionId: session.sessionId, isCaller: session.isCaller });
    }
    if (session === null || session.status === "ended" || session.status === "declined") {
      if (startedForRef.current !== null) {
        startedForRef.current = null;
        // Stop the recorder BEFORE reset tears the audio graph down, so the
        // blob is finalised rather than lost with the context.
        if (call.recording) call.stopRecording();
        call.reset();
      }
    }
  }, [session, call]);

  // Hold on to the ended call: the evaluation is requested against its id, and
  // `session` is cleared as soon as it ends.
  useEffect(() => {
    if (session?.status === "ended") {
      endedSessionRef.current = session;
      boostPolling();
    }
  }, [session, boostPolling]);

  // The recording is finished and the student asked for feedback: create the
  // request, then upload. Nothing reaches the server until the partner agrees,
  // so this only stages it.
  useEffect(() => {
    const blob = call.recordedBlob;
    const ended = endedSessionRef.current;
    // `evaluation` alone is too strong a guard: any evaluation still on screen —
    // including a COMPLETED one from an earlier call — blocked the next call's
    // request entirely, so a second call silently produced nothing. Only an
    // evaluation OF THIS CALL should stop a new request for it.
    if (!wantsEvaluation || !ended || inFlightRef.current) return;
    if (evaluation && evaluation.sessionId === ended.sessionId) return;

    // The call is over and the recorder has stopped, but produced nothing. Say
    // so: silently doing nothing here is indistinguishable from the feature
    // being broken, and that is precisely how the first version failed.
    if (!blob) {
      if (!call.recording && call.phase !== "connected") {
        setWantsEvaluation(false);
        toast({
          variant: "destructive",
          title: pr.notRecorded,
          description: pr.notRecordedBody,
        });
      }
      return;
    }

    inFlightRef.current = true;
    setUploading(true);
    void (async () => {
      try {
        const { evaluation: created } = await practiceApi.requestEvaluation(ended.sessionId);
        if (!mountedRef.current) return;
        setEvaluation(created);
        toast({
          title: pr.requestSent,
          description: pr.requestSentBody,
        });
      } catch (err) {
        if (!mountedRef.current) return;
        // Both students asked for the same call. Only one request can exist, so
        // the loser is not in an error state — they are the person being asked
        // to consent, and the consent card is already on its way to them from
        // the poll. Telling them something failed would be wrong.
        if (err instanceof PracticeError && err.code === "ALREADY_REQUESTED") {
          setWantsEvaluation(false);
          // Their own recording is redundant: the other side is uploading theirs.
          call.discardRecording();
          void refreshEvaluations();
          toast({
            title: pr.partnerAlsoAsked,
            description: pr.partnerAlsoAskedBody,
          });
          return;
        }
        const message =
          err instanceof PracticeError ? err.message : pr.requestFailedBody;
        toast({ variant: "destructive", title: pr.requestFailed, description: message });
        setWantsEvaluation(false);
        call.discardRecording();
      } finally {
        // Unconditional: the work really has finished.
        inFlightRef.current = false;
        setUploading(false);
      }
    })();

    // `uploading` is deliberately NOT a dependency: it is set inside this
    // effect, so depending on it makes the effect cancel itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, wantsEvaluation, evaluation, toast, refreshEvaluations]);

  // Once both sides have agreed the server moves the row to `consented`, which
  // is the signal that audio may finally be sent.
  useEffect(() => {
    if (evaluation?.status !== "consented") return;
    const blob = call.recordedBlob;
    if (!blob || inFlightRef.current) return;
    if (uploadAttemptedRef.current.has(evaluation.id)) return;

    // Claimed BEFORE the request, so a failure cannot re-enter here.
    uploadAttemptedRef.current.add(evaluation.id);
    inFlightRef.current = true;
    setUploading(true);
    void (async () => {
      try {
        const begun = await practiceApi.beginRecordingUpload(evaluation.id, {
          contentType: blob.type || "audio/webm",
          sizeBytes: blob.size,
          durationSec: call.recordedSeconds || null,
        });
        const put = await fetch(begun.upload.url, {
          method: "PUT",
          body: blob,
          headers: begun.upload.headers ?? { "Content-Type": blob.type || "audio/webm" },
        });
        if (!put.ok) throw new Error(`upload failed: ${put.status}`);
        const { evaluation: updated } = await practiceApi.completeRecordingUpload(
          evaluation.id,
          begun.mediaId,
          call.recordedStereo,
        );
        if (!mountedRef.current) return;
        setEvaluation(updated);
        // The audio has left the browser; there is no reason to keep a copy.
        call.discardRecording();
        toast({ title: pr.uploaded, description: pr.uploadedBody });
      } catch {
        if (mountedRef.current) {
          // The recording is deliberately NOT discarded: it is the only copy,
          // and keeping it is what makes the retry button below possible.
          toast({
            variant: "destructive",
            title: pr.uploadFailed,
            description: pr.uploadFailedBody,
          });
        }
      } finally {
        inFlightRef.current = false;
        setUploading(false);
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation, call, toast]);

  // Pick up consent requests and finished analyses. Quick for a while after a
  // call ends and after every step of an evaluation, when the other student may
  // act any second; slow the rest of the time.
  useEffect(() => {
    if (!optedIn) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      await refreshEvaluations();
      if (stopped) return;
      const fast = Date.now() < fastPollUntilRef.current;
      timer = window.setTimeout(() => void tick(), fast ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [optedIn, refreshEvaluations, pollBoost]);

  // Every step of an evaluation in progress is a moment the other side acts on.
  useEffect(() => {
    const status = evaluation?.status;
    if (status === "requested" || status === "consented" || status === "uploaded" || status === "analyzing") {
      boostPolling();
    }
  }, [evaluation?.id, evaluation?.status, boostPolling]);

  // A call the server has ended is over here too, whatever the peer connection
  // still thinks.
  useEffect(() => {
    if (!session || session.status !== "active") {
      setElapsed(0);
      return;
    }
    const started = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - started) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [session]);

  // Telling the server the connection could not be established is what turns a
  // failed call into a finished one, rather than a ghost that blocks the next.
  useEffect(() => {
    if (call.phase === "failed" && session && session.status === "active") {
      void practiceApi.end(session.sessionId, "connection_failed").catch(() => {});
    }
  }, [call.phase, session]);

  const fail = useCallback(
    (err: unknown) => {
      const message =
        err instanceof PracticeError
          ? (lang === "ar" && err.messageAr) || err.message
          : pr.genericError;
      toast({ title: pr.actionFailed, description: message, variant: "destructive" });
    },
    [toast, pr, lang],
  );

  // ─── Actions ───────────────────────────────────────────────────────────────

  const saveMut = useMutation({
    mutationFn: (prefs: PracticePreferences) => practiceApi.saveProfile(prefs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["practice-profile"] });
      setEditing(false);
      toast({ title: pr.prefsSaved });
    },
    onError: fail,
  });

  const searchMut = useMutation({
    mutationFn: () => practiceApi.joinQueue(),
    onSuccess: (r) => {
      setSession(r.session);
      setWaiting(r.waiting);
      setQueued(r.session === null);
    },
    onError: fail,
  });

  const stopSearch = async () => {
    setQueued(false);
    await practiceApi.leaveQueue().catch(() => {});
  };

  const acceptMut = useMutation({
    mutationFn: (id: number) => practiceApi.accept(id),
    onSuccess: (r) => setSession(r.session),
    onError: (err) => {
      setSession(null);
      fail(err);
    },
  });

  /** Immediate and unilateral. The peer connection closes before the request. */
  const endCall = (reason: "ended_by_user" | "declined" = "ended_by_user") => {
    const id = session?.sessionId;
    // Remember the call before `session` is cleared. The effect that captures
    // this only fires on a status of "ended", which arrives from the server on
    // the NEXT poll — and this clears `session` before that poll happens, so
    // hanging up yourself never recorded the call the evaluation is requested
    // against. The partner hanging up went through the poll and did work, which
    // is what made this look intermittent.
    if (session && reason !== "declined") endedSessionRef.current = session;
    call.hangUp();
    setSession(null);
    setQueued(false);
    if (id !== undefined) void practiceApi.end(id, reason).catch(() => {});
  };

  /**
   * Tell the SERVER the call is over when the page goes away.
   *
   * `useVoiceCall` already closes the peer connection on unmount, but that is
   * local only — the server went on believing the call was live. Since the
   * one-live-per-person index refuses to match anyone who is already in a call,
   * a closed tab locked BOTH students out of voice practice with "you are
   * already in a call", and the only thing that eventually freed them was the
   * sweeper, 35 minutes later.
   *
   * `sendBeacon` because a normal fetch is cancelled as the page unloads;
   * beacons are queued by the browser and survive it. `pagehide` rather than
   * `beforeunload`, which mobile Safari does not reliably fire.
   */
  useEffect(() => {
    const sessionId = session?.sessionId;
    if (sessionId === undefined) return;

    const release = () => {
      const url = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/practice/sessions/${sessionId}/end`;
      const body = JSON.stringify({ reason: "ended_by_user" });
      if (typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        // `keepalive` is the fetch equivalent, honoured during unload.
        void fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    };

    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      // Navigating away inside the app unmounts this page without a pagehide,
      // and leaves the same stuck session behind.
      release();
    };
  }, [session?.sessionId]);

  const blockPartner = async () => {
    if (!session) return;
    const { userId } = session.partner;
    const sessionId = session.sessionId;
    call.hangUp();
    setSession(null);
    setQueued(false);
    try {
      await practiceApi.block(userId, sessionId);
      toast({
        title: pr.blocked,
        description: pr.blockedBody,
      });
    } catch (err) {
      fail(err);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-10 w-56 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  const inCall = session?.status === "active";
  const ringing = session?.status === "waiting";

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6 animate-in fade-in duration-500">
      <audio ref={call.audioRef} autoPlay playsInline className="hidden" />

      <header>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
          <Mic className="h-8 w-8 text-primary" />
          {pr.title}
        </h1>
        <p className="text-muted-foreground mt-2">
          {pr.subtitle}
        </p>
      </header>

      {/* The one thing every student must know before opting in, kept on the page
          rather than in a dialog they can dismiss without reading. */}
      <PrivacyNotice />

      {ringing && session && (
        <RingingCard
          session={session}
          onAccept={() => acceptMut.mutate(session.sessionId)}
          onDecline={() => endCall("declined")}
          accepting={acceptMut.isPending}
        />
      )}

      {inCall && session && (
        <CallCard
          session={session}
          phase={call.phase}
          muted={call.muted}
          turnAvailable={call.turnAvailable}
          elapsed={elapsed}
          secondsRemaining={session.secondsRemaining}
          onToggleMute={call.toggleMute}
          onEnd={() => endCall()}
          onBlock={blockPartner}
          onReport={() => setReportOpen(true)}
          recording={call.recording}
          onAskForEvaluation={askForEvaluation}
        />
      )}

      {/* The other student asked for feedback on a call we were in. */}
      {pendingConsent && (
        <ConsentCard
          evaluation={pendingConsent}
          onAnswer={async (agree) => {
            try {
              const { evaluation: answered } = await practiceApi.respondToEvaluation(
                pendingConsent.id,
                agree,
              );
              setPendingConsent(null);
              if (agree) setEvaluation(answered);
              toast({
                title: agree ? pr.agreed : pr.declined,
                description: agree ? pr.agreedBody : pr.declinedBody,
              });
            } catch {
              toast({ variant: "destructive", title: pr.replyFailed });
            }
          }}
        />
      )}

      {/* Our own evaluation: waiting, running, or done. */}
      {evaluation && !inCall && !ringing && (
        <EvaluationCard
          evaluation={evaluation}
          uploading={uploading}
          canRetryUpload={
            // Only the uploader can retry — they hold the only copy. The blob
            // check already implies this; stated so it survives a refactor.
            evaluation.isRequester &&
            evaluation.status === "consented" &&
            call.recordedBlob !== null &&
            !uploading
          }
          onRetryUpload={() => {
            // Clearing the attempt marker lets the upload effect run once more.
            uploadAttemptedRef.current.delete(evaluation.id);
            setEvaluation({ ...evaluation });
          }}
          onDismiss={() => {
            dismissedRef.current.add(evaluation.id);
            setEvaluation(null);
            setWantsEvaluation(false);
            call.discardRecording();
          }}
        />
      )}

      {!ringing && !inCall && (
        <>
          {!optedIn || editing ? (
            <PreferencesForm
              initial={profile ?? EMPTY_PREFERENCES}
              saving={saveMut.isPending}
              onCancel={optedIn ? () => setEditing(false) : undefined}
              onSave={(prefs) => saveMut.mutate(prefs)}
            />
          ) : queued ? (
            <SearchingCard
              waiting={waiting}
              secondsWaiting={secondsWaiting}
              onCancel={stopSearch}
            />
          ) : (
            <ReadyCard
              profile={profile!}
              maxMinutes={limits?.maxCallMinutes ?? 30}
              searching={searchMut.isPending}
              onSearch={() => searchMut.mutate()}
              onEdit={() => setEditing(true)}
            />
          )}
        </>
      )}

      {session && (
        <ReportDialog
          open={reportOpen}
          partnerName={session.partner.name}
          onClose={() => setReportOpen(false)}
          onSubmit={async (reason, detail, alsoBlock) => {
            const partnerId = session.partner.userId;
            const sessionId = session.sessionId;
            call.hangUp();
            setSession(null);
            setReportOpen(false);
            try {
              await practiceApi.report({
                userId: partnerId,
                sessionId,
                reason,
                detail,
                alsoBlock,
              });
              toast({
                title: pr.reportSent,
                description: pr.reportSentBody,
              });
            } catch (err) {
              fail(err);
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function PrivacyNotice() {
  const { t } = useI18n();
  const pv = t.practice.privacy;
  return (
    <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 space-y-1.5">
      <div className="flex items-center gap-2 font-bold">
        <Info className="h-4 w-4" />
        {pv.title}
      </div>
      <ul className="list-disc ps-5 space-y-1 leading-relaxed">
        {pv.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </div>
  );
}

function PreferencesForm({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: PracticePreferences;
  saving: boolean;
  onSave: (prefs: PracticePreferences) => void;
  onCancel?: () => void;
}) {
  const { t, lang } = useI18n();
  const pf = t.practice.prefs;
  const [goals, setGoals] = useState(fromTags(initial.goals, lang));
  const [interests, setInterests] = useState(fromTags(initial.interests, lang));
  const [field, setField] = useState(initial.professionalField ?? "");
  const [hours, setHours] = useState<number[]>(initial.availableHours);
  const [agreed, setAgreed] = useState(initial.isAvailable);

  const toggleHour = (hour: number) =>
    setHours((current) =>
      current.includes(hour) ? current.filter((h) => h !== hour) : [...current, hour],
    );

  return (
    <Card className="border-2 border-border">
      <CardContent className="p-6 space-y-5">
        <div>
          <h2 className="text-lg font-bold">{pf.title}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {pf.body}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="interests">{pf.interests}</Label>
          <Input
            id="interests"
            placeholder={pf.interestsPlaceholder}
            value={interests}
            onChange={(e) => setInterests(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{pf.interestsHint}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="goals">{pf.goals}</Label>
          <Input
            id="goals"
            placeholder={pf.goalsPlaceholder}
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="field">{pf.field}</Label>
          <Input
            id="field"
            placeholder={pf.fieldPlaceholder}
            value={field}
            onChange={(e) => setField(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>{pf.hours}</Label>
          <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5" dir="ltr">
            {Array.from({ length: 24 }, (_, hour) => (
              <button
                key={hour}
                type="button"
                onClick={() => toggleHour(hour)}
                className={`h-9 rounded-md text-xs border transition-colors ${
                  hours.includes(hour)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-border hover:bg-secondary"
                }`}
              >
                {String(hour).padStart(2, "0")}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {pf.hoursHint}
          </p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border p-4">
          <Switch id="opt-in" checked={agreed} onCheckedChange={setAgreed} />
          <Label htmlFor="opt-in" className="text-sm leading-relaxed cursor-pointer">
            {pf.consent}
          </Label>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={() =>
              onSave({
                isAvailable: agreed,
                goals: toTags(goals),
                interests: toTags(interests),
                professionalField: field.trim() || null,
                availableHours: hours,
              })
            }
            disabled={saving}
          >
            {saving && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            {t.common.save}
          </Button>
          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              {t.common.cancel}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReadyCard({
  profile,
  maxMinutes,
  searching,
  onSearch,
  onEdit,
}: {
  profile: PracticePreferences;
  maxMinutes: number;
  searching: boolean;
  onSearch: () => void;
  onEdit: () => void;
}) {
  const { t, lang } = useI18n();
  const pr = t.practice;
  return (
    <Card className="border-2 border-border">
      <CardContent className="p-8 text-center space-y-5">
        <div className="mx-auto h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center">
          <Users className="h-10 w-10 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-bold">{pr.readyTitle}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {pr.readyBody(maxMinutes)}
          </p>
        </div>
        <Button size="lg" className="h-12 px-8 rounded-xl" onClick={onSearch} disabled={searching}>
          {searching ? (
            <Loader2 className="h-5 w-5 me-2 animate-spin" />
          ) : (
            <Phone className="h-5 w-5 me-2" />
          )}
          {pr.findPartner}
        </Button>
        <div className="pt-2 text-xs text-muted-foreground">
          {profile.interests.length > 0 && <span>{pr.yourInterests(fromTags(profile.interests, lang))}</span>}
          <button onClick={onEdit} className="underline ms-3 hover:text-foreground">
            {pr.editPrefs}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function SearchingCard({
  waiting,
  secondsWaiting,
  onCancel,
}: {
  waiting: number;
  secondsWaiting: number;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pr = t.practice;
  return (
    <Card className="border-2 border-primary/30">
      <CardContent className="p-8 text-center space-y-5">
        <Loader2 className="h-12 w-12 mx-auto animate-spin text-primary" />
        <div>
          <h2 className="text-xl font-bold">{pr.searching}</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {waiting > 0
              ? pr.waitingCount(waiting)
              : pr.nobodyWaiting}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {pr.waitTime(mmss(secondsWaiting))}
          </p>
        </div>
        <Button variant="outline" onClick={onCancel}>
          <X className="h-4 w-4 me-2" />
          {pr.stopSearch}
        </Button>
      </CardContent>
    </Card>
  );
}

function RingingCard({
  session,
  onAccept,
  onDecline,
  accepting,
}: {
  session: PracticeSessionView;
  onAccept: () => void;
  onDecline: () => void;
  accepting: boolean;
}) {
  const { t, lang } = useI18n();
  const pr = t.practice;
  return (
    <Card className="border-2 border-primary">
      <CardContent className="p-8 text-center space-y-5">
        <div className="mx-auto h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center animate-pulse">
          <Phone className="h-10 w-10 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-bold">{pr.found}</h2>
          <p className="text-2xl font-bold text-primary mt-2">{session.partner.name}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {session.partner.levelCode && <span dir="ltr">{session.partner.levelCode}</span>}
            {session.partner.interests.length > 0 && (
              <span> · {fromTags(session.partner.interests.slice(0, 3), lang)}</span>
            )}
          </p>
        </div>
        <div className="flex gap-3 justify-center">
          <Button size="lg" className="rounded-xl" onClick={onAccept} disabled={accepting}>
            {accepting ? (
              <Loader2 className="h-5 w-5 me-2 animate-spin" />
            ) : (
              <Phone className="h-5 w-5 me-2" />
            )}
            {pr.startCall}
          </Button>
          <Button size="lg" variant="outline" className="rounded-xl" onClick={onDecline}>
            {pr.decline}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {pr.declineNote}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The other student asked for feedback on a call we were both in.
 *
 * Deliberately blunt about what agreeing means. The recording contains this
 * student's own voice, the request came from someone they spoke to once, and a
 * vague "allow feedback?" would not be informed consent. Refusing is a plain
 * button, not a hidden link, and it is final.
 */
function ConsentCard({
  evaluation,
  onAnswer,
}: {
  evaluation: CallEvaluation;
  onAnswer: (agree: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const cs = t.practice.consent;
  const answer = (agree: boolean) => {
    setBusy(true);
    onAnswer(agree);
  };

  return (
    <Card className="border-2 border-amber-300 bg-amber-50/60">
      <CardContent className="p-6 space-y-4">
        <div className="space-y-2">
          <p className="font-bold">{cs.title}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {cs.body}
          </p>
          <ul className="text-sm text-muted-foreground list-disc ps-5 space-y-1">
            {cs.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => answer(true)}>
            {cs.agree}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => answer(false)}>
            {cs.refuse}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Our own evaluation, from "waiting for them" through to the feedback. */
function EvaluationCard({
  evaluation,
  uploading,
  canRetryUpload,
  onRetryUpload,
  onDismiss,
}: {
  evaluation: CallEvaluation;
  uploading: boolean;
  canRetryUpload: boolean;
  onRetryUpload: () => void;
  onDismiss: () => void;
}) {
  const { t, pick } = useI18n();
  const ev = t.practice.evaluation;
  const feedback = pick(evaluation.feedbackAr, evaluation.feedback);
  const summary = pick(evaluation.summaryAr, evaluation.summary);

  // Worded per side: the person who asked is waiting on their partner, while
  // the person who agreed is waiting on the uploader. The same sentence shown
  // to both would be wrong for one of them.
  const waiting: Partial<Record<CallEvaluation["status"], string>> = evaluation.isRequester
    ? {
        requested: ev.requesterRequested,
        consented: ev.requesterConsented,
        uploaded: ev.uploaded,
        analyzing: ev.analyzing,
      }
    : {
        consented: ev.partnerConsented,
        uploaded: ev.uploaded,
        analyzing: ev.analyzing,
      };

  return (
    <Card className="border-2">
      <CardContent className="p-6 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <p className="font-bold">{ev.title}</p>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {ev.hide}
          </Button>
        </div>

        {uploading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            {ev.sending}
          </p>
        )}

        {/* A spinner, not just a sentence: every one of these states moves on
            by itself, and a still line of text read as "stuck". The one
            exception is a failed upload, which waits on the button below. */}
        {waiting[evaluation.status] && !uploading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {!canRetryUpload && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            )}
            {waiting[evaluation.status]}
          </p>
        )}

        {/* The upload is attempted once. If it failed, the recording is still
            in memory and this is the only way to send it — so the way out is a
            button the student presses, not an automatic retry. */}
        {canRetryUpload && (
          <Button size="sm" variant="outline" onClick={onRetryUpload}>
            {ev.resend}
          </Button>
        )}

        {evaluation.status === "declined" && (
          <p className="text-sm text-muted-foreground">
            {evaluation.isRequester
              ? ev.declinedRequester
              : ev.declinedPartner}
          </p>
        )}

        {evaluation.status === "expired" && (
          <p className="text-sm text-muted-foreground">
            {ev.expired}
          </p>
        )}

        {evaluation.status === "failed" && (
          <p className="text-sm text-destructive">
            {evaluation.error ?? ev.failed}
          </p>
        )}

        {evaluation.status === "completed" && (
          <div className="space-y-3">
            {/* Said rather than hidden: the speakers are told apart by voice,
                not identified, so the attribution can be wrong. */}
            {evaluation.attributionUncertain && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                {ev.uncertain}
              </p>
            )}
            {feedback && (
              <div className="space-y-1">
                <p className="text-sm font-medium">{ev.aboutYou}</p>
                <p className="text-sm leading-relaxed" dir="auto">
                  {feedback}
                </p>
              </div>
            )}
            {summary && (
              <div className="space-y-1">
                <p className="text-sm font-medium">{ev.aboutCall}</p>
                <p className="text-sm text-muted-foreground leading-relaxed" dir="auto">
                  {summary}
                </p>
              </div>
            )}
            {!feedback && !summary && (
              <p className="text-sm text-muted-foreground">
                {ev.none}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CallCard({
  session,
  phase,
  muted,
  turnAvailable,
  elapsed,
  secondsRemaining,
  onToggleMute,
  onEnd,
  onBlock,
  onReport,
  recording,
  onAskForEvaluation,
}: {
  session: PracticeSessionView;
  phase: string;
  muted: boolean;
  turnAvailable: boolean;
  elapsed: number;
  secondsRemaining: number | null;
  onToggleMute: () => void;
  onEnd: () => void;
  onBlock: () => void;
  onReport: () => void;
  recording: boolean;
  onAskForEvaluation: () => void;
}) {
  const { t } = useI18n();
  const cl = t.practice.call;
  return (
    <Card className="border-2 border-primary">
      <CardContent className="p-8 space-y-6">
        <div className="text-center space-y-1">
          <p className="text-sm text-muted-foreground">{cl.talkingWith}</p>
          <p className="text-2xl font-bold">{session.partner.name}</p>
          {phase === "connected" && (
            <p className="text-lg font-mono text-primary" dir="ltr">
              {mmss(elapsed)}
            </p>
          )}
          {secondsRemaining !== null && secondsRemaining < 120 && phase === "connected" && (
            <p className="text-xs text-amber-700">
              {cl.endsIn(mmss(secondsRemaining))}
            </p>
          )}
        </div>

        <CallPhaseNotice phase={phase} turnAvailable={turnAvailable} />

        <div className="flex flex-wrap gap-3 justify-center">
          <Button
            variant={muted ? "default" : "outline"}
            size="lg"
            className="rounded-xl"
            onClick={onToggleMute}
            disabled={phase !== "connected"}
          >
            {muted ? <MicOff className="h-5 w-5 me-2" /> : <Mic className="h-5 w-5 me-2" />}
            {muted ? cl.micOff : cl.mute}
          </Button>

          {/* No confirmation dialog, deliberately: someone who needs to get out
              of a conversation should not be asked whether they are sure. */}
          <Button size="lg" variant="destructive" className="rounded-xl" onClick={onEnd}>
            <PhoneOff className="h-5 w-5 me-2" />
            {cl.end}
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 justify-center border-t border-border pt-4">
          {phase === "connected" && !recording && (
            <Button variant="ghost" size="sm" onClick={onAskForEvaluation}>
              {cl.askEvaluation}
            </Button>
          )}
          {recording && (
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
              {cl.recording}
            </span>
          )}
          <Button variant="ghost" size="sm" className="text-destructive" onClick={onReport}>
            <ShieldAlert className="h-4 w-4 me-1.5" />
            {cl.report}
          </Button>
          <Button variant="ghost" size="sm" onClick={onBlock}>
            <Ban className="h-4 w-4 me-1.5" />
            {cl.block}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The honest half of the call screen.
 *
 * "failed" is not a bug report, it is the expected outcome for roughly one pair
 * in five while the deployment has no TURN relay, and it says so.
 */
function CallPhaseNotice({ phase, turnAvailable }: { phase: string; turnAvailable: boolean }) {
  const { t } = useI18n();
  const ph = t.practice.phase;
  if (phase === "requesting-mic") {
    return (
      <p className="text-center text-sm text-muted-foreground">
        {ph.allowMic}
      </p>
    );
  }

  if (phase === "mic-denied") {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-center">
        {ph.micDenied}
      </div>
    );
  }

  if (phase === "connecting") {
    return (
      <p className="text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {ph.connecting}
      </p>
    );
  }

  if (phase === "failed") {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm space-y-2">
        <p className="font-bold">{ph.failedTitle}</p>
        <p className="leading-relaxed">
          {ph.failedBody}
          {!turnAvailable && ` ${ph.noTurn}`}
        </p>
        <p className="leading-relaxed">
          {ph.tryOther}
        </p>
      </div>
    );
  }

  return null;
}

function ReportDialog({
  open,
  partnerName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  partnerName: string;
  onClose: () => void;
  onSubmit: (reason: ReportReason, detail: string | null, alsoBlock: boolean) => void;
}) {
  const [reason, setReason] = useState<ReportReason>("inappropriate");
  const [detail, setDetail] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(true);
  const { t } = useI18n();
  const rp = t.practice.report;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-start">
          <DialogTitle>{rp.title(partnerName)}</DialogTitle>
          <DialogDescription>
            {rp.body}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{rp.reason}</Label>
            <div className="grid gap-1.5">
              {REPORT_REASONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setReason(key)}
                  className={`text-start px-3 py-2 rounded-lg border text-sm transition-colors ${
                    reason === key
                      ? "border-primary bg-primary/5 font-medium"
                      : "border-border hover:bg-secondary"
                  }`}
                >
                  {rp.reasons[key]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="detail">{rp.what}</Label>
            <Textarea
              id="detail"
              rows={4}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder={rp.whatPlaceholder}
            />
          </div>

          <div className="flex items-center gap-3">
            <Switch id="also-block" checked={alsoBlock} onCheckedChange={setAlsoBlock} />
            <Label htmlFor="also-block" className="text-sm cursor-pointer">
              {rp.alsoBlock}
            </Label>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => onSubmit(reason, detail.trim() || null, alsoBlock)}
          >
            {rp.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
