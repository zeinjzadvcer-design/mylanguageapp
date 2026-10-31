/**
 * One peer-to-peer voice call with another student.
 *
 * The audio goes browser to browser and never reaches our server. What the
 * server carries is the handshake: an SDP offer, an SDP answer and a handful of
 * ICE candidates, posted to and polled from `practice_signals`.
 *
 * WHY POLLING AND NOT A WEBSOCKET
 * ────────────────────────────────
 * There is no WebSocket anywhere in this codebase, and adding one buys a second
 * authentication path and a sticky-session problem for what is about twenty
 * small messages per call. Polling costs a second or two of setup latency and
 * nothing else — once the connection is up, no signalling happens at all.
 *
 * WHY A CALL CAN FAIL AND SAY SO
 * ───────────────────────────────
 * Without a TURN relay, two browsers behind strict NAT — mobile networks and
 * corporate firewalls, most often — cannot reach each other whatever the
 * signalling does. That is roughly one connection in five. This hook gives the
 * handshake a deadline and then reports `failed`, because the alternative is a
 * screen that says "connecting…" forever and a student who thinks the app is
 * broken.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { practiceApi, type SignalMessage } from "@/lib/practice-api";

export type CallPhase =
  | "idle"
  | "requesting-mic"
  | "mic-denied"
  | "connecting"
  | "connected"
  | "failed"
  | "ended";

interface StartOptions {
  sessionId: number;
  /** True for the side that makes the offer. Decided by the server. */
  isCaller: boolean;
}

const POLL_INTERVAL_MS = 1000;

