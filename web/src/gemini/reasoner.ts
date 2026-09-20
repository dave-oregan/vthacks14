import { generateWithFallback, hasGemini } from "./client.js";
import { formatObjectPhrase, type MemoryStore } from "../memory/store.js";
import type { MemoryObject } from "../shared/types.js";
import {
  isTranscriptMemoryQuery,
  recentHeardTranscripts,
  scoreTranscriptText,
  searchObjectsInAtlas,
  searchTranscriptsInAtlas,
  splitTranscriptTokens,
  type TranscriptHit,
} from "../memory/db.js";

export type RecallMatch = {
  id: string;
  kind: "object" | "transcript";
  phrase: string;
  label: string;
  descriptors: string[];
  lastSeenAtMs: number;
  lastSeenLabel: string;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  thumbBase64: string | null;
  sightingCount: number;
  status: string;
  /** Full transcript line when kind === "transcript" */
  transcriptText?: string;
  transcriptSource?: string | null;
};

export type RecallResult = {
  text: string;
  query: string;
  needsChoice: boolean;
  objectId?: string;
  matches: RecallMatch[];
};

export async function answerRecallQuery(
  query: string,
  store: MemoryStore,
): Promise<RecallResult> {
  const q = query.trim();

  // Conversation / people / story questions → Gemini summary over transcripts.
  if (isTranscriptMemoryQuery(q)) {
    const conversational = await answerConversationalFromTranscripts(q);
    if (conversational) return conversational;
  }

  // Visual object recall via Atlas (fallback: in-memory).
  let hits: MemoryObject[] = [];
  let servedBy: "atlas" | "memory" = "memory";

  const atlas = await searchObjectsInAtlas(q);
  if (atlas && atlas.length > 0) {
    hits = atlas
      .map((h) => store.getObject(h.id))
      .filter((o): o is MemoryObject => o !== null);
    if (hits.length > 0) servedBy = "atlas";
  }
  if (hits.length === 0) hits = store.searchObjects(q);

  if (hits.length === 0) {
    const tokens = q.toLowerCase().replace(/[?.,]/g, " ").split(/\s+/);
    const interesting = tokens.filter((t) =>
      ["phone", "iphone", "laptop", "backpack", "bag", "bottle", "keys", "case", "remote", "book"].includes(
        t,
      ),
    );
    for (const t of interesting) {
      hits.push(...store.searchObjects(t));
    }
  }

  const uniqueHits = [...new Map(hits.map((h) => [h.id, h])).values()];
  const objectMatches = uniqueHits.map(toRecallMatch);

  const spoken = (await searchTranscriptsInAtlas(q)) ?? [];
  const transcriptMatches = spoken
    .filter((h) => h.matchedTokens > 0)
    .map(toTranscriptMatch);

  if (objectMatches.length === 0 && transcriptMatches.length === 0) {
    console.log(`[recall] "${q}" -> 0 matches`);
    return {
      text: `I don't have a memory matching “${q}” yet.`,
      query: q,
      needsChoice: false,
      matches: [],
    };
  }

  if (objectMatches.length === 0 && transcriptMatches.length > 0) {
    console.log(`[recall] "${q}" -> ${transcriptMatches.length} TRANSCRIPT match(es) (summarize)`);
    return packTranscriptChoices(q, transcriptMatches);
  }

  console.log(
    `[recall] "${q}" -> ${objectMatches.length} object(s) via ${servedBy.toUpperCase()}` +
      (transcriptMatches.length ? ` + ${transcriptMatches.length} transcript(s)` : ""),
  );

  if (objectMatches.length === 1 && transcriptMatches.length === 0) {
    const best = uniqueHits[0]!;
    const text = await speakRecall(q, best);
    return {
      text,
      query: q,
      needsChoice: false,
      objectId: best.id,
      matches: objectMatches,
    };
  }

  const combined = [...objectMatches, ...transcriptMatches];
  const labels = combined
    .map((m) => m.phrase)
    .slice(0, 5)
    .join("; ");
  return {
    text: `I found ${combined.length} matches for “${q}”: ${labels}. Pick one.`,
    query: q,
    needsChoice: true,
    matches: combined,
  };
}

/**
 * Gather relevant overheard lines and answer with a Gemini paraphrase/summary —
 * never read the transcript back verbatim.
 */
