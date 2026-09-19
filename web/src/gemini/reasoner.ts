import { generateWithFallback, hasGemini } from "./client.js";
import { formatObjectPhrase, type MemoryStore } from "../memory/store.js";
import type { MemoryObject } from "../shared/types.js";

export type RecallMatch = {
  id: string;
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
  let hits = store.searchObjects(query);
  if (hits.length === 0) {
    const tokens = query.toLowerCase().replace(/[?.,]/g, " ").split(/\s+/);
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
  if (uniqueHits.length === 0) {
    return {
      text: `I don't have a memory matching “${query.trim()}” yet.`,
      query,
      needsChoice: false,
      matches: [],
    };
  }

  const matches = uniqueHits.map(toRecallMatch);

  // Specific query uniquely identifies one object → go straight to it.
  if (uniqueHits.length === 1) {
    const best = uniqueHits[0]!;
    const text = await speakRecall(query, best);
    return {
      text,
      query,
      needsChoice: false,
      objectId: best.id,
      matches,
    };
  }

  // Multiple cards (e.g. several laptops) → UI picker.
  const labels = matches.map((m) => m.phrase).slice(0, 5).join("; ");
  return {
    text: `I found ${matches.length} matches for “${query.trim()}”: ${labels}. Pick one to open its last-seen location.`,
    query,
    needsChoice: true,
    matches,
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
