/**
 * Browser COCO-SSD — same pattern as a Next/webcam demo (WebGL).
 * Runs in Mission Control so detection stays off the Node event loop.
 */
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

export type BrowserDetection = {
  trackId: string;
  label: string;
  displayName: string;
  descriptors: string[];
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  source: "coco";
};

const MIN_SCORE = 0.35;
let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;

async function getModel(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise) {
    modelPromise = (async () => {
      await tf.ready();
      // Prefer WebGL (GPU) like browser demos; fall back to CPU.
      try {
        await tf.setBackend("webgl");
        await tf.ready();
      } catch {
        await tf.setBackend("cpu");
        await tf.ready();
      }
      console.log(`[browser-vision] backend=${tf.getBackend()} loading lite_mobilenet_v2…`);
      const model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      console.log("[browser-vision] COCO-SSD ready");
      return model;
    })();
  }
  return modelPromise;
}

export async function detectInBrowser(
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
): Promise<BrowserDetection[]> {
  const model = await getModel();
  const width =
    "naturalWidth" in image && image.naturalWidth
      ? image.naturalWidth
      : "width" in image
        ? Number(image.width)
        : 1;
  const height =
    "naturalHeight" in image && image.naturalHeight
      ? image.naturalHeight
      : "height" in image
        ? Number(image.height)
        : 1;

  const predictions = await model.detect(image as HTMLImageElement, 20, MIN_SCORE);
  return predictions.map((p, index) => {
    const label = p.class.toLowerCase();
    const bbox = {
      x: clamp01(p.bbox[0] / width),
      y: clamp01(p.bbox[1] / height),
      width: clamp01(p.bbox[2] / width),
      height: clamp01(p.bbox[3] / height),
    };
    return {
      trackId: `bdet-${index}-${label}-${Math.round(bbox.x * 40)}-${Math.round(bbox.y * 40)}`,
      label,
      displayName: label,
      descriptors: [label],
      confidence: p.score,
      bbox,
      source: "coco" as const,
    };
  });
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
