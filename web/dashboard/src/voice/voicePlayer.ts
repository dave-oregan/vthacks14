export type VoicePayload = {
  ok?: boolean;
  text: string;
  audioUrl?: string;
  audioBase64?: string;
  error?: string;
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

const DEDUPE_WINDOW_MS = 3500;
const MAX_QUEUE = 3;
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

let armed = false;
let muted = false;
let speaking = false;
let lastText: string | null = null;
let lastAtMs: number | null = null;
let spokenCount = 0;
let lastError: string | null = null;
let audioCtx: AudioContext | null = null;
let pendingBlocked: VoicePayload | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let gateAudio: HTMLAudioElement | null = null;

const queue: VoicePayload[] = [];
const listeners = new Set<Listener>();
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
      /* ignore */
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
    /* ignore */
  }
  emit();
}

export function stopVoice(): void {
  queue.length = 0;
  pendingBlocked = null;
  try {
    activeSource?.stop();
  } catch {
    /* ignore */
  }
  activeSource = null;
  speaking = false;
  emit();
}

function ensureCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Call synchronously from click handlers that trigger alerts. */
export function unlockAudio(): void {
  const ctx = ensureCtx();
  void ctx?.resume();
  if (ctx && ctx.state !== "closed") {
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
  }
  if (!gateAudio) {
    gateAudio = new Audio();
    gateAudio.preload = "auto";
  }
  gateAudio.src = SILENT_WAV;
  gateAudio.volume = 0.01;
  void gateAudio.play().then(
    () => {
      armed = true;
      lastError = null;
      emit();
      void drain();
    },
    () => {
      // Context resume alone is often enough for decode+play.
      armed = Boolean(ctx && ctx.state === "running");
      emit();
      void drain();
    },
  );
}

if (typeof window !== "undefined") {
  try {
    muted = localStorage.getItem("sightline.voice.muted") === "1";
  } catch {
    muted = false;
  }
  const arm = () => unlockAudio();
  window.addEventListener("pointerdown", arm, { passive: true, once: true });
  window.addEventListener("keydown", arm, { passive: true, once: true });
}

function isRepeat(text: string): boolean {
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > DEDUPE_WINDOW_MS) recent.delete(k);
  const seen = recent.get(text);
  recent.set(text, now);
  return seen !== undefined && now - seen < DEDUPE_WINDOW_MS;
}

export function playVoice(payload: VoicePayload | null | undefined): void {
  if (!payload?.text) return;
  if (isRepeat(payload.text)) return;
  lastText = payload.text;
  lastAtMs = Date.now();

  const hasAudio = Boolean(payload.audioUrl || payload.audioBase64);
  if (!hasAudio) {
    lastError = payload.error || (payload.ok === false ? "ElevenLabs returned no audio" : null);
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

async function loadBuffer(next: VoicePayload): Promise<AudioBuffer> {
  const ctx = ensureCtx();
  if (!ctx) throw new Error("no AudioContext");
  await ctx.resume();

  let bytes: ArrayBuffer;
  if (next.audioUrl) {
    const res = await fetch(next.audioUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    bytes = await res.arrayBuffer();
  } else if (next.audioBase64) {
    const bin = atob(next.audioBase64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    bytes = out.buffer;
  } else {
    throw new Error("no audio");
  }
  // copy for Safari decodeAudioData detachment rules
  return ctx.decodeAudioData(bytes.slice(0));
}

async function playBuffer(buf: AudioBuffer): Promise<void> {
  const ctx = ensureCtx();
  if (!ctx) throw new Error("no AudioContext");
  await ctx.resume();
  return new Promise<void>((resolve, reject) => {
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      activeSource = src;
      src.onended = () => {
        if (activeSource === src) activeSource = null;
        resolve();
      };
      src.start(0);
    } catch (err) {
      reject(err);
    }
  });
}

async function playViaElement(src: string): Promise<void> {
  if (!gateAudio) gateAudio = new Audio();
  const audio = gateAudio;
  audio.pause();
  audio.src = src;
  audio.volume = 1;
  await new Promise<void>((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error("element play failed"));
    };
    const cleanup = () => {
      audio.onended = null;
      audio.onerror = null;
    };
    audio.onended = ok;
    audio.onerror = bad;
    void audio.play().then(() => {
      armed = true;
    }, bad);
  });
}

async function drain(): Promise<void> {
  if (speaking) return;
  const next = queue.shift() ?? pendingBlocked;
  if (!next) return;
  if (next === pendingBlocked) pendingBlocked = null;

  speaking = true;
  emit();

  try {
    const buf = await loadBuffer(next);
    await playBuffer(buf);
    spokenCount += 1;
    armed = true;
    lastError = null;
  } catch (err) {
    // Fallback: HTMLAudioElement (works after unlock on some browsers).
    const src =
      next.audioUrl ||
      (next.audioBase64 ? `data:audio/mpeg;base64,${next.audioBase64}` : null);
    if (src) {
      try {
        await playViaElement(src);
        spokenCount += 1;
        armed = true;
        lastError = null;
      } catch {
        const msg = err instanceof Error ? err.message : "playback failed";
        const blocked = /interact|NotAllowed|Gesture/i.test(msg) || !armed;
        lastError = blocked ? "Click Enable sound, then try again" : "audio failed to load";
        armed = false;
        pendingBlocked = next;
      }
    } else {
      lastError = "audio failed to load";
      pendingBlocked = next;
    }
  }

  speaking = false;
  emit();
  if (queue.length > 0) void drain();
}
