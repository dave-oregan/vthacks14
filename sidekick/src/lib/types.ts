export type Tone = "roast" | "nice";

export type AbilityId = "recall" | "memory" | "guardian" | "mission" | "voice";

export interface Ability {
  id: AbilityId;
  name: string;
  icon: string;
  description: string;
}

export interface SidekickProfile {
  archetype: string;
  subtitle: string;
  scores: {
    memory: number;
    situationalAwareness: number;
    survivalInstinct: number;
    chaos: number;
  };
  diagnosis: string;
  recommendedAbility: Ability;
  verdict: string;
}

export interface AnalyzeRequest {
  answer1: string;
  answer2: string;
  answer3: string;
  tone: Tone;
}

/** Canonical SIGHTLINE-inspired capability set. The model must pick one of these. */
export const ABILITIES: Record<AbilityId, Ability> = {
  recall: {
    id: "recall",
    name: "RECALL",
    icon: "search",
    description:
      "Your glasses remember where things are so you don't have to.",
  },
  memory: {
    id: "memory",
    name: "MEMORY",
    icon: "brain",
    description:
      "Remembers conversations, context, and the people you meet.",
  },
  guardian: {
    id: "guardian",
    name: "GUARDIAN",
    icon: "shield",
    description:
      "Situational awareness that spots hazards before you do.",
  },
  mission: {
    id: "mission",
    name: "MISSION",
    icon: "target",
    description:
      "Tracks what matters and warns you before you leave it behind.",
  },
  voice: {
    id: "voice",
    name: "VOICE",
    icon: "wave",
    description:
      "Ambient conversational AI whispering in your ear, politely.",
  },
};

export const ABILITY_IDS = Object.keys(ABILITIES) as AbilityId[];
