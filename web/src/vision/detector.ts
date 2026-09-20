/**
 * Local vision — COCO-SSD.
 * Prefers @tensorflow/tfjs-node; falls back to CPU so the server never fails to boot.
 *
 * Node 23+ removed util.isNullOrUndefined; tfjs-node still calls it — polyfill first.
 */
import util from "node:util";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import sharp from "sharp";
import { config } from "../config.js";
import type { BBox, Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";

// @tensorflow/tfjs-node does `require("util").isNullOrUndefined` — gone in Node 23+.
const nodeUtil = util as typeof util & { isNullOrUndefined?: (v: unknown) => boolean };
if (typeof nodeUtil.isNullOrUndefined !== "function") {
  nodeUtil.isNullOrUndefined = (v: unknown) => v === null || v === undefined;
}

const COCO_BASE: "mobilenet_v2" | "lite_mobilenet_v2" = "lite_mobilenet_v2";
const VISION_MAX_WIDTH = 480;
const PREVIEW_MAX_WIDTH = 560;
const PREVIEW_QUALITY = 48;

let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;
let backendReady: Promise<void> | null = null;

async function ensureBackend(): Promise<void> {
  if (!backendReady) {
    backendReady = (async () => {
      try {
        await import("@tensorflow/tfjs-node");
        await tf.ready();
        // Smoke-test Cast — if util polyfill failed, fall through to CPU.
        const t = tf.tensor1d([1], "int32");
        try {
          t.cast("float32").dispose();
        } finally {
          t.dispose();
        }
      } catch (err) {
        console.warn(
          "[vision] tfjs-node unavailable, using CPU:",
          err instanceof Error ? err.message : err,
        );
        await import("@tensorflow/tfjs-backend-cpu");
        await tf.setBackend("cpu");
        await tf.ready();
      }
      console.log(`[vision] backend=${tf.getBackend()}`);
    })();
  }
  return backendReady;
}

async function getModel(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise) {
    modelPromise = (async () => {
      await ensureBackend();
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
    const minScore = Math.min(0.5, Math.max(0.2, config.visionMinScore));
    const predictions = await model.detect(tensor, 20, minScore);
    return predictions.map((p, index) => toDetection(p, info.width, info.height, index));
  } finally {
    tensor.dispose();
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

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
