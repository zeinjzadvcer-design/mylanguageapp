/**
 * Speaking the tutor's replies aloud, using the browser's own voice.
 *
 * WHY THE BROWSER AND NOT A PROVIDER
 * ───────────────────────────────────
 * A paid text-to-speech API bills per character, and the tutor is the side that
 * talks. `speechSynthesis` ships in every browser: no account, no key, no
 * per-use cost, and it keeps working when the network does not. For a $2/month
 * plan that is the difference between the feature being free and being the
 * second-largest line on the AI bill.
 *
 * The trade is voice quality, which varies by platform. If that is judged too
 * poor later, this hook is the only place that changes — the component calls
 * `speak(text)` either way. Students can also pick another of their browser's
 * English voices and hear it first, since the one ranked best automatically is
 * not always the one that sounds best on their device.
 *
 * WHAT THE PLATFORM MAKES AWKWARD
 * ────────────────────────────────
 *   Voices load late      getVoices() is empty on first call in Chrome until
 *                         the voiceschanged event fires, so an English voice
 *                         is picked lazily rather than once on mount.
 *   Autoplay is gated     Safari and mobile Chrome refuse to speak until the
 *                         user has interacted with the page. The student has
 *                         pressed a button to start the conversation, which
 *                         satisfies it; a greeting spoken on page load would
 *                         not, and would fail silently.
 *   Utterances queue      Speaking a new reply while the last is still going
 *                         would read them back to back, so each call cancels
 *                         what is in flight.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const PREFERENCE_KEY = "enstep.tutorVoice.enabled";
/** The voice the student chose, by name. Absent means "pick the best one". */
const VOICE_KEY = "enstep.tutorVoice.name";

/**
 * Speed and pitch, by kind of voice.
 *
 * The legacy OS voices are read a little slower and lower: their flat,
 * slightly-high default is most of what makes them sound mechanical, and a
 * learner listening in a second language benefits from the slower pace.
 *
 * The neural voices are left exactly as they are. They were trained to sound
 * natural at their own speed and pitch, and bending either is what makes them
 * sound synthetic — the same 0.9 / 0.95 that softened an old voice put an
 * audible artificial drag on Aria and Google's voices.
 */
const LEGACY = { rate: 0.9, pitch: 0.95 };
const NEURAL = { rate: 1, pitch: 1 };
/** Voices scoring at or above this are neural (see VOICE_TIERS). */
const NEURAL_SCORE = 80;

/** What the preview button says. Short, natural, and in the tutor's register. */
const PREVIEW_TEXT = "Hi! I'm your tutor. Shall we practise a short conversation?";

function supported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Remembered per browser, so a student who muted the tutor stays muted. */
function loadPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    // Private windows and blocked site data both throw here.
    return true;
  }
}

/**
 * How good a voice is likely to sound, high score first.
 *
 * There is no quality field on `SpeechSynthesisVoice` — only `name`, `lang` and
 * `localService` — so the name is the only signal available. These are the
 * published names of the neural voices on each platform; anything unrecognised
 * scores 0 and still beats a voice we actively avoid.
 */
const VOICE_TIERS: Array<{ score: number; match: RegExp }> = [
  // Chrome/Edge network neural voices — the best available for free.
  { score: 100, match: /\b(aria|jenny|guy|michelle|ana)\b.*online|online.*natural/i },
  { score: 90, match: /google (us|uk) english/i },
  { score: 80, match: /\bnatural\b|\bneural\b/i },
  // Apple's better-than-default voices, shipped locally.
  { score: 70, match: /\b(ava|samantha|serena|allison|siri)\b/i },
  // Known-poor legacy voices: audibly robotic, worse than anything above.
  { score: -100, match: /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox)\b/i },
  { score: -50, match: /\b(espeak|festival|pico|flite)\b/i },
];

function voiceScore(voice: SpeechSynthesisVoice): number {
  for (const tier of VOICE_TIERS) {
    if (tier.match.test(voice.name)) return tier.score;
  }
  return 0;
}

/** Sort comparator: better voice first, en-US breaking an otherwise exact tie. */
function voicePreference(a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): number {
  const byScore = voiceScore(b) - voiceScore(a);
  if (byScore !== 0) return byScore;
  const aUs = a.lang.toLowerCase() === "en-us" ? 1 : 0;
  const bUs = b.lang.toLowerCase() === "en-us" ? 1 : 0;
  return bUs - aUs;
}

function loadVoiceName(): string | null {
  try {
    return window.localStorage.getItem(VOICE_KEY);
  } catch {
    return null;
  }
}

export interface SpeechController {
  /** False when the browser has no speech synthesis at all — hide the control. */
  available: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  speaking: boolean;
  /**
   * Says it aloud, cancelling anything still in flight. No-op when disabled.
   * `onStart` runs only if the browser actually begins speaking — not when it
   * refuses (autoplay before any click) or the tutor is muted.
   */
  speak: (text: string, onStart?: () => void) => void;
  stop: () => void;
  /** English voices this browser offers, best first. */
  voices: SpeechSynthesisVoice[];
  /** The chosen voice's name, or null for automatic (the best available). */
  voiceName: string | null;
  setVoiceName: (name: string | null) => void;
  /** Says a sample sentence in the current voice, even while muted. */
  preview: () => void;
  /**
   * Says one message again on request, even while muted: the student pressed
   * the button for it. Used to replay a tutor line — after switching voice, or
   * to hear a sentence they did not catch.
   */
  replay: (text: string) => void;
}

