import { config } from "../config.js";

export async function speak(text: string): Promise<{ ok: boolean; audioBase64?: string; text: string }> {
  if (!config.elevenLabsApiKey) {
    console.log(`[voice:local] ${text}`);
    return { ok: true, text };
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
          model_id: "eleven_monolingual_v1",
        }),
      },
    );
    if (!res.ok) {
      console.warn("[voice] ElevenLabs error", res.status, await res.text());
      return { ok: false, text };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, text, audioBase64: buf.toString("base64") };
  } catch (err) {
    console.warn("[voice] failed", err);
    return { ok: false, text };
  }
}