export function useVoiceCall() {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [muted, setMuted] = useState(false);
  /** True when the server has no TURN relay configured — shown if a call fails. */
  const [turnAvailable, setTurnAvailable] = useState(true);
  /**
   * What the microphone actually does, as reported by the track rather than as
   * requested. `echoCancellation: false` means this device will send the other
   * student's voice back to them, and the screen can say so while there is
   * still something the student can do about it.
   */
  const [audioProcessing, setAudioProcessing] = useState<{
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const lastSignalIdRef = useRef(0);
  const sessionRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  /** ICE candidates that arrived before the remote description was set. */
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  // ── Optional local recording ───────────────────────────────────────────────
  // Only for the opt-in evaluation. Both voices have to be captured, and a
  // MediaRecorder takes one stream — so the two tracks are mixed through a
  // WebAudio graph first. Held in memory and dropped on reset: it becomes a
  // file only if the student asks for feedback AND the other side agrees.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mixRef = useRef<{ ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null>(
    null,
  );
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const recordStartedAtRef = useRef<number | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  /** True when the recording has local-left / remote-right channels. */
  const stereoRef = useRef(false);

  /** Tears down the WebAudio graph. Safe to call twice. */
  const closeMix = useCallback(() => {
    if (mixRef.current) {
      void mixRef.current.ctx.close().catch(() => {});
      mixRef.current = null;
    }
  }, []);

  const stopEverything = useCallback(() => {
    stoppedRef.current = true;
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    // The recorder has to be finalised BEFORE the graph it is capturing is torn
    // down, and `MediaRecorder.stop()` is asynchronous: `onstop` fires on a
    // later task. Closing the AudioContext synchronously after calling stop
    // destroyed the stream mid-flush, so `onstop` produced nothing and the
    // recording was silently lost — which is exactly what happened: the student
    // asked for feedback, the call ended, and no request was ever made because
    // the blob never arrived. So the audio graph is closed from `onstop`
    // instead, and the recorder is left to finish on its own.
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopping; `onstop` still runs and still closes the graph.
      }
    } else {
      // Nothing recording, so nothing will close the graph for us.
      closeMix();
      setRecording(false);
    }
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    remoteStreamRef.current = null;
    sessionRef.current = null;
    lastSignalIdRef.current = 0;
    pendingIceRef.current = [];
    deadlineRef.current = null;
  }, []);

  /** Hang up. Immediate and unilateral — nobody is asked to confirm. */
  const hangUp = useCallback(() => {
    stopEverything();
    setPhase("ended");
    setMuted(false);
  }, [stopEverything]);

  useEffect(() => stopEverything, [stopEverything]);

  const applySignal = useCallback(async (message: SignalMessage) => {
    const pc = pcRef.current;
    if (!pc) return;

    if (message.kind === "offer") {
      await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
      for (const candidate of pendingIceRef.current.splice(0)) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await practiceApi.sendSignal(sessionRef.current!, "answer", answer);
      return;
    }

    if (message.kind === "answer") {
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
        for (const candidate of pendingIceRef.current.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
      }
      return;
    }

    if (message.kind === "ice") {
      const candidate = message.payload as RTCIceCandidateInit;
      // A candidate that arrives before the description it belongs to is not an
      // error; it is the normal order of things on a slow poll. Hold it.
      if (!pc.remoteDescription) {
        pendingIceRef.current.push(candidate);
      } else {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
    }
  }, []);

  const start = useCallback(
    async ({ sessionId, isCaller }: StartOptions) => {
      stoppedRef.current = false;
      sessionRef.current = sessionId;
      lastSignalIdRef.current = 0;
      pendingIceRef.current = [];
      setPhase("requesting-mic");

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            // The third of the standard trio, and it was missing. Without it a
            // student who speaks quietly, or sits back from the microphone,
            // simply arrives quiet at the other end.
            autoGainControl: true,
          },
        });
      } catch {
        // Denied, or no microphone. Either way there is no call to be had, and
        // saying so is more use than retrying.
        setPhase("mic-denied");
        return;
      }
      localStreamRef.current = stream;

      /**
       * Did the browser actually apply the processing we asked for?
       *
       * A constraint passed as a plain value is a REQUEST, not a requirement:
       * a device that ignores it reports success and hands back an unprocessed
       * track. That is indistinguishable from a working one here, which is why
       * "the other person has an echo" could not be answered from logs — the
       * usual cause is a speaker feeding back into a microphone on the far
       * side, and the next suspect is echo cancellation silently not running.
       *
       * Logged rather than enforced. Demanding it with `{ exact: true }` would
       * fail the call outright on a device that cannot comply, and a call with
       * an echo beats no call at all.
       */
      const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
      const audioProcessing = {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
      };
      if (settings.echoCancellation === false) {
        console.warn(
          "[practice] Echo cancellation is NOT active on this microphone — " +
            "this device will send the other student's voice back to them. " +
            "Headphones are the fix.",
          audioProcessing,
        );
      } else {
        console.info("[practice] Microphone audio processing", audioProcessing);
      }
      setAudioProcessing(audioProcessing);

      let pc: RTCPeerConnection;
      let connectTimeoutMs = 30_000;
      try {
        const config = await practiceApi.iceServers();
        setTurnAvailable(config.hasTurn);
        connectTimeoutMs = config.connectTimeoutMs;
        pc = new RTCPeerConnection({ iceServers: config.iceServers });
      } catch {
        // A misconfigured ICE server list throws here rather than failing to
        // connect later. Either way the student gets the same honest screen
        // instead of a spinner that never resolves.
        stream.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
        setPhase("failed");
        return;
      }

      pcRef.current = pc;
      setPhase("connecting");
      deadlineRef.current = Date.now() + connectTimeoutMs;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        if (event.streams[0]) remoteStreamRef.current = event.streams[0];
        if (audioRef.current && event.streams[0]) {
          audioRef.current.srcObject = event.streams[0];
          void audioRef.current.play().catch(() => {
            // Autoplay policy. The element is on the page with controls, so the
            // student can start it themselves.
          });
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && sessionRef.current) {
          void practiceApi
            .sendSignal(sessionRef.current, "ice", event.candidate.toJSON())
            .catch(() => {});
        }
      };

      pc.onconnectionstatechange = () => {
        if (stoppedRef.current) return;
        if (pc.connectionState === "connected") {
          deadlineRef.current = null;
          setPhase("connected");
        } else if (pc.connectionState === "failed") {
          setPhase("failed");
        } else if (pc.connectionState === "disconnected") {
          // Often temporary — a phone switching networks. Give ICE a chance to
          // recover before declaring the call dead.
          deadlineRef.current = Date.now() + 10_000;
        }
      };

      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await practiceApi.sendSignal(sessionId, "offer", offer);
      }

      pollTimerRef.current = window.setInterval(async () => {
        if (stoppedRef.current) return;

        if (deadlineRef.current !== null && Date.now() > deadlineRef.current) {
          deadlineRef.current = null;
          setPhase("failed");
          return;
        }

        try {
          const { signals } = await practiceApi.readSignals(
            sessionId,
            lastSignalIdRef.current,
          );
          for (const message of signals) {
            lastSignalIdRef.current = Math.max(lastSignalIdRef.current, message.id);
            await applySignal(message);
          }
        } catch {
          // A dropped poll is not a dropped call. The next one catches up,
          // because the cursor is the highest id already seen.
        }
      }, POLL_INTERVAL_MS);
    },
    [applySignal],
  );

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }, [muted]);

  const reset = useCallback(() => {
    stopEverything();
    setPhase("idle");
    setMuted(false);
  }, [stopEverything]);

  /**
   * Start recording BOTH voices, for the opt-in evaluation only.
   *
   * Called when a student asks for feedback on a call that is still running.
   * Nothing is recorded otherwise: the feature's promise is that a call leaves
   * no file behind, so the recorder exists only while someone has asked for one.
   *
   * Returns false when the browser cannot do it, so the screen can say so
   * instead of implying a recording is being made.
   */
  const startRecording = useCallback((): boolean => {
    if (recorderRef.current) return true;
    if (typeof MediaRecorder === "undefined") return false;

    const local = localStreamRef.current;
    const remote = remoteStreamRef.current;
    if (!local || !remote) return false;

    try {
      // One MediaRecorder takes one stream, and the two voices arrive as two.
      // They are combined into one file — but into SEPARATE STEREO CHANNELS
      // rather than mixed down to mono:
      //
      //   left  = this browser's own microphone
      //   right = whatever came over the peer connection
      //
      // WHY, and this is the whole point: diarization can tell two voices
      // apart, but it cannot tell you WHICH ONE IS WHICH PERSON. Mixing to mono
      // threw away the one piece of identifying information the browser has for
      // free — it knows which track is its own. Recovering it afterwards meant
      // guessing from who spoke first, which was right about half the time, so
      // every student was shown a warning that their feedback might be about
      // the other person. Panning hard left/right keeps the answer in the file,
      // and the channel a voice lands in IS the attribution.
      const Ctx: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const localSource = ctx.createMediaStreamSource(local);
      const remoteSource = ctx.createMediaStreamSource(remote);

      // `ChannelMergerNode` rather than two stereo panners: it is older, more
      // widely supported, and says exactly what is meant — input 0 becomes the
      // left channel, input 1 the right.
      //
      // The channel count has to be asked for AT CONSTRUCTION. Assigning
      // `dest.channelCount = 2` afterwards does not reshape the MediaStreamTrack
      // the recorder reads, so the merged pair was being folded back down to one
      // channel: the file was mono, both voices on top of each other, and the
      // transcriber then reported a single speaker — "only one speaker is
      // audible" — even though the graph above looked right.
      let dest: MediaStreamAudioDestinationNode;
      let stereo = false;
      try {
        dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 2 });
        const merger = ctx.createChannelMerger(2);
        localSource.connect(merger, 0, 0);
        remoteSource.connect(merger, 0, 1);
        merger.connect(dest);
        // Verified, not assumed: the track itself has to report two channels.
        // A browser that silently gave us one must fall back rather than claim
        // an attribution it cannot support.
        const settings = dest.stream.getAudioTracks()[0]?.getSettings?.();
        stereo = (settings?.channelCount ?? dest.channelCount) >= 2;
      } catch {
        stereo = false;
        dest = ctx.createMediaStreamDestination();
      }

      if (!stereo) {
        // Mono fallback: still a usable recording of both voices, just without
        // per-channel attribution. The server is told, and reports the
        // attribution as uncertain rather than asserting a guess.
        localSource.connect(dest);
        remoteSource.connect(dest);
      }
      stereoRef.current = stereo;
      mixRef.current = { ctx, dest };

      // Opus in WebM where available: it is what the ASR provider handles best
      // and what the upload validator already accepts.
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = new MediaRecorder(dest.stream, {
        ...(mimeType ? { mimeType } : {}),
        // Opus drops to one channel at low bitrates, which would undo the
        // channel split and leave the transcriber seeing a single speaker.
        // 96 kbps is ample for two voices and still small: a 20-minute call is
        // about 14 MB, inside the upload limit.
        ...(stereo ? { audioBitsPerSecond: 96_000 } : {}),
      });

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const type = chunksRef.current[0]?.type || mimeType || "audio/webm";
        setRecordedBlob(
          chunksRef.current.length > 0 ? new Blob(chunksRef.current, { type }) : null,
        );
        setRecordedSeconds(
          recordStartedAtRef.current
            ? Math.round((Date.now() - recordStartedAtRef.current) / 1000)
            : 0,
        );
        chunksRef.current = [];
        setRecording(false);
        // Last thing out: the graph stays alive until the final chunk has been
        // flushed into the blob above.
        closeMix();
      };

      // One-second chunks, so a crash loses a second rather than the call.
      recorder.start(1000);
      recorderRef.current = recorder;
      recordStartedAtRef.current = Date.now();
      setRecording(true);
      return true;
    } catch {
      closeMix();
      return false;
    }
  }, [closeMix]);

  /** Stop early. The blob lands in `recordedBlob` via `onstop`. */
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
  }, []);

  /** Throw the recording away without uploading it. */
  const discardRecording = useCallback(() => {
    setRecordedBlob(null);
    setRecordedSeconds(0);
    chunksRef.current = [];
    recordStartedAtRef.current = null;
  }, []);

  return {
    phase,
    muted,
    turnAvailable,
    audioProcessing,
    audioRef,
    start,
    hangUp,
    toggleMute,
    reset,
    // Opt-in recording, for the evaluation flow only.
    recording,
    recordedBlob,
    recordedSeconds,
    /**
     * True when the blob carries this browser's mic on the LEFT channel and the
     * peer on the right, which makes speaker attribution exact. False means a
     * mono fallback and the server must not claim to know who is who.
     */
    recordedStereo: stereoRef.current,
    startRecording,
    stopRecording,
    discardRecording,
  };
}
