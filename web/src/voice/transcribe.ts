import { EventEmitter } from "node:events";
import { config } from "../config.js";
import type { RelayAudioChunk } from "../relay/relayHub.js";

/**
 * Speech-to-text for the wearable microphone.
 *
 * Audio from the Ray-Bans (or the iPhone mic - both arrive through the same
 * relay packet type) turns up here as a stream of small PCM16 chunks. Scribe
 * wants a whole utterance, not a stream, so this class does the part nobody
 * mentions: deciding where one utterance ends and the next begins.
 *
 * The approach is energy-based voice activity detection against an adaptive
 * noise floor, because a hackathon venue is loud and a fixed threshold that
 * works in a quiet room will either hear nothing or hear everything.
 *
 * Nothing here ever throws into the relay. A transcription failure is logged
 * and dropped; the live demo is unaffected.
 */

export interface Utterance {
  text: string;
  source: string;
  sessionId: string;
  startedAtMs: number;
  durationMs: number;
  latencyMs: number;
  languageCode?: string;
  confidence?: number;
}

export interface TranscriberEvents {
  transcript: [Utterance];
  listening: [{ speaking: boolean; source: string }];
}

/** Silence this long ends an utterance. */
const SILENCE_HANGOVER_MS = 1100;
/** Ignore bursts shorter than this - a cough, a chair scrape. */
const MIN_UTTERANCE_MS = 280;
/** Force a flush so a monologue still gets transcribed. */
const MAX_UTTERANCE_MS = 14_000;
/** Keep this much audio before speech starts, so the first word isn't clipped. */
const PREROLL_MS = 450;
/** Absolute floor - below this we never call it speech, however quiet the room. */
const ABSOLUTE_RMS_FLOOR = 130;
/** Speech must exceed the rolling noise floor by this factor. */
const SPEECH_MULTIPLIER = 2.0;

