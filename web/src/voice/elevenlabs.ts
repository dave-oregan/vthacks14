import dotenv from "dotenv";
import { config } from "../config.js";
import { mirrorTranscript } from "../memory/db.js";
import { storeVoiceClip } from "./voiceCache.js";

export interface VoiceResult {
  ok: boolean;
  text: string;
  audioUrl?: string;
  audioBase64?: string;
  error?: string;
}

const MODEL_FALLBACKS = ["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"];

function voiceSettings() {
  dotenv.config({ override: false });
  const apiKey = (process.env.ELEVENLABS_API_KEY ?? config.elevenLabsApiKey ?? "").trim();
  const voiceId = (process.env.ELEVENLABS_VOICE_ID ?? config.elevenLabsVoiceId ?? "").trim();
  const preferredModel = (process.env.ELEVENLABS_MODEL_ID ?? config.elevenLabsModelId ?? "eleven_turbo_v2_5").trim();
  const models = [preferredModel, ...MODEL_FALLBACKS.filter((m) => m !== preferredModel)];
  return { apiKey, voiceId, models };
}

async function ttsOnce(apiKey: string, voiceId: string, modelId: string, text: string) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) return { ok: false as const, status: res.status, detail: (await res.text()).slice(0, 300) };
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { ok: false as const, status: 204, detail: "empty" };
  return { ok: true as const, buf };
}

export async function speak(text: string): Promise<VoiceResult> {
  const startedAt = Date.now();
  const line = text.trim();
  if (!line) return { ok: false, text, error: "empty text" };
  const { apiKey, voiceId, models } = voiceSettings();
  if (!apiKey) {
    mirrorTranscript({ direction: "spoken", text: line, ok: true, hadAudio: false, error: "no api key" });
    return { ok: true, text: line, error: "no api key" };
  }
  if (!voiceId) return { ok: false, text: line, error: "no voice id" };

  let lastErr = "unknown";
  try {
    for (const modelId of models) {
      const result = await ttsOnce(apiKey, voiceId, modelId, line);
      if (result.ok) {
        const audioUrl = storeVoiceClip(line, result.buf);
        console.log(`[voice] spoke ${result.buf.length}b in ${Date.now() - startedAt}ms → ${audioUrl}`);
        mirrorTranscript({
          direction: "spoken",
          text: line,
          ok: true,
          hadAudio: true,
          model: modelId,
          latencyMs: Date.now() - startedAt,
          audioBytes: result.buf.length,
        });
        // No base64 on the wire — dashboard fetches audioUrl as MP3.
        return { ok: true, text: line, audioUrl };
      }
      lastErr = `ElevenLabs ${result.status}: ${result.detail}`;
      console.warn(`[voice] ${modelId} failed: ${lastErr}`);
      if (result.status === 404) break;
    }
    return { ok: false, text: line, error: lastErr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, text: line, error: msg };
  }
}
