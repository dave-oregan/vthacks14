/**
 * LocateAnything category lists for Guardian Mode.
 * Observation-oriented — weapons are classes to detect, not judgments about people.
 */

export const DEFAULT_CATEGORIES = [
  "cell phone",
  "laptop",
  "backpack",
  "handbag",
  "bottle",
  "cup",
  "book",
  "remote",
  "keyboard",
  "mouse",
  "person",
  "suitcase",
  "umbrella",
];

/** Classes when Guardian Mode is active. */
export const GUARDIAN_CATEGORIES = [
  // Potential threats (observations only)
  "gun",
  "handgun",
  "pistol",
  "rifle",
  "firearm",
  "weapon",
  "knife",
  "blade",
  "machete",
  // People / altercation cues (neutral)
  "person",
  "crowd",
  "group of people",
  "fist",
  "fighting",
  "punching",
  "raised fist",
  // Vehicles
  "license plate",
  "car",
  "truck",
  "vehicle",
  // Safety resources
  "AED",
  "defibrillator",
  "fire extinguisher",
  "first aid kit",
  "emergency exit",
  "stairwell",
  "elevator",
  "fire alarm",
  // Hazards
  "smoke",
  "fire",
  "broken glass",
  "debris",
  // Environment / location cues
  "street sign",
  "address sign",
  "exit sign",
];

/** @deprecated Use GUARDIAN_CATEGORIES */
export const POLICE_CATEGORIES = GUARDIAN_CATEGORIES;

export function getDetectCategories(guardianMode: boolean): string[] {
  if (!guardianMode) return DEFAULT_CATEGORIES;
  return [...GUARDIAN_CATEGORIES];
}
