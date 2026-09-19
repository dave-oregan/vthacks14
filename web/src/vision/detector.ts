import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import sharp from "sharp";
import { config } from "../config.js";
import { generateWithFallback, hasGemini } from "../gemini/client.js";
import type { BBox, Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";

/**
 * lite_mobilenet_v2 is the default coco-ssd browser demo model — solid for phones/laptops
 * and much faster on CPU than full mobilnet_v2 (keeps stream smooth).
 */
const COCO_BASE: "mobilenet_v2" | "lite_mobilenet_v2" = "lite_mobilenet_v2";
const VISION_MAX_WIDTH = 512;
const PREVIEW_MAX_WIDTH = 640;
const PREVIEW_QUALITY = 55;

let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;

async function getModel(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise) {
    modelPromise = (async () => {
      await tf.setBackend("cpu");
      await tf.ready();
      console.log(`[vision] loading COCO-SSD (${COCO_BASE})…`);
      const model = await cocoSsd.load({ base: COCO_BASE });
      console.log("[vision] COCO-SSD ready");
      return model;
    })();
  }
  return modelPromise;
}

/** Downscale JPEG for live Mission Control preview (keeps UI responsive). */
export async function makePreviewJpeg(jpeg: Buffer): Promise<Buffer> {
  return sharp(jpeg)
    .rotate()
    .resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
    .toBuffer();
}

export async function detectObjects(jpeg: Buffer): Promise<Detection[]> {
  const resized = await sharp(jpeg)
    .rotate()
    .resize({ width: VISION_MAX_WIDTH, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const model = await getModel();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");

  try {
    // Pass minScore into NMS so threshold actually affects which boxes survive.
    const minScore = Math.min(0.5, Math.max(0.2, config.visionMinScore));
    const predictions = await model.detect(tensor, 20, minScore);
    return predictions.map((p, index) => toDetection(p, info.width, info.height, index));
  } finally {
    tensor.dispose();
  }
}

/**
 * Enrich coco boxes with Gemini descriptors — never invents new boxes.
 * (Full-scene Gemini boxes were misaligned and made recognition look broken.)
 */
export async function enrichWithGemini(
  jpeg: Buffer,
  detections: Detection[],
): Promise<Detection[]> {
  if (!hasGemini() || detections.length === 0) return detections;

  try {
    const small = await sharp(jpeg)
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();

    const prompt = `You are SIGHTLINE vision for AR glasses.
Enrich EACH listed detection using the image. Do NOT add or remove objects.
Keep bboxIndex order exactly.

Detections:
${JSON.stringify(
  detections.map((d, i) => ({
    bboxIndex: i,
    label: d.label,
    confidence: Number(d.confidence.toFixed(2)),
    bbox: d.bbox,
  })),
)}

Return JSON only:
{
  "items": [
    {
      "bboxIndex": 0,
      "label": "cell phone",
      "displayName": "black silicone phone case",
      "descriptors": ["black", "silicone", "phone", "case"]
    }
  ]
}

Rules:
- One item per bboxIndex 0..${detections.length - 1}
- label: keep the coco class unless clearly wrong (e.g. remote vs phone)
- displayName: short human phrase (color + object)
- descriptors: 2–5 appearance words`;

    const text = await generateWithFallback(
      [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: small.toString("base64") } },
      ],
      { responseMimeType: "application/json" },
    );

    const parsed = JSON.parse(stripFence(text)) as {
      items?: Array<{
        bboxIndex?: number;
        label?: string;
        displayName?: string;
        descriptors?: string[];
      }>;
    };

    const byIndex = new Map<
      number,
      { label?: string; displayName?: string; descriptors?: string[] }
    >();
    for (const item of parsed.items ?? []) {
      if (typeof item?.bboxIndex === "number") byIndex.set(item.bboxIndex, item);
    }

    return detections.map((det, i) => {
      const enrich = byIndex.get(i);
      if (!enrich) return det;
      const label = enrich.label ? normalizeLabel(enrich.label) : det.label;
      const descriptors = unique([
        ...(enrich.descriptors ?? []),
        enrich.displayName || "",
        ...det.descriptors,
        label,
      ]);
      return {
        ...det,
        label,
        displayName: (enrich.displayName || det.displayName).trim(),
        descriptors,
        source: "gemini" as const,
      };
    });
  } catch (err) {
    console.warn("[vision] Gemini enrich failed:", err instanceof Error ? err.message : err);
    return detections;
  }
}

export async function cropThumb(
  jpeg: Buffer,
  bbox: BBox,
): Promise<Buffer | null> {
  try {
    const rotated = sharp(jpeg).rotate();
    const meta = await rotated.metadata();
    const w = meta.width ?? 1;
    const h = meta.height ?? 1;
    const left = Math.max(0, Math.floor(bbox.x * w));
    const top = Math.max(0, Math.floor(bbox.y * h));
    const width = Math.max(1, Math.min(w - left, Math.floor(bbox.width * w)));
    const height = Math.max(1, Math.min(h - top, Math.floor(bbox.height * h)));
    return await rotated
      .extract({ left, top, width, height })
      .resize(96, 96, { fit: "cover" })
      .jpeg({ quality: 55 })
      .toBuffer();
  } catch {
    return null;
  }
}

function toDetection(
  p: cocoSsd.DetectedObject,
  width: number,
  height: number,
  index: number,
): Detection {
  const label = normalizeLabel(p.class);
  const bbox: BBox = {
    x: clamp01(p.bbox[0] / width),
    y: clamp01(p.bbox[1] / height),
    width: clamp01(p.bbox[2] / width),
    height: clamp01(p.bbox[3] / height),
  };
  return {
    trackId: `det-${index}-${label}-${Math.round(bbox.x * 40)}-${Math.round(bbox.y * 40)}`,
    label,
    displayName: label,
    descriptors: [label],
    confidence: p.score,
    bbox,
    source: "coco",
  };
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? trimmed).trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
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
