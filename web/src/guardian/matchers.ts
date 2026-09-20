import type { Detection } from "../shared/types.js";

export const WEAPON_RE =
  /\b(gun|handgun|pistol|rifle|firearm|weapon|knife|blade|machete)\b/i;
export const PLATE_RE =
  /\b(license\s*plate|number\s*plate|licence\s*plate|plate)\b/i;
export const PERSON_RE =
  /\b(person|people|crowd|pedestrian|human)\b/i;
export const ALTERCATION_RE =
  /\b(fight|fighting|punch|punching|fist|raised\s*fist|scuffle|brawl|altercation)\b/i;
export const SAFETY_RESOURCE_RE =
  /\b(aed|defibrillator|fire\s*extinguisher|extinguisher|first[\s-]?aid|emergency\s*exit|exit\s*sign|stairwell|elevator|emergency\s*phone|fire\s*alarm|pull\s*station)\b/i;
export const HAZARD_RE =
  /\b(smoke|fire|flames|broken\s*glass|blocked\s*exit|debris|collision|wreck|obstruction)\b/i;
export const ADDRESS_RE =
  /\b(street\s*sign|address|building\s*number|room\s*number|exit\s*label|road\s*sign)\b/i;
export const DISTRESS_PHRASE_RE =
  /\b(help|help me|officer down|mayday|emergency|i need help)\b/i;

export function nameOf(d: Detection): string {
  return `${d.label} ${d.displayName}`;
}

export function prettyLabel(d: Detection): string {
  return (d.displayName || d.label || "object").trim();
}

export function normalizeKey(d: Detection): string {
  const label = (d.label || "").toLowerCase().replace(/\s+/g, "_");
  return `${label}:${Math.round(d.bbox.x * 10)}:${Math.round(d.bbox.y * 10)}`;
}

export function isFirearmLabel(label: string): boolean {
  return /\b(gun|handgun|pistol|rifle|firearm)\b/i.test(label);
}

export function isBladeLabel(label: string): boolean {
  return /\b(knife|blade|machete)\b/i.test(label);
}

export function safetyResourceType(label: string): string {
  const s = label.toLowerCase();
  if (/\baed\b|defibrillator/.test(s)) return "aed";
  if (/extinguisher/.test(s)) return "fire_extinguisher";
  if (/first[\s-]?aid/.test(s)) return "first_aid_kit";
  if (/emergency\s*exit|exit\s*sign/.test(s)) return "emergency_exit";
  if (/stairwell/.test(s)) return "stairwell";
  if (/elevator/.test(s)) return "elevator";
  if (/emergency\s*phone/.test(s)) return "emergency_phone";
  if (/fire\s*alarm|pull\s*station/.test(s)) return "fire_alarm";
  return "safety_resource";
}

export function countDistinctPeople(people: Detection[]): number {
  if (people.length === 0) return 0;
  const kept: Detection[] = [];
  for (const p of people.slice().sort((a, b) => b.confidence - a.confidence)) {
    const dup = kept.some(
      (k) =>
        Math.abs(k.bbox.x - p.bbox.x) < 0.08 &&
        Math.abs(k.bbox.y - p.bbox.y) < 0.08 &&
        Math.abs(k.bbox.width - p.bbox.width) < 0.12,
    );
    if (!dup) kept.push(p);
  }
  return kept.length;
}
