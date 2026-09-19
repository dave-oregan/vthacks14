import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import sharp from "sharp";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import type { BBox, Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";
import { v4 as uuid } from "uuid";

const INTERESTING = new Set([
  "cell phone",
  "phone",
  "laptop",
  "backpack",
  "handbag",
  "book",
  "bottle",
  "cup",
  "keyboard",
  "mouse",
  "remote",
  "tv",
  "person",
  "chair",
  "couch",
  "bed",
  "umbrella",
  "suitcase",
  "tie",
  "clock",
]);

let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;

async function getModel(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise) {
    modelPromise = (async () => {
      await tf.setBackend("cpu");
      await tf.ready();
      console.log("[vision] loading COCO-SSD…");
      const model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      console.log("[vision] COCO-SSD ready");
      return model;
    })();
  }
  return modelPromise;
}

export async function detectObjects(jpeg: Buffer): Promise<Detection[]> {
  const { data, info } = await sharp(jpeg)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const model = await getModel();
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);

  try {
    const predictions = await model.detect(tensor as unknown as ImageData);
    return predictions
      .filter((p) => p.score >= config.visionMinScore)
      .filter((p) => INTERESTING.has(p.class.toLowerCase()) || p.score > 0.7)
      .map((p) => {
        const label = normalizeLabel(p.class);
        const bbox: BBox = {
          x: p.bbox[0] / info.width,
          y: p.bbox[1] / info.height,
          width: p.bbox[2] / info.width,
          height: p.bbox[3] / info.height,
        };
        return {
          trackId: `coco-${label}-${Math.round(bbox.x * 100)}-${Math.round(bbox.y * 100)}`,
          label,
          displayName: label,
          descriptors: [label],
          confidence: p.score,
          bbox,
          source: "coco" as const,
        };
      });
  } finally {
    tensor.dispose();
  }
}

export async function enrichWithGemini(
  jpeg: Buffer,
  detections: Detection[],
): Promise<Detection[]> {
  if (!config.geminiApiKey || detections.length === 0) return detections;

  try {
    const genAI = new GoogleGenerativeAI(config.geminiApiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    const b64 = jpeg.toString("base64");
    const prompt = `You are SIGHTLINE vision. Given this first-person photo and these detections:
${JSON.stringify(detections.map((d) => ({ label: d.label, confidence: d.confidence, bbox: d.bbox })))}

Return JSON: { "items": [ { "label": "phone|laptop|backpack|...", "displayName": "short name", "descriptors": ["black","case","leather",...], "confidence": 0.0-1.0, "bboxIndex": 0 } ] }
Focus on distinctive appearance (color, case, brand cues, size). Prefer concrete phrases like "black case phone". Max 6 items.`;

    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: b64 } },
    ]);
    const text = result.response.text();
    const parsed = JSON.parse(text) as {
      items?: Array<{
        label: string;
        displayName?: string;
        descriptors?: string[];
        confidence?: number;
        bboxIndex?: number;
      }>;
    };

    return (parsed.items ?? []).map((item, i) => {
      const base = detections[item.bboxIndex ?? i] ?? detections[0]!;
      const label = normalizeLabel(item.label || base.label);
      const descriptors = unique([
        ...(item.descriptors ?? []),
        label,
        ...(item.displayName ? [item.displayName] : []),
      ]);
      return {
        trackId: base.trackId || `gem-${uuid().slice(0, 8)}`,
        label,
        displayName: item.displayName || descriptors.slice(0, 3).join(" ") || label,
        descriptors,
        confidence: item.confidence ?? base.confidence,
        bbox: base.bbox,
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
    const meta = await sharp(jpeg).metadata();
    const w = meta.width ?? 1;
    const h = meta.height ?? 1;
    const left = Math.max(0, Math.floor(bbox.x * w));
    const top = Math.max(0, Math.floor(bbox.y * h));
    const width = Math.max(1, Math.min(w - left, Math.floor(bbox.width * w)));
    const height = Math.max(1, Math.min(h - top, Math.floor(bbox.height * h)));
    return await sharp(jpeg)
      .extract({ left, top, width, height })
      .resize(160, 160, { fit: "cover" })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
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
