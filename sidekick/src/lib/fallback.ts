// ─────────────────────────────────────────────────────────────
// DEVELOPMENT-ONLY FALLBACK
// Deterministic profile generator used when HokieAI credentials
// are not configured (or SIDEKICK_FORCE_FALLBACK=true). It lets the
// full UI be demoed offline. The real path always calls HokieAI.
// ─────────────────────────────────────────────────────────────

import { ABILITIES, type AbilityId, type SidekickProfile, type Tone } from "./types";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: T[], h: number, salt: number): T {
  return arr[(h + salt * 2654435761) % arr.length];
}

const ROAST_ARCHETYPES = [
  "THE CHAOTIC INVENTOR",
  "THE WALKING LINTER ERROR",
  "THE BEAUTIFUL DISASTER",
  "THE HUMAN BROWSER TAB",
  "THE SLEEP-DEPRIVED VISIONARY",
  "THE ORGANIZED MESS",
  "THE CONTEXT-SWITCHING CHAMPION",
];

const NICE_ARCHETYPES = [
  "THE QUIET OVERACHIEVER",
  "THE CURIOUS EXPLORER",
  "THE DEEP-FOCUS BUILDER",
  "THE SOCIAL NAVIGATOR",
  "THE STEADY STRATEGIST",
  "THE CREATIVE ENGINE",
];

const ROAST_SUBTITLES = [
  "Your brain has 47 tabs open and three are playing music.",
  "Object permanence: still in beta.",
  "Powered by vibes and unresolved deadlines.",
  "A marvel of engineering. The engineering is concerned.",
  "Running production on a dev build.",
];

const NICE_SUBTITLES = [
  "Quietly running circles around everyone.",
  "A calm kernel with chaotic userland.",
  "Compounding focus since day one.",
  "Signal over noise, mostly.",
];

const ITEM_VERDICTS_ROAST = [
  "You don't need another assistant. You need a second brain.",
  "Your glasses will file a missing-persons report for your keys. Daily.",
  "Somewhere, a version of you remembers everything. It's not this version.",
  "You are one push notification away from total system failure.",
];

const ITEM_VERDICTS_NICE = [
  "You're already sharp — your glasses just give you receipts.",
  "A little ambient memory and you're basically unstoppable.",
  "You don't need supervision. You need a really good sidekick.",
];

function abilityFor(a2: string, a3: string, h: number): AbilityId {
  const t = `${a2} ${a3}`.toLowerCase();
  if (/unsafe|hazard|gym/.test(t)) return "guardian";
  if (/forget|deadline|leave|keys|phone|airpods|parked/.test(t)) return "mission";
  if (/meeting people|names|conversation|talking/.test(t)) return "memory";
  if (/overwhelmed|five things|all the time/.test(t)) return "voice";
  const pool: AbilityId[] = ["recall", "memory", "mission"];
  return pool[h % pool.length];
}

export function fallbackProfile(
  answer1: string,
  answer2: string,
  answer3: string,
  tone: Tone
): SidekickProfile {
  const h = hash(`${answer1}|${answer2}|${answer3}|${tone}`);
  const roast = tone === "roast";

  const archetype = pick(roast ? ROAST_ARCHETYPES : NICE_ARCHETYPES, h, 1);
  const subtitle = pick(roast ? ROAST_SUBTITLES : NICE_SUBTITLES, h, 2);

  // Scores: biased by answers, jittered by hash.
  const j = (salt: number, base: number) =>
    Math.min(97, Math.max(8, base + ((h >> salt) % 37) - 18));
  const forgetful = /everything|keys|phone|airpods|parked|names|deadline/i.test(answer1);
  const chaosy = /five things|all the time|partying|dumb decision/i.test(
    `${answer2} ${answer3}`
  );
  const scores = {
    memory: j(3, forgetful ? 34 : 68),
    situationalAwareness: j(7, /unsafe|wandering/i.test(answer2 + answer3) ? 48 : 66),
    survivalInstinct: j(11, chaosy ? 41 : 74),
    chaos: j(5, chaosy ? 88 : 52),
  };

  const ability = ABILITIES[abilityFor(answer2, answer3, h)];

  const diagnosis = roast
    ? `You said "${answer1.toLowerCase()}" and "${answer3.toLowerCase()}" in the same breath, which explains a lot. ` +
      `Your short-term memory has the retention policy of a Snapchat message, yet you'll confidently sprint across campus for a thing that is already in your bag. ${ability.name} exists precisely for people like you.`
    : `Between "${answer1.toLowerCase()}" and "${answer3.toLowerCase()}", you're clearly carrying a lot — and handling it better than you give yourself credit for. ` +
      `A little ambient help with the details would let you spend that energy on the stuff you're actually good at. ${ability.name} fits you well.`;

  const verdict = pick(
    roast ? ITEM_VERDICTS_ROAST : ITEM_VERDICTS_NICE,
    h,
    4
  );

  return { archetype, subtitle, scores, diagnosis, recommendedAbility: ability, verdict };
}
