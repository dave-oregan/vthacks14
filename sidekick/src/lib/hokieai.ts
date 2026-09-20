import {
  ABILITIES,
  ABILITY_IDS,
  type AbilityId,
  type AnalyzeRequest,
  type SidekickProfile,
  type Tone,
} from "./types";

// ─────────────────────────────────────────────────────────────
// HokieAI integration
//
// HokieAI is Virginia Tech's AI platform. This client assumes an
// OpenAI-compatible chat-completions gateway, which is how these
// campus gateways are typically exposed:
//
//   POST {HOKIEAI_BASE_URL}{HOKIEAI_CHAT_PATH=/chat/completions}
//   Authorization: Bearer {HOKIEAI_API_KEY}
//   { model, messages, temperature, response_format }
//
// TODO: If the sponsor-provided endpoint differs (path, auth
// header, request shape), adjust `callHokieAI` below — everything
// else (prompting, validation, fallback) stays the same.
// ─────────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.HOKIEAI_TIMEOUT_MS ?? 12000);

export function hokieConfigured(): boolean {
  return Boolean(
    process.env.HOKIEAI_API_KEY &&
      process.env.HOKIEAI_BASE_URL &&
      process.env.SIDEKICK_FORCE_FALLBACK !== "true"
  );
}

export function buildPrompt({ answer1, answer2, answer3, tone }: AnalyzeRequest) {
  const system = [
    "You are the personality engine inside SIGHTLINE // SIDEKICK, a playful demo",
    "inspired by SIGHTLINE — an AI perception and memory system for smart glasses.",
    "A user answered 3 questions about themselves. Generate their 'SIGHTLINE Profile'.",
    "",
    "Rules:",
    "- Be concise and witty. This is comedy, not a medical exam.",
    tone === "roast"
      ? "- Tone: ROAST. Tease them playfully — never cruel, never insulting who they are."
      : "- Tone: NICE. Warm and encouraging, but still funny and full of personality.",
    "- Base everything on all three answers together; make it feel personal.",
    "- Vary wording wildly; two people with similar answers must not get identical text.",
    "- No serious medical, mental-health, criminal, or safety diagnoses. Ever.",
    "- Never claim the real SIGHTLINE system observed or recorded the user.",
    "- recommendedAbility.id must be exactly one of: " + ABILITY_IDS.join(", "),
    "  recall = finding/remembering objects; memory = conversations/people/context;",
    "  guardian = safety/hazards; mission = don't-leave-it-behind tracking;",
    "  voice = ambient conversational assistance.",
    "- Scores are integers 0-100 and should reflect the answers (chaotic answers -> high chaos, etc).",
    "",
    "Respond with STRICT JSON only, no markdown, in exactly this shape:",
    "{",
    '  "archetype": "THE CHAOTIC INVENTOR",',
    '  "subtitle": "one funny line",',
    '  "scores": {"memory": 34, "situationalAwareness": 71, "survivalInstinct": 92, "chaos": 88},',
    '  "diagnosis": "2-3 sentence playful paragraph",',
    '  "recommendedAbility": {"id": "recall", "name": "RECALL", "icon": "search", "description": "one line"},',
    '  "verdict": "one punchy quotable line"',
    "}",
  ].join("\n");

  const user = [
    `Q1 - What do you lose or forget the most? -> ${answer1}`,
    `Q2 - When should the sidekick intervene? -> ${answer2}`,
    `Q3 - What would the glasses see them doing? -> ${answer3}`,
  ].join("\n");

  return { system, user };
}

/** Extract the first balanced {...} block from model output. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in response");
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    if (cleaned[i] === "}") depth--;
    if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error("unbalanced JSON in response");
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function asString(v: unknown, fallback: string, max = 400): string {
  if (typeof v !== "string" || !v.trim()) return fallback;
  return v.trim().slice(0, max);
}

/** Validate + sanitize raw model output into a SidekickProfile. Throws on unusable data. */
export function sanitizeProfile(raw: unknown, tone: Tone): SidekickProfile {
  if (typeof raw !== "object" || raw === null) throw new Error("profile not an object");
  const p = raw as Record<string, unknown>;
  const scores = (p.scores ?? {}) as Record<string, unknown>;
  const abilityRaw = (p.recommendedAbility ?? {}) as Record<string, unknown>;

  const idCandidate = String(abilityRaw.id ?? "").toLowerCase();
  const abilityId: AbilityId = (ABILITY_IDS as string[]).includes(idCandidate)
    ? (idCandidate as AbilityId)
    : guessAbility(JSON.stringify(p).toLowerCase());
  const canonical = ABILITIES[abilityId];

  const archetype = asString(p.archetype, "", 60).toUpperCase();
  const diagnosis = asString(p.diagnosis, "", 600);
  const verdict = asString(p.verdict, "", 200);
  if (!archetype || !diagnosis || !verdict) {
    throw new Error("profile missing required fields");
  }

  return {
    archetype,
    subtitle: asString(
      p.subtitle,
      tone === "roast" ? "Diagnosis pending. Confidence: high." : "Certified interesting human.",
      140
    ),
    scores: {
      memory: clampScore(scores.memory),
      situationalAwareness: clampScore(scores.situationalAwareness),
      survivalInstinct: clampScore(scores.survivalInstinct),
      chaos: clampScore(scores.chaos),
    },
    diagnosis,
    recommendedAbility: {
      ...canonical,
      description: asString(abilityRaw.description, canonical.description, 160),
    },
    verdict,
  };
}

function guessAbility(text: string): AbilityId {
  if (/guardian|safety|hazard/.test(text)) return "guardian";
  if (/voice|conversation/.test(text)) return "voice";
  if (/mission|leave|behind|track/.test(text)) return "mission";
  if (/memory|remember|names/.test(text)) return "memory";
  return "recall";
}

/** Call the HokieAI gateway and return a validated profile. Throws on any failure. */
export async function callHokieAI(req: AnalyzeRequest): Promise<SidekickProfile> {
  const base = process.env.HOKIEAI_BASE_URL!.replace(/\/+$/, "");
  const path = process.env.HOKIEAI_CHAT_PATH ?? "/chat/completions";
  const { system, user } = buildPrompt(req);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.HOKIEAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.HOKIEAI_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.95,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`HokieAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty completion from HokieAI");
    return sanitizeProfile(extractJson(content), req.tone);
  } finally {
    clearTimeout(timer);
  }
}