export function useSpeech(): SpeechController {
  const [available] = useState(supported);
  const [enabled, setEnabledState] = useState<boolean>(() => supported() && loadPreference());
  const [speaking, setSpeaking] = useState(false);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceNameState] = useState<string | null>(() =>
    supported() ? loadVoiceName() : null,
  );

  // Held in a ref so `speak` does not need to be rebuilt when a voice arrives.
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  /** Cancels a line still waiting for the voice list (see `say`). */
  const pendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!available) return;

    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      // An English voice is the point — the tutor speaks English.
      const english = voices
        .filter((v) => v.lang.toLowerCase().startsWith("en"))
        .sort(voicePreference);
      setVoices(english);
      if (english.length === 0) {
        voiceRef.current = null;
        return;
      }
      // The student's own choice wins while this browser still has it. A name
      // saved on another device, or a voice since removed, falls back to the
      // best available rather than to no voice.
      const chosen = voiceName ? english.find((v) => v.name === voiceName) : undefined;
      if (chosen) {
        voiceRef.current = chosen;
        return;
      }
      // Best available, rather than fastest to start. This used to prefer
      // `localService` to avoid the pause while a network voice is fetched, but
      // the local OS voices are the robotic ones; the network neural voices
      // ("Google US English", "Microsoft Aria Online") are the single biggest
      // quality difference available without paying a TTS provider per
      // character. The fetch costs a short delay on the first utterance only.
      voiceRef.current = english[0] ?? null;
    };

    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, [available, voiceName]);

  // Leaving the lesson mid-sentence should not keep the tutor talking — nor
  // start it talking, if a line was still waiting for the voice list.
  useEffect(() => {
    if (!available) return;
    return () => {
      pendingRef.current?.();
      window.speechSynthesis.cancel();
    };
  }, [available]);

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on);
      if (!on && supported()) {
        pendingRef.current?.();
        window.speechSynthesis.cancel();
        setSpeaking(false);
      }
      try {
        window.localStorage.setItem(PREFERENCE_KEY, on ? "1" : "0");
      } catch {
        // A remembered preference is a convenience, not a requirement.
      }
    },
    [],
  );

  /** Speaks regardless of the mute setting; `speak` and `preview` decide that. */
  const say = useCallback(
    (text: string, onStart?: () => void) => {
      if (!available) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      // A newer line replaces one still waiting, as it replaces one speaking.
      pendingRef.current?.();

      // The voice list arrives late (see the header). Speaking before it lands
      // used the browser's default voice — or nothing — so the first line of a
      // conversation, the one most likely to be spoken this early, ignored the
      // voice the student had chosen. Wait for the list, briefly: a browser
      // that never announces one still speaks, with its default.
      if (window.speechSynthesis.getVoices().length === 0) {
        let done = false;
        const settle = () => {
          done = true;
          window.speechSynthesis.removeEventListener("voiceschanged", go);
          window.clearTimeout(timer);
          if (pendingRef.current === cancel) pendingRef.current = null;
        };
        const go = () => {
          if (done) return;
          settle();
          // The picker's own voiceschanged listener was registered first, so
          // the chosen voice is in place by the time this runs.
          speakNow(trimmed, onStart);
        };
        const cancel = () => {
          if (!done) settle();
        };
        window.speechSynthesis.addEventListener("voiceschanged", go);
        const timer = window.setTimeout(go, 1500);
        pendingRef.current = cancel;
        return;
      }
      speakNow(trimmed, onStart);
    },
    [available],
  );

  /** Speaks with whatever voice is selected right now. */
  const speakNow = (trimmed: string, onStart?: () => void) => {
    window.speechSynthesis.cancel();

    const voice = voiceRef.current;
    const tuning = voice && voiceScore(voice) >= NEURAL_SCORE ? NEURAL : LEGACY;
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.lang = voice?.lang ?? "en-US";
    utterance.rate = tuning.rate;
    utterance.pitch = tuning.pitch;
    if (voice) utterance.voice = voice;

    utterance.onstart = () => {
      setSpeaking(true);
      onStart?.();
    };
    utterance.onend = () => setSpeaking(false);
    // Autoplay refusal and interruption both land here. Failing quietly is
    // right: the reply is already on screen, so the student loses nothing.
    utterance.onerror = () => setSpeaking(false);

    window.speechSynthesis.speak(utterance);
  };

  const speak = useCallback(
    (text: string, onStart?: () => void) => {
      if (enabled) say(text, onStart);
    },
    [enabled, say],
  );

  const preview = useCallback(() => say(PREVIEW_TEXT), [say]);
  const replay = useCallback((text: string) => say(text), [say]);

  const setVoiceName = useCallback((name: string | null) => {
    setVoiceNameState(name);
    try {
      if (name) window.localStorage.setItem(VOICE_KEY, name);
      else window.localStorage.removeItem(VOICE_KEY);
    } catch {
      // A remembered voice is a convenience, not a requirement.
    }
  }, []);

  const stop = useCallback(() => {
    if (!available) return;
    pendingRef.current?.();
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [available]);

  return {
    available, enabled, setEnabled, speaking, speak, stop,
    voices, voiceName, setVoiceName, preview, replay,
  };
}
