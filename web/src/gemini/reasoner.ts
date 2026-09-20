import { generateWithFallback, hasGemini } from "./client.js";
import { formatObjectPhrase, type MemoryStore } from "../memory/store.js";
import type { MemoryObject } from "../shared/types.js";
import {
  isPeopleTranscriptQuery,
  recentHeardTranscripts,
  searchObjectsInAtlas,
  searchTranscriptsInAtlas,
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

  // People / conversation questions → Gemini over heard transcripts first.
  if (isPeopleTranscriptQuery(q)) {
    const people = await answerPeopleFromTranscripts(q);
    if (people.matches.length > 0) return people;
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

  // Transcript matches (Mongo) — always available as parallel memory.
  const spoken = (await searchTranscriptsInAtlas(q)) ?? [];
  const transcriptMatches = spoken
    .filter((h) => h.matchedTokens > 0 || isPeopleTranscriptQuery(q))
    .map(toTranscriptMatch);

  // Prefer objects when we have them; otherwise transcripts; or merge both into picker.
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
    console.log(`[recall] "${q}" -> ${transcriptMatches.length} TRANSCRIPT match(es)`);
    return packTranscriptChoices(q, transcriptMatches);
  }

  console.log(
    `[recall] "${q}" -> ${objectMatches.length} object(s) via ${servedBy.toUpperCase()}` +
      (transcriptMatches.length ? ` + ${transcriptMatches.length} transcript(s)` : ""),
  );

  // One clear object hit and no competing transcripts → speak it.
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

  // Multiple cards (objects and/or transcripts) → same list picker UI.
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

function packTranscriptChoices(query: string, matches: RecallMatch[]): RecallResult {
  if (matches.length === 1) {
    const m = matches[0]!;
    return {
      text: `You heard: “${m.transcriptText ?? m.phrase}” ${describeAgo(m.lastSeenAtMs)}.`,
      query,
      needsChoice: false,
      matches,
    };
  }
  return {
    text: `I found ${matches.length} transcript matches for “${query}”. Pick one.`,
    query,
    needsChoice: true,
    matches,
  };
}

/**
 * "Who did I meet?" — Gemini reads recent heard lines and returns named people /
 * self-introductions as picker cards. Falls back to regex intros if no Gemini.
 */
async function answerPeopleFromTranscripts(query: string): Promise<RecallResult> {
  const lines = await recentHeardTranscripts(80);
  if (lines.length === 0) {
    return { text: "I don’t have any overheard speech recorded yet.", query, needsChoice: false, matches: [] };
  }

  if (hasGemini()) {
    try {
      const payload = lines.slice(0, 40).map((l) => ({
        id: l.id,
        when: new Date(l.timestampMs).toISOString(),
        text: l.text,
      }));
      const raw = await generateWithFallback(
        [
          {
            text: `You are SIGHTLINE memory. The user asked: "${query}"

Below are overheard transcript lines (wearer's mic). Extract people who were named or introduced themselves (e.g. "my name is …", "I'm …", "this is …").

Return JSON only:
{ "people": [ { "name": "Alex", "transcriptId": "<id>", "quote": "exact short quote", "note": "optional one clause" } ] }

Rules:
- Only use facts present in the transcripts. Do not invent names.
- If nobody named themselves, return { "people": [] }.
- Prefer distinct people. Max 8.

Transcripts:
${JSON.stringify(payload)}`,
          },
        ],
        { responseMimeType: "application/json" },
      );
      const parsed = JSON.parse(stripFence(raw)) as {
        people?: Array<{ name?: string; transcriptId?: string; quote?: string; note?: string }>;
      };
      const byId = new Map(lines.map((l) => [l.id, l]));
      const matches: RecallMatch[] = [];
      for (const p of parsed.people ?? []) {
        const name = (p.name ?? "").trim();
        if (!name) continue;
        const line = (p.transcriptId && byId.get(p.transcriptId)) || findLineForQuote(lines, p.quote);
        const quote = (p.quote ?? line?.text ?? "").trim();
        matches.push({
          id: line?.id ?? `person:${name.toLowerCase()}`,
          kind: "transcript",
          phrase: name,
          label: "person",
          descriptors: [quote, p.note ?? "from conversation"].filter(Boolean),
          lastSeenAtMs: line?.timestampMs ?? Date.now(),
          lastSeenLabel: line ? new Date(line.timestampMs).toLocaleString() : "unknown time",
          latitude: null,
          longitude: null,
          mapsUrl: null,
          thumbBase64: null,
          sightingCount: 1,
          status: "heard",
          transcriptText: quote || line?.text,
          transcriptSource: line?.source ?? null,
        });
      }
      if (matches.length > 0) {
        console.log(`[recall] "${query}" -> ${matches.length} people via Gemini transcripts`);
        if (matches.length === 1) {
          const m = matches[0]!;
          return {
            text: `You met ${m.phrase}. They said “${m.transcriptText}” ${describeAgo(m.lastSeenAtMs)}.`,
            query,
            needsChoice: false,
            matches,
          };
        }
        return {
          text: `I found ${matches.length} people mentioned in conversation. Pick one.`,
          query,
          needsChoice: true,
          matches,
        };
      }
    } catch (err) {
      console.warn("[recall] Gemini people extract failed:", err instanceof Error ? err.message : err);
    }
  }

  // Regex fallback: "my name is X", "I'm X", "I am X"
  const introHits = lines.filter((l) =>
    /\b(my name is|i'?m|i am|this is|meet)\b/i.test(l.text),
  );
  if (introHits.length === 0) {
    return { text: "I don’t have a recorded introduction matching that.", query, needsChoice: false, matches: [] };
  }
  const matches = introHits.slice(0, 8).map(toTranscriptMatch);
  return packTranscriptChoices(query, matches);
}

function findLineForQuote(lines: TranscriptHit[], quote?: string): TranscriptHit | undefined {
  if (!quote) return undefined;
  const soft = quote.toLowerCase().slice(0, 40);
  return lines.find((l) => l.text.toLowerCase().includes(soft));
}

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
