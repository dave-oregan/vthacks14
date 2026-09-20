// ─────────────────────────────────────────────────────────────
// Gemini provider — interim engine so SIDEKICK works today.
//
// HokieAI remains the preferred provider for the sponsor track
// (see hokieai.ts). When HokieAI credentials aren't configured but
// GEMINI_API_KEY is, /api/analyze calls Gemini's REST API with the
// same prompt and the same server-side validation — no SDK, no new
// dependencies.
//
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   x-goog-api-key: {GEMINI_API_KEY}
// ─────────────────────────────────────────────────────────────

import type { AnalyzeRequest, SidekickProfile } from "./types";
import { buildPrompt, extractJson, sanitizeProfile } from "./hokieai";

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 12000);

/** Same fallback ordering as the main SIGHTLINE backend's Gemini client. */
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
].filter((m): m is string => Boolean(m && m.trim()));

export function geminiConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.SIDEKICK_FORCE_FALLBACK !== "true"
  );
}

async function generateOnce(
  model: string,
  system: string,
  user: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY!,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.95,
            maxOutputTokens: 800,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const err: Error & { status?: number } = new Error(
        `Gemini ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
      );
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "")
      .join("");
    if (!text) throw new Error(`Gemini ${model} returned empty completion`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Call Gemini and return a validated profile. Throws on any failure. */
export async function callGemini(req: AnalyzeRequest): Promise<SidekickProfile> {
  const { system, user } = buildPrompt(req);
  let lastErr: unknown;
  for (const model of MODEL_CANDIDATES) {
    try {
      const text = await generateOnce(model, system, user);
      return sanitizeProfile(extractJson(text), req.tone);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // Only hop models on "model unavailable" style errors — don't burn
      // quota cycling through the list on 429s or prompt issues.
      if (status !== 404 && status !== 503) throw err;
      console.warn(`[sidekick] ${(err as Error).message} — trying next model`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
