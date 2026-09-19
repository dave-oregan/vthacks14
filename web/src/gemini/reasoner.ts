import { generateWithFallback, hasGemini } from "./client.js";
import { formatObjectPhrase, type MemoryStore } from "../memory/store.js";

export async function answerRecallQuery(
  query: string,
  store: MemoryStore,
): Promise<{ text: string; objectId?: string }> {
  const hits = store.searchObjects(query);
  if (hits.length === 0) {
    // try broader: extract nouns
    const tokens = query.toLowerCase().replace(/[?.,]/g, " ").split(/\s+/);
    const interesting = tokens.filter((t) =>
      ["phone", "iphone", "laptop", "backpack", "bag", "bottle", "keys", "case"].includes(t),
    );
    for (const t of interesting) {
      hits.push(...store.searchObjects(t));
    }
  }

  const uniqueHits = [...new Map(hits.map((h) => [h.id, h])).values()];
  if (uniqueHits.length === 0) {
    return { text: `I don't have a memory matching “${query.trim()}” yet.` };
  }

  const best = uniqueHits[0]!;
  const loc = best.lastLocation
    ? `${best.lastLocation.latitude.toFixed(5)}, ${best.lastLocation.longitude.toFixed(5)}`
    : "unknown location";
  const when = new Date(best.lastSeenAtMs).toLocaleString();
  const phrase = formatObjectPhrase(best);

  let text = `Last seen: ${phrase}. Time: ${when}. Location: ${loc}. Sightings: ${best.sightingCount}.`;

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
          })}\nReply in one short spoken sentence for SIGHTLINE glasses.`,
        },
      ]);
      text = spoken.trim() || text;
    } catch {
      /* keep template */
    }
  }

  return { text, objectId: best.id };
}

export async function interpretMissionIntent(utterance: string): Promise<{
  intent: "track" | "recall" | "none";
  target?: string;
}> {
  const u = utterance.toLowerCase();
  if (/where.*(phone|iphone|laptop|backpack|bag|bottle|keys)/.test(u) || /last seen|find my|where did i leave/.test(u)) {
    const m = u.match(/(phone|iphone|laptop|backpack|bag|bottle|keys|case)/);
    return { intent: "recall", target: m?.[1] ?? utterance };
  }
  if (/track|watch|keep an eye|don't let me leave|guard/.test(u)) {
    const m = u.match(/(phone|iphone|laptop|backpack|bag|bottle|keys)/);
    return { intent: "track", target: m?.[1] ?? "backpack" };
  }
  return { intent: "none" };
}
