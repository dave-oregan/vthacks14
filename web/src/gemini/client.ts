import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";

/**
 * Prefer models known to work with current consumer API keys.
 * Dead / region-gated ids burn latency before we reach a working one.
 */
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
].filter((m): m is string => Boolean(m && m.trim()));

let cachedModelName: string | null = null;
/** One-at-a-time model discovery so parallel recalls don't thrash 404s. */
let chain: Promise<unknown> = Promise.resolve();

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

  const run = async (): Promise<string> => {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    const tryOnce = async (name: string): Promise<string> => {
      const model = genAI.getGenerativeModel({
        model: name,
        generationConfig: opts?.responseMimeType
          ? { responseMimeType: opts.responseMimeType }
          : undefined,
      });
      const result = await model.generateContent(parts);
      return result.response.text();
    };

    const order = cachedModelName
      ? [cachedModelName, ...MODEL_CANDIDATES.filter((m) => m !== cachedModelName)]
      : MODEL_CANDIDATES;

    let lastErr: unknown;
    for (const name of order) {
      try {
        const text = await tryOnce(name);
        if (cachedModelName !== name) console.log(`[gemini] using model ${name}`);
        cachedModelName = name;
        return text;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/404|not found|no longer available|503|high demand|unavailable/i.test(msg)) {
          console.warn(`[gemini] model ${name} unavailable, trying next…`);
          if (cachedModelName === name) cachedModelName = null;
          continue;
        }
        // Don't burn quota hopping models on 429.
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
