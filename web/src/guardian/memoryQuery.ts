import type { GuardianEvent } from "../shared/types.js";

/**
 * Deterministic natural-language query over GuardianEvent memory.
 * Never invents observations — answers only from recorded events.
 */
export function queryGuardianMemory(
  events: GuardianEvent[],
  rawQuery: string,
): { text: string; matches: GuardianEvent[] } {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return { text: "Ask about a recent observation (plate, AED, firearm, smoke, address…).", matches: [] };
  }

  const active = events.filter((e) => e.status !== "dismissed");
  if (active.length === 0) {
    return {
      text: "I don’t have a recorded observation matching that request.",
      matches: [],
    };
  }

  let filtered = active;

  if (/\b(plate|license)\b/.test(q)) {
    filtered = active.filter(
      (e) => e.category === "vehicle" || /\bplate\b/i.test(e.title + e.description),
    );
  } else if (/\b(aed|defibrillator|extinguisher|first[\s-]?aid|exit|stairwell|elevator)\b/.test(q)) {
    filtered = active.filter((e) => e.category === "safety_resource");
  } else if (/\b(gun|firearm|weapon|knife|blade|threat)\b/.test(q)) {
    filtered = active.filter((e) => e.category === "potential_threat");
  } else if (/\b(smoke|fire|hazard|debris|glass)\b/.test(q)) {
    filtered = active.filter((e) => e.category === "hazard");
  } else if (/\b(address|street|building|room)\b/.test(q)) {
    filtered = active.filter((e) => e.category === "location");
  } else if (/\b(distress|help|fall|down)\b/.test(q)) {
    filtered = active.filter((e) => e.category === "distress" || e.category === "medical");
  } else if (/\b(vehicle|car|truck|sedan|pickup)\b/.test(q)) {
    filtered = active.filter((e) => e.category === "vehicle");
  } else if (/\b(last|recent|two minutes|2 minutes|timeline)\b/.test(q)) {
    const cutoff = Date.now() - 120_000;
    filtered = active.filter((e) => e.timestamp >= cutoff);
  } else {
    // Keyword overlap against title/description/type
    const tokens = q.split(/\W+/).filter((t) => t.length > 2);
    filtered = active.filter((e) => {
      const hay = `${e.type} ${e.title} ${e.description}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    });
  }

  if (filtered.length === 0) {
    return {
      text: "I don’t have a recorded observation matching that request.",
      matches: [],
    };
  }

  const sorted = filtered.slice().sort((a, b) => b.timestamp - a.timestamp);
  const top = sorted.slice(0, 5);
  const lines = top.map((e) => {
    const ago = formatAgo(Date.now() - e.timestamp);
    const conf =
      typeof e.confidence === "number" ? ` (${Math.round(e.confidence * 100)}%)` : "";
    return `• ${e.title}${conf} — ${ago}`;
  });

  return {
    text: `From Guardian memory:\n${lines.join("\n")}`,
    matches: top,
  };
}

function formatAgo(ms: number): string {
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(Date.now() - ms).toLocaleTimeString();
}
