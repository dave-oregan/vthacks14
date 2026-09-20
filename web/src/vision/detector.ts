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

/**
 * Crop a memory thumbnail from a frame using a normalized bbox (0..1).
 * Phone JPEGs often carry EXIF orientation — we must measure dimensions
 * *after* applying `.rotate()`, otherwise crops land off-canvas (black thumbs).
 */
export async function cropThumb(
  jpeg: Buffer,
  bbox: BBox,
): Promise<Buffer | null> {
  if (!jpeg?.length) return null;
  try {
    const oriented = await sharp(jpeg).rotate().toBuffer({ resolveWithObject: true });
    const w = oriented.info.width || 1;
    const h = oriented.info.height || 1;

    // Slight pad so the object isn't clipped at the box edge.
    const padX = Math.max(0.02, bbox.width * 0.08);
    const padY = Math.max(0.02, bbox.height * 0.08);
    const x0 = clamp01(bbox.x - padX);
    const y0 = clamp01(bbox.y - padY);
    const x1 = clamp01(bbox.x + bbox.width + padX);
    const y1 = clamp01(bbox.y + bbox.height + padY);

    let left = Math.floor(x0 * w);
    let top = Math.floor(y0 * h);
    let width = Math.max(1, Math.floor((x1 - x0) * w));
    let height = Math.max(1, Math.floor((y1 - y0) * h));
    if (left + width > w) width = Math.max(1, w - left);
    if (top + height > h) height = Math.max(1, h - top);

    // Degenerate / empty box → fall back to a centered scene crop.
    if (width < 8 || height < 8 || !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height)) {
      return await sceneThumb(oriented.data, w, h);
    }

    const thumb = await sharp(oriented.data)
      .extract({ left, top, width, height })
      .resize(160, 160, { fit: "cover" })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();

    // If the crop is nearly black (wrong region / night / bad coords), use scene.
    const stats = await sharp(thumb).stats();
    const mean =
      stats.channels.reduce((s, c) => s + c.mean, 0) / Math.max(1, stats.channels.length);
    if (mean < 8) {
      return await sceneThumb(oriented.data, w, h);
    }
    return thumb;
  } catch {
    try {
      return await sharp(jpeg)
        .rotate()
        .resize(160, 160, { fit: "cover" })
        .jpeg({ quality: 72, mozjpeg: true })
        .toBuffer();
    } catch {
      return null;
    }
  }
}

/** Full-frame (or center) thumb when object crop fails. */
async function sceneThumb(orientedJpeg: Buffer, w: number, h: number): Promise<Buffer> {
  const side = Math.min(w, h);
  const left = Math.max(0, Math.floor((w - side) / 2));
  const top = Math.max(0, Math.floor((h - side) / 2));
  return sharp(orientedJpeg)
    .extract({ left, top, width: side, height: side })
    .resize(160, 160, { fit: "cover" })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
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
