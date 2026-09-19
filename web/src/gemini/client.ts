import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";

/** Prefer models that still serve generateContent for consumer API keys. */
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
].filter((m): m is string => Boolean(m && m.trim()));

let cachedModelName: string | null = null;

export function hasGemini(): boolean {
  return Boolean(config.geminiApiKey);
}

/**
 * Run generateContent, retrying with the next model name on 404 / 503.
 */
export async function generateWithFallback(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  opts?: { responseMimeType?: string },
): Promise<string> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY missing");

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const order = cachedModelName
    ? [cachedModelName, ...MODEL_CANDIDATES.filter((m) => m !== cachedModelName)]
    : MODEL_CANDIDATES;

  let lastErr: unknown;
  for (const name of order) {
    try {
      const model = genAI.getGenerativeModel({
        model: name,
        generationConfig: opts?.responseMimeType
          ? { responseMimeType: opts.responseMimeType }
          : undefined,
      });
      const result = await model.generateContent(parts);
      if (!cachedModelName) console.log(`[gemini] using model ${name}`);
      cachedModelName = name;
      return result.response.text();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|not found|no longer available|503|high demand|unavailable/i.test(msg)) {
        console.warn(`[gemini] model ${name} unavailable, trying next…`);
        if (cachedModelName === name) cachedModelName = null;
        continue;
      }
      // Don't burn the free-tier quota hopping models on 429.
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