async function answerConversationalFromTranscripts(query: string): Promise<RecallResult | null> {
  const { strong, weak } = splitTranscriptTokens(query);

  const keywordHits = (await searchTranscriptsInAtlas(query, 30)) ?? [];
  const recent = await recentHeardTranscripts(100);

  // Re-score everything against the query (recentHeard defaults matchedTokens=1).
  const scored = new Map<string, TranscriptHit>();
  for (const h of [...keywordHits, ...recent]) {
    const { score, matchedTokens } = scoreTranscriptText(h.text, strong, weak);
    const prev = scored.get(h.id);
    const next: TranscriptHit = {
      ...h,
      score,
      matchedTokens: matchedTokens || (tokensEmpty(strong, weak) ? 1 : 0),
    };
    if (!prev || (next.score ?? 0) > (prev.score ?? 0)) scored.set(h.id, next);
  }

  let ranked = [...scored.values()].sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      b.matchedTokens - a.matchedTokens ||
      b.timestampMs - a.timestampMs,
  );

  // Prefer lines that hit a strong token (e.g. "David") when the question names one.
  const strongHits = strong.length > 0 ? ranked.filter((h) => (h.score ?? 0) >= 3) : [];
  const seed = strongHits.length > 0 ? strongHits : ranked.filter((h) => (h.score ?? 0) > 0);

  if (seed.length === 0 && ranked.length === 0) return null;

  let lines: TranscriptHit[];
  if (seed.length > 0) {
    const windowMs = 2 * 60_000;
    const enriched = new Map(seed.slice(0, 20).map((m) => [m.id, m]));
    for (const m of seed.slice(0, 12)) {
      for (const r of ranked) {
        if (Math.abs(r.timestampMs - m.timestampMs) <= windowMs) {
          const existing = enriched.get(r.id);
          if (!existing || (r.score ?? 0) >= (existing.score ?? 0)) enriched.set(r.id, r);
        }
      }
    }
    lines = [...enriched.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  } else {
    lines = ranked.slice(0, 40).sort((a, b) => a.timestampMs - b.timestampMs);
  }

  if (lines.length === 0) {
    return {
      text: "I don’t have any overheard speech recorded yet.",
      query,
      needsChoice: false,
      matches: [],
    };
  }

  // For Gemini: lead with highest-scoring lines, then chronological context.
  const forModel = [
    ...[...lines].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 24),
  ];
  // Dedupe while preferring score order already in forModel
  const modelIds = new Set(forModel.map((l) => l.id));
  for (const l of lines) {
    if (!modelIds.has(l.id) && forModel.length < 40) {
      forModel.push(l);
      modelIds.add(l.id);
    }
  }

  const matches = [...lines]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 12)
    .map(toTranscriptMatch);

  const summary = await summarizeTranscriptsForQuery(query, forModel, { strong, weak });
  if (summary) {
    console.log(
      `[recall] "${query}" -> Gemini transcript summary (${forModel.length} lines, strong=[${strong.join(",")}])`,
    );
    return {
      text: summary,
      query,
      needsChoice: false,
      matches,
    };
  }

  return packTranscriptChoices(query, matches);
}

function tokensEmpty(strong: string[], weak: string[]): boolean {
  return strong.length === 0 && weak.length === 0;
}

async function packTranscriptChoices(query: string, matches: RecallMatch[]): Promise<RecallResult> {
  const lines: TranscriptHit[] = matches.map((m) => ({
    id: m.id,
    text: m.transcriptText ?? m.phrase,
    timestampMs: m.lastSeenAtMs,
    source: m.transcriptSource ?? null,
    direction: "heard",
    matchedTokens: 1,
  }));
  const summary = await summarizeTranscriptsForQuery(query, lines);
  if (summary) {
    return {
      text: summary,
      query,
      needsChoice: false,
      matches,
    };
  }

  if (matches.length === 1) {
    const m = matches[0]!;
    const snippet = (m.transcriptText ?? m.phrase).slice(0, 160);
    return {
      text: `From conversation ${describeAgo(m.lastSeenAtMs)}: ${snippet}${
        (m.transcriptText ?? "").length > 160 ? "…" : ""
      }`,
      query,
      needsChoice: false,
      matches,
    };
  }
  return {
    text: `I found ${matches.length} conversation memories for “${query}”. Pick one for details.`,
    query,
    needsChoice: true,
    matches,
  };
}

/**
 * Gemini: answer the user's question by summarizing transcript evidence.
 * Explicitly avoids reading lines back verbatim.
 */
