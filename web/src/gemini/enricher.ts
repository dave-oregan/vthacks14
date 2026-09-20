/**
 * Optional Gemini polish — heavily constrained to avoid hallucination.
 * Prefer local appearance.ts; only call Gemini rarely when quota allows.
 */
import sharp from "sharp";
import { generateWithFallback, hasGemini } from "./client.js";
import type { Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";
import { isHumanSubjectLabel } from "../vision/appearance.js";

const ALLOWED_COLORS = new Set([
  "black",
  "white",
  "grey",
  "gray",
  "silver",
  "blue",
  "red",
  "green",
  "yellow",
  "pink",
  "purple",
  "orange",
  "brown",
  "gold",
  "navy",
  "teal",
  "maroon",
]);

const ALLOWED_MATERIALS = new Set([
  "plastic",
  "clear plastic",
  "dark plastic",
  "metal",
  "fabric",
  "leather",
  "silicone",
  "case",
  "glass",
  "wood",
]);

let cooldownUntil = 0;

export async function enrichDetectionsWithGemini(
  jpeg: Buffer,
  detections: Detection[],
): Promise<Detection[]> {
  if (!hasGemini() || detections.length === 0) return detections;
  if (Date.now() < cooldownUntil) return detections;

  try {
    const small = await sharp(jpeg)
      .rotate()
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();

    const prompt = `You label appearance of ALREADY DETECTED objects. Do not invent objects.
Keep each coco label. Only add color + optional material from what is VISIBLE in that bbox.
NEVER assign color or material to people, fists, hands, faces, or other body parts.

Allowed colors: ${[...ALLOWED_COLORS].join(", ")}
Allowed materials: ${[...ALLOWED_MATERIALS].join(", ")}

Detections:
${JSON.stringify(
  detections.map((d, i) => ({
    bboxIndex: i,
    label: d.label,
    hint: d.displayName,
    bbox: d.bbox,
  })),
)}

Return JSON only:
{ "items": [ { "bboxIndex": 0, "color": "black", "material": "plastic" } ] }
One item per bboxIndex. If unsure, omit material. NEVER invent brands.
Omit color/material entirely for person/people/fist/hand/face.`;

    const text = await generateWithFallback(
      [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: small.toString("base64") } },
      ],
      { responseMimeType: "application/json" },
    );

    const parsed = JSON.parse(stripFence(text)) as {
      items?: Array<{ bboxIndex?: number; color?: string; material?: string }>;
    };

    const byIndex = new Map<number, { color?: string; material?: string }>();
    for (const item of parsed.items ?? []) {
      if (typeof item?.bboxIndex === "number") byIndex.set(item.bboxIndex, item);
    }

    return detections.map((det, i) => {
      const enrich = byIndex.get(i);
      if (!enrich) return det;
      const label = normalizeLabel(det.label);
      if (isHumanSubjectLabel(label)) {
        return { ...det, label, displayName: label, descriptors: unique([label]) };
      }
      const color = sanitize(enrich.color, ALLOWED_COLORS);
      const material = sanitize(enrich.material, ALLOWED_MATERIALS);
      const descriptors = unique(
        [color, material, ...det.descriptors, label].filter(Boolean) as string[],
      );
      const displayName = unique(
        [color, material].filter(Boolean) as string[],
      )
        .concat([label])
        .join(" ");
      return {
        ...det,
        label,
        displayName,
        descriptors,
        source: "gemini" as const,
      };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[gemini] enrich failed:", msg);
    if (/429|quota|rate/i.test(msg)) {
      cooldownUntil = Date.now() + 60_000;
      console.warn("[gemini] cooling down 60s after quota/rate limit");
    }
    return detections;
  }
}

function sanitize(value: string | undefined, allowed: Set<string>): string | null {
  if (!value) return null;
  const k = value.toLowerCase().trim().replace(/\s+/g, " ");
  if (allowed.has(k)) return k === "gray" ? "grey" : k;
  // allow multi-word if both parts allowed? e.g. clear plastic
  if (allowed.has(k)) return k;
  return null;
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? trimmed).trim();
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const k = i.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
