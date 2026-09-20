/**
 * SIGHTLINE voice output.
 *
 * The backend generates speech with ElevenLabs and pushes it down the dashboard
 * websocket as { type: "voice", payload: { text, audioBase64 } }. Before this
 * module existed the payload was received and silently dropped, so SIGHTLINE
 * had never actually made a sound.
 *
 * Three things matter here:
 *   1. Browsers block audio until the user has interacted with the page, so we
 *      arm playback on the first click/keypress and report whether we're armed.
 *   2. Alerts can fire in bursts. We queue and play one at a time rather than
 *      letting three voices talk over each other.
 *   3. Some events re-emit (an emergency updates as GPS sharpens), so identical
 *      text inside a short window is treated as a repeat and skipped.
 */

export type VoicePayload = {
  ok?: boolean;
  text: string;
  audioBase64?: string;
};

export type VoiceStatus = {
  armed: boolean;
  speaking: boolean;
  lastText: string | null;
  lastAtMs: number | null;
  spokenCount: number;
  muted: boolean;
  lastError: string | null;
};

type Listener = (s: VoiceStatus) => void;

const DEDUPE_WINDOW_MS = 4000;
const MAX_QUEUE = 4;

let armed = false;
let muted = false;
let speaking = false;
let lastText: string | null = null;
let lastAtMs: number | null = null;
let spokenCount = 0;
let lastError: string | null = null;

const queue: VoicePayload[] = [];
const listeners = new Set<Listener>();
let current: HTMLAudioElement | null = null;
const recent = new Map<string, number>();

function snapshot(): VoiceStatus {
  return { armed, speaking, lastText, lastAtMs, spokenCount, muted, lastError };
}

function emit(): void {
  const s = snapshot();
  listeners.forEach((fn) => {
    try {
      fn(s);
    } catch {
      /* a broken listener must not stop audio */
    }
  });
}

export function subscribeVoice(fn: Listener): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function getVoiceStatus(): VoiceStatus {
  return snapshot();
}

export function setVoiceMuted(next: boolean): void {
  muted = next;
  if (muted) stopVoice();
  try {
    localStorage.setItem("sightline.voice.muted", muted ? "1" : "0");
  } catch {
    /* private mode */
  }
  emit();
}

export function stopVoice(): void {
  queue.length = 0;
  if (current) {
    try {
      current.pause();
      current.src = "";
    } catch {
      /* ignore */
    }
    current = null;
  }
  speaking = false;
  emit();
}

/**
 * Browsers refuse programmatic audio until the page has been interacted with.
 * We play a silent clip on the first gesture so a later alert — which arrives
 * with no gesture attached — is allowed to make noise.
 */
function armOnFirstGesture(): void {
  if (armed) return;
  const arm = () => {
    if (armed) return;
    const a = new Audio(
      // 0.05s of silence, WAV. Cheap and needs no network.
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=",
    );
    a.volume = 0;
    void a
      .play()
      .then(() => {
        armed = true;
        emit();
      })
      .catch(() => {
        // Still mark armed: the gesture happened, so the next real play is
        // very likely allowed even if this probe clip was rejected.
        armed = true;
        emit();
      });
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
  };
  window.addEventListener("pointerdown", arm, { once: false });
  window.addEventListener("keydown", arm, { once: false });
}

if (typeof window !== "undefined") {
  try {
    muted = localStorage.getItem("sightline.voice.muted") === "1";
  } catch {
    muted = false;
  }
  armOnFirstGesture();
}

function isRepeat(text: string): boolean {
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > DEDUPE_WINDOW_MS) recent.delete(k);
  const seen = recent.get(text);
  recent.set(text, now);
  return seen !== undefined && now - seen < DEDUPE_WINDOW_MS;
}

/** Queue a spoken line. Safe to call with no audio — the text still surfaces. */
export function playVoice(payload: VoicePayload | null | undefined): void {
  if (!payload || !payload.text) return;
  if (isRepeat(payload.text)) return;

  lastText = payload.text;
  lastAtMs = Date.now();

  if (!payload.audioBase64) {
    // No ElevenLabs key, or the API failed. The caption still updates so the
    // demo reads correctly and the failure is visible rather than silent.
    lastError = payload.ok === false ? "ElevenLabs returned no audio" : null;
    emit();
    return;
  }
  if (muted) {
    emit();
    return;
  }

  queue.push(payload);
  while (queue.length > MAX_QUEUE) queue.shift();
  emit();
  void drain();
}

async function drain(): Promise<void> {
  if (speaking) return;
  const next = queue.shift();
  if (!next?.audioBase64) return;

  speaking = true;
  emit();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      current = null;
      resolve();
    };

    try {
      const audio = new Audio(`data:audio/mpeg;base64,${next.audioBase64}`);
      current = audio;
      audio.onended = finish;
      audio.onerror = () => {
        lastError = "audio element failed to decode";
        finish();
      };
      // Hard ceiling so a wedged element can never block the queue forever.
      setTimeout(finish, 30000);
      void audio.play().catch((err: unknown) => {
        lastError =
          err instanceof Error && err.name === "NotAllowedError"
            ? "Browser blocked audio - click anywhere in Mission Control once"
            : "playback failed";
        armed = false;
        armOnFirstGesture();
        finish();
      });
      spokenCount += 1;
      lastError = null;
    } catch {
      lastError = "could not construct audio";
      finish();
    }
  });

  speaking = false;
  emit();
  if (queue.length) void drain();
}