export async function summarizeTranscriptsForQuery(
  query: string,
  lines: TranscriptHit[],
  focus?: { strong: string[]; weak: string[] },
): Promise<string | null> {
  if (!hasGemini() || lines.length === 0) return null;
  try {
    const payload = lines.slice(0, 40).map((l) => ({
      id: l.id,
      when: new Date(l.timestampMs).toISOString(),
      score: l.score ?? 0,
      text: l.text,
    }));
    const focusLine =
      focus && focus.strong.length > 0
        ? `\nFocus entities/topics from the question (must ground the answer when present in transcripts): ${focus.strong.join(", ")}.`
        : "";
    const raw = await generateWithFallback([
      {
        text: `You are SIGHTLINE, an AI memory layer for overheard speech (wearable mic transcripts).

The user asked: "${query}"
${focusLine}

Here are relevant transcript lines (JSON). Higher "score" means a stronger match to the question (names outrank words like "story" or "talk"):
${JSON.stringify(payload)}

Write a spoken answer (2–5 sentences) that SUMMARIZES what the transcripts show.

Rules:
- Answer the user's question directly (e.g. what story was told to/about a named person).
- Prefer high-score lines and anything mentioning the focus entities.
- If multiple stories appear, pick the one that best matches the named person/topic — do not mix unrelated conversations.
- Draw on as much relevant transcript content as needed — synthesize across lines.
- Do NOT read transcript lines back verbatim or quote long passages.
- Short quoted fragments (under ~8 words) are OK only for a name, title, or distinctive phrase.
- Paraphrase stories and conversations in clear natural language.
- If evidence is thin or conflicting, say what you found and what is unclear.
- Do not invent people, places, or plot points that are not supported by the transcripts.
- No markdown, bullets, or labels — plain speech suitable for text-to-speech.`,
      },
    ]);
    const text = raw.trim();
    return text || null;
  } catch (err) {
    console.warn(
      "[recall] Gemini transcript summary failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function toTranscriptMatch(h: TranscriptHit): RecallMatch {
  const snippet = h.text.length > 90 ? `${h.text.slice(0, 87)}…` : h.text;
  return {
    id: h.id,
    kind: "transcript",
    phrase: snippet,
    label: "transcript",
    descriptors: [h.direction, h.source ?? "mic"].filter(Boolean),
    lastSeenAtMs: h.timestampMs,
    lastSeenLabel: new Date(h.timestampMs).toLocaleString(),
    latitude: null,
    longitude: null,
    mapsUrl: null,
    thumbBase64: null,
    sightingCount: 1,
    status: "heard",
    transcriptText: h.text,
    transcriptSource: h.source,
  };
}

async function speakRecall(query: string, best: MemoryObject): Promise<string> {
  const loc = best.lastLocation
    ? `${best.lastLocation.latitude.toFixed(5)}, ${best.lastLocation.longitude.toFixed(5)}`
    : "unknown location";
  const when = new Date(best.lastSeenAtMs).toLocaleString();
  const phrase = formatObjectPhrase(best);
  let text = `Last seen: ${phrase}. Time: ${when}. Location: ${loc}.`;

  if (hasGemini()) {
    try {
      const spoken = await generateWithFallback([
        {
          text: `User asked: "${query}"\nMemory record: ${JSON.stringify({
            phrase,
            when,
            loc,
            status: best.status,
            descriptors: best.descriptors,
          })}\nReply in one short spoken sentence for SIGHTLINE glasses, including the location coordinates if known.`,
        },
      ]);
      text = spoken.trim() || text;
    } catch {
      /* keep template */
    }
  }
  return text;
}

export function toRecallMatch(obj: MemoryObject): RecallMatch {
  const lat = obj.lastLocation?.latitude ?? null;
  const lng = obj.lastLocation?.longitude ?? null;
  return {
    id: obj.id,
    kind: "object",
    phrase: formatObjectPhrase(obj),
    label: obj.canonicalLabel,
    descriptors: obj.descriptors,
    lastSeenAtMs: obj.lastSeenAtMs,
    lastSeenLabel: new Date(obj.lastSeenAtMs).toLocaleString(),
    latitude: lat,
    longitude: lng,
    mapsUrl:
      lat != null && lng != null
        ? `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`
        : null,
    thumbBase64: obj.lastFrameThumbJpeg
      ? Buffer.from(obj.lastFrameThumbJpeg).toString("base64")
      : null,
    sightingCount: obj.sightingCount,
    status: obj.status,
  };
}

export async function interpretMissionIntent(utterance: string): Promise<{
  intent: "recall" | "none";
  target?: string;
}> {
  const u = utterance.toLowerCase();
  if (
    /where.*(phone|iphone|laptop|backpack|bag|bottle|keys)/.test(u) ||
    /last seen|find my|where did i leave|recall/.test(u)
  ) {
    const m = u.match(/(black|white|grey|gray|silver)?\s*(phone|iphone|laptop|backpack|bag|bottle|keys|case)/);
    return { intent: "recall", target: m?.[0]?.trim() ?? utterance };
  }
  return { intent: "none" };
}

function describeAgo(timestampMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (secs < 15) return "just now";
  if (secs < 90) return `${secs} seconds ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
}
