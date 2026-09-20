import { NextResponse } from "next/server";
import { callHokieAI, hokieConfigured } from "@/lib/hokieai";
import { callGemini, geminiConfigured } from "@/lib/gemini";
import { fallbackProfile } from "@/lib/fallback";
import type { AnalyzeRequest, Tone } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TONES: Tone[] = ["roast", "nice"];

function parseBody(body: unknown): AnalyzeRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const answer1 = typeof b.answer1 === "string" ? b.answer1.slice(0, 200) : "";
  const answer2 = typeof b.answer2 === "string" ? b.answer2.slice(0, 200) : "";
  const answer3 = typeof b.answer3 === "string" ? b.answer3.slice(0, 200) : "";
  const tone = VALID_TONES.includes(b.tone as Tone) ? (b.tone as Tone) : "roast";
  if (!answer1 || !answer2 || !answer3) return null;
  return { answer1, answer2, answer3, tone };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed) {
    return NextResponse.json({ error: "Missing answers" }, { status: 400 });
  }

  // Provider chain: HokieAI (sponsor track) → Gemini (working today) →
  // deterministic local fallback. A failing provider degrades to the next
  // so the demo keeps working; `_source` reports which engine answered.
  if (hokieConfigured()) {
    try {
      const profile = await callHokieAI(parsed);
      return NextResponse.json({ ...profile, _source: "hokieai" });
    } catch (err) {
      console.error("[sidekick] HokieAI analyze failed, trying Gemini:", err);
    }
  }

  if (geminiConfigured()) {
    try {
      const profile = await callGemini(parsed);
      return NextResponse.json({ ...profile, _source: "gemini" });
    } catch (err) {
      console.error("[sidekick] Gemini analyze failed, using fallback:", err);
    }
  }

  // DEVELOPMENT-ONLY FALLBACK: when no LLM credentials are configured (or all
  // failed), serve a deterministic generated profile so the UI is demoable.
  const profile = fallbackProfile(
    parsed.answer1,
    parsed.answer2,
    parsed.answer3,
    parsed.tone
  );
  return NextResponse.json({ ...profile, _source: "fallback" });
}