function rms16(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Minimal 16-bit PCM WAV container. Scribe accepts this everywhere. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface ScribeResult {
  ok: boolean;
  text: string;
  latencyMs: number;
  languageCode?: string;
  confidence?: number;
  modelUsed?: string;
  error?: string;
}

/**
 * One call to Scribe. Shared by the live microphone path and the manual test
 * endpoint. Model names shift between plans and releases, so a model-related
 * rejection retries once against scribe_v1 rather than failing the demo.
 */
export async function callScribe(
  bytes: Buffer,
  filename = "audio.wav",
  mime = "audio/wav",
): Promise<ScribeResult> {
  const began = Date.now();
  if (!config.elevenLabsApiKey) {
    return { ok: false, text: "", latencyMs: 0, error: "no ELEVENLABS_API_KEY" };
  }

  const attempt = async (modelId: string): Promise<Response> => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append("model_id", modelId);
    if (config.sttLanguageCode) form.append("language_code", config.sttLanguageCode);
    return fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": config.elevenLabsApiKey },
      body: form,
    });
  };

  try {
    let modelUsed = config.sttModelId;
    let res = await attempt(modelUsed);

    if (!res.ok && [400, 404, 422].includes(res.status)) {
      const detail = (await res.text()).slice(0, 200);
      if (/model/i.test(detail) && modelUsed !== "scribe_v1") {
        console.warn(`[stt] ${modelUsed} rejected (${detail}) - retrying scribe_v1`);
        modelUsed = "scribe_v1";
        res = await attempt(modelUsed);
      } else {
        return {
          ok: false, text: "", latencyMs: Date.now() - began,
          error: `Scribe ${res.status}: ${detail}`,
        };
      }
    }

    if (!res.ok) {
      return {
        ok: false, text: "", latencyMs: Date.now() - began,
        error: `Scribe ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      text?: string;
      language_code?: string;
      language_probability?: number;
    };
    return {
      ok: true,
      text: (data.text ?? "").trim(),
      latencyMs: Date.now() - began,
      languageCode: data.language_code,
      confidence: data.language_probability,
      modelUsed,
    };
  } catch (err) {
    return {
      ok: false, text: "", latencyMs: Date.now() - began,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class SpeechTranscriber extends EventEmitter {
  private buffered: Buffer[] = [];
  private speechEndedAtMs = 0;
  /**
   * Utterance timing runs on an AUDIO clock (milliseconds of PCM received),
   * not on Date.now(). If the relay ever bursts - a websocket reconnect, a
   * stall then catch-up, iOS flushing a backlog - several seconds of speech
   * arrive within a few milliseconds of wall time. On a wall clock that looks
   * like a 200ms blip and real speech gets thrown away.
   */
  private audioClockMs = 0;
  private startedAtWallMs = 0;
  /** Pre-roll milliseconds sitting at the FRONT of `buffered`. The trailing
   *  trim must account for this or it cuts real speech off the end. */
  private prerollMsIncluded = 0;
  private preroll: Buffer[] = [];
  private prerollBytes = 0;
  private capturing = false;
  private startedAtMs = 0;
  private lastVoiceAtMs = 0;
  private sampleRate = 16000;
  private channels = 1;
  private source = "unknown";
  private sessionId = "unknown";
  private noiseFloor = 0;
  private lastChunkWallMs = 0;
  private sawAnyChunk = false;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;

  /** Transcriptions completed this session, for /api/health. */
  public completed = 0;
  public failed = 0;
  public lastError: string | null = null;
  public lastText: string | null = null;

  get enabled(): boolean {
    return Boolean(config.elevenLabsApiKey) && config.sttEnabled;
  }

  push(chunk: RelayAudioChunk): void {
    if (!this.enabled) return;
    if (chunk.pcm.length < 2) return;

    // The relay hands us a view into the socket buffer, not a copy. Holding
    // that across time would let a later packet overwrite our audio.
    const pcm = Buffer.from(chunk.pcm);

    this.sampleRate = chunk.sampleRate > 0 ? chunk.sampleRate : 16000;
    this.channels = chunk.channels > 0 ? chunk.channels : 1;
    this.source = chunk.source;
    this.sessionId = chunk.sessionId;

    const level = rms16(pcm);
    const chunkMs = (pcm.length / 2 / this.channels / this.sampleRate) * 1000;
    this.audioClockMs += chunkMs;
    const now = this.audioClockMs;
    this.lastChunkWallMs = Date.now();

    // Adaptive noise floor, updated ONLY between utterances. Letting it adapt
    // during speech made a long sentence train the floor upward until the
    // speaker's own voice fell below threshold and got cut off mid-word.
    if (!this.sawAnyChunk) {
      this.noiseFloor = level;
      this.sawAnyChunk = true;
    } else if (!this.capturing) {
      if (level < this.noiseFloor) {
        this.noiseFloor = this.noiseFloor * 0.9 + level * 0.1;
      } else {
        this.noiseFloor = this.noiseFloor * 0.995 + level * 0.005;
      }
    }

    const threshold = Math.max(this.noiseFloor * SPEECH_MULTIPLIER, ABSOLUTE_RMS_FLOOR);
    const isSpeech = level > threshold;

    if (!this.capturing) {
      // Hold a short pre-roll so we don't clip the start of the first word.
      this.preroll.push(pcm);
      this.prerollBytes += pcm.length;
      const maxPreroll = (PREROLL_MS / 1000) * this.sampleRate * this.channels * 2;
      while (this.prerollBytes > maxPreroll && this.preroll.length > 1) {
        this.prerollBytes -= this.preroll.shift()!.length;
      }
      if (isSpeech) {
        this.capturing = true;
        this.startedAtMs = now;
        this.startedAtWallMs = Date.now();
        this.lastVoiceAtMs = now;
        this.speechEndedAtMs = now;
        this.buffered = [...this.preroll];
        this.prerollMsIncluded =
          this.prerollBytes / ((this.sampleRate * this.channels * 2) / 1000);
        this.preroll = [];
        this.prerollBytes = 0;
        this.emit("listening", { speaking: true, source: this.source });
        this.armTimer();
      }
      return;
    }

    this.buffered.push(pcm);
    if (isSpeech) {
      this.lastVoiceAtMs = now;
      this.speechEndedAtMs = now;
    }

    if (now - this.startedAtMs >= MAX_UTTERANCE_MS) {
      this.flush("max-length");
      return;
    }
    if (now - this.lastVoiceAtMs >= SILENCE_HANGOVER_MS) {
      this.flush("silence");
    }
  }

  /**
   * Audio can simply stop arriving (the wearer goes quiet, the stream drops).
   * A timer closes the utterance so it isn't left dangling forever.
   */
  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Wall time on purpose: this fires when packets stop arriving entirely,
      // which an audio clock (driven by arriving packets) can never detect.
      if (this.capturing && Date.now() - this.lastChunkWallMs >= SILENCE_HANGOVER_MS) {
        this.flush("stream-idle");
      } else if (this.capturing) {
        this.armTimer();
      }
    }, SILENCE_HANGOVER_MS + 250);
    this.timer.unref?.();
  }

  private flush(reason: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let pcm = Buffer.concat(this.buffered);
    const startedAtMs = this.startedAtWallMs || Date.now();
    const speechMs = Math.max(0, this.speechEndedAtMs - this.startedAtMs);
    const source = this.source;
    const sessionId = this.sessionId;
    const sampleRate = this.sampleRate;
    const channels = this.channels;

    this.buffered = [];
    this.capturing = false;
    this.emit("listening", { speaking: false, source });

    const bytesPerMs = (sampleRate * channels * 2) / 1000;

    // Reject on how much SPEECH there was, not how much buffer we hold - the
    // buffer always includes the silence hangover, so a 200ms cough used to
    // look like a 1.2s utterance and got sent to Scribe.
    if (speechMs < MIN_UTTERANCE_MS) {
      console.log(`[stt] ignoring ${speechMs}ms blip (${reason})`);
      return;
    }

    // Trim most of the trailing silence, keeping a little tail so the last
    // consonant survives. Smaller upload, faster transcription.
    // `buffered` begins with pre-roll captured BEFORE startedAtMs, so the
    // window we keep is preroll + speech + tail. Omitting the pre-roll here
    // silently chopped ~300ms off the end of every utterance - the last word.
    const keepTailMs = 400;
    const keepBytes = Math.ceil(
      (this.prerollMsIncluded + speechMs + keepTailMs) * bytesPerMs,
    );
    if (keepBytes < pcm.length) pcm = pcm.subarray(0, keepBytes);

    const durationMs = Math.round(pcm.length / bytesPerMs);

    if (this.inFlight >= 3) {
      console.warn("[stt] dropping utterance - 3 already in flight");
      return;
    }

    console.log(
      `[stt] utterance ${durationMs}ms from ${source} (${reason}) -> transcribing`,
    );
    this.inFlight += 1;
    void this.transcribe(pcm, sampleRate, channels, startedAtMs, durationMs, source, sessionId)
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  private async transcribe(
    pcm: Buffer,
    sampleRate: number,
    channels: number,
    startedAtMs: number,
    durationMs: number,
    source: string,
    sessionId: string,
  ): Promise<void> {
    const wav = pcmToWav(pcm, sampleRate, channels);
    const r = await callScribe(wav, "utterance.wav", "audio/wav");

    if (!r.ok) {
      this.failed += 1;
      this.lastError = r.error ?? "unknown";
      console.warn(`[stt] ${this.lastError}`);
      return;
    }
    if (!r.text) {
      console.log("[stt] empty transcript - discarding");
      return;
    }

    this.completed += 1;
    this.lastText = r.text;
    this.lastError = null;
    console.log(`[stt] heard (${r.latencyMs}ms, ${source}): "${r.text}"`);

    this.emit("transcript", {
      text: r.text,
      source,
      sessionId,
      startedAtMs,
      durationMs,
      latencyMs: r.latencyMs,
      languageCode: r.languageCode,
      confidence: r.confidence,
    } satisfies Utterance);
  }

  status() {
    return {
      enabled: this.enabled,
      model: config.sttModelId,
      speaking: this.capturing,
      inFlight: this.inFlight,
      completed: this.completed,
      failed: this.failed,
      lastText: this.lastText,
      lastError: this.lastError,
      noiseFloor: Math.round(this.noiseFloor),
    };
  }
}
