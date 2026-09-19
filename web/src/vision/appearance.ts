/**
 * Local appearance cues from bbox pixels — no LLM, no hallucination.
 * Produces phrases like "black laptop", "clear plastic bottle", "silver laptop".
 */
import sharp from "sharp";
import type { BBox, Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";

type Rgb = { r: number; g: number; b: number };

export async function describeDetectionsLocally(
  jpeg: Buffer,
  detections: Detection[],
): Promise<Detection[]> {
  if (!jpeg.length || detections.length === 0) return detections;
  const out: Detection[] = [];
  for (const det of detections) {
    out.push(await describeOne(jpeg, det));
  }
  return out;
}

async function describeOne(jpeg: Buffer, det: Detection): Promise<Detection> {
  const label = normalizeLabel(det.label);
  const sample = await sampleBBox(jpeg, det.bbox);
  if (!sample) {
    return {
      ...det,
      label,
      displayName: label,
      descriptors: unique([label, ...det.descriptors]),
    };
  }

  const color = nameColor(sample);
  const material = guessMaterial(label, sample);
  const descriptors = unique(
    [color, material, label, ...det.descriptors].filter(Boolean) as string[],
  );
  const displayName = unique(
    [color, material, label].filter((t) => t && t !== label) as string[],
  )
    .concat([label])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    ...det,
    label,
    displayName,
    descriptors,
    source: det.source === "gemini" ? "gemini" : "coco",
  };
}

async function sampleBBox(
  jpeg: Buffer,
  bbox: BBox,
): Promise<{ mean: Rgb; sat: number; lum: number; chroma: number } | null> {
  try {
    const rotated = sharp(jpeg).rotate();
    const meta = await rotated.metadata();
    const w = meta.width ?? 1;
    const h = meta.height ?? 1;
    // Sample inner 60% of box to avoid background bleed.
    const padX = bbox.width * 0.2;
    const padY = bbox.height * 0.2;
    const left = Math.max(0, Math.floor((bbox.x + padX) * w));
    const top = Math.max(0, Math.floor((bbox.y + padY) * h));
    const width = Math.max(2, Math.min(w - left, Math.floor(bbox.width * 0.6 * w)));
    const height = Math.max(2, Math.min(h - top, Math.floor(bbox.height * 0.6 * h)));

    const { data, info } = await rotated
      .extract({ left, top, width, height })
      .resize(24, 24, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0;
    let g = 0;
    let b = 0;
    let satSum = 0;
    let lumSum = 0;
    const n = info.width * info.height;
    for (let i = 0; i < data.length; i += 3) {
      const rr = data[i]!;
      const gg = data[i + 1]!;
      const bb = data[i + 2]!;
      r += rr;
      g += gg;
      b += bb;
      const mx = Math.max(rr, gg, bb) / 255;
      const mn = Math.min(rr, gg, bb) / 255;
      const lum = 0.2126 * (rr / 255) + 0.7152 * (gg / 255) + 0.0722 * (bb / 255);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      satSum += sat;
      lumSum += lum;
    }
    const mean = { r: r / n, g: g / n, b: b / n };
    const sat = satSum / n;
    const lum = lumSum / n;
    const chroma =
      (Math.max(mean.r, mean.g, mean.b) - Math.min(mean.r, mean.g, mean.b)) / 255;
    return { mean, sat, lum, chroma };
  } catch {
    return null;
  }
}

function nameColor(s: { mean: Rgb; sat: number; lum: number; chroma: number }): string {
  const { mean, sat, lum, chroma } = s;
  if (lum < 0.18) return "black";
  if (lum > 0.82 && sat < 0.18) return "white";
  if (sat < 0.14 || chroma < 0.08) {
    if (lum > 0.62) return "silver";
    if (lum > 0.38) return "grey";
    return "black";
  }
  const { r, g, b } = mean;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min || 1;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;

  if (h < 25 || h >= 345) return lum < 0.35 ? "maroon" : "red";
  if (h < 50) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

function guessMaterial(
  label: string,
  s: { sat: number; lum: number; chroma: number },
): string | null {
  switch (label) {
    case "bottle":
    case "cup":
    case "wine glass":
      if (s.lum > 0.7 && s.sat < 0.2) return "clear plastic";
      if (s.sat > 0.25) return "plastic";
      if (s.lum < 0.35) return "dark plastic";
      return "plastic";
    case "laptop":
    case "keyboard":
    case "mouse":
    case "tv":
    case "remote":
      if (s.lum > 0.55 && s.sat < 0.2) return "metal";
      return null;
    case "phone":
      if (s.lum < 0.28) return "case";
      return null;
    case "backpack":
    case "bag":
    case "handbag":
    case "suitcase":
      return "fabric";
    case "book":
      return null;
    default:
      return null;
  }
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
