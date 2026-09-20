import { config } from "../config.js";
import { mirrorTranscript } from "../memory/db.js";

export interface VoiceResult {
  ok: boolean;
  text: string;
  audioBase64?: string;
  error?: string;
}

export async function speak(text: string): Promise<VoiceResult> {
  const startedAt = Date.now();
  if (!config.elevenLabsApiKey) {
    console.log(`[voice:local] (no ELEVENLABS_API_KEY) ${text}`);
    mirrorTranscript({ direction: "spoken", text, ok: true, hadAudio: false, error: "no api key" });
    return { ok: true, text, error: "no api key" };
  }
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": config.elevenLabsApiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          // turbo_v2_5 is markedly faster to first audio than monolingual_v1,
          // which matters when this is speaking during a live alert.
          model_id: config.elevenLabsModelId,
          voice_settings: { stability: 0.4, similarity_boost: 0.75 },
        }),
      },
    );
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.warn(`[voice] ElevenLabs ${res.status}: ${detail}`);
      mirrorTranscript({
        direction: "spoken", text, ok: false, hadAudio: false,
        model: config.elevenLabsModelId, latencyMs: Date.now() - startedAt,
        error: `ElevenLabs ${res.status}`,
      });
      return { ok: false, text, error: `ElevenLabs ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      console.warn("[voice] ElevenLabs returned an empty body");
      return { ok: false, text, error: "empty audio" };
    }
    console.log(
      `[voice] spoke ${buf.length} bytes in ${Date.now() - startedAt}ms (${config.elevenLabsModelId}): "${text.slice(0, 70)}"`,
    );
    mirrorTranscript({
      direction: "spoken", text, ok: true, hadAudio: true,
      model: config.elevenLabsModelId, latencyMs: Date.now() - startedAt,
      audioBytes: buf.length,
    });
    return { ok: true, text, audioBase64: buf.toString("base64") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[voice] request failed:", msg);
    mirrorTranscript({ direction: "spoken", text, ok: false, hadAudio: false, error: msg });
    return { ok: false, text, error: msg };
  }
}
