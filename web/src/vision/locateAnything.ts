/**
 * Optional NVIDIA LocateAnything client.
 *
 * LocateAnything ([project page](https://research.nvidia.com/labs/lpr/locate-anything/))
 * is a 3B VLM with Parallel Box Decoding — needs a CUDA GPU (~7–8GB weights).
 * It does not run in-process on a Mac laptop. Point LOCATE_ANYTHING_URL at a
 * remote worker (Modal / DGX / self-hosted FastAPI) that exposes POST /detect.
 *
 * Expected request:  { image_base64, categories?: string[], generation_mode?: string }
 * Expected response: { items: [{ label, confidence?, bbox: {x,y,width,height} }] }
 *                    bbox normalized 0..1, or absolute pixels if image_width/height given
 */
import { config } from "../config.js";
import type { BBox, Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";

const DEFAULT_CATEGORIES = [
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

export function hasLocateAnything(): boolean {
  return Boolean(config.locateAnythingUrl);
}

export async function detectWithLocateAnything(jpeg: Buffer): Promise<Detection[]> {
  const base = config.locateAnythingUrl;
  if (!base) return [];

  const url = base.replace(/\/$/, "") + "/detect";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.locateAnythingTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        image_base64: jpeg.toString("base64"),
        categories: DEFAULT_CATEGORIES,
        generation_mode: "hybrid",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const data = (await res.json()) as {
      image_width?: number;
      image_height?: number;
      items?: Array<{
        label?: string;
        displayName?: string;
        confidence?: number;
        bbox?: Partial<BBox> & { x1?: number; y1?: number; x2?: number; y2?: number };
      }>;
      // some servers return answer string — ignore if no items
    };

    const imgW = data.image_width;
    const imgH = data.image_height;
    const out: Detection[] = [];
    for (const [index, item] of (data.items ?? []).entries()) {
      const bbox = normalizeRemoteBBox(item.bbox, imgW, imgH);
      if (!bbox) continue;
      const label = normalizeLabel(item.label || item.displayName || "object");
      out.push({
        trackId: `la-${index}-${label}-${Math.round(bbox.x * 40)}-${Math.round(bbox.y * 40)}`,
        label,
        displayName: (item.displayName || label).trim(),
        descriptors: [label],
        confidence: clamp01(item.confidence ?? 0.75),
        bbox,
        source: "locateanything",
      });
    }
    return out;
  } catch (err) {
    console.warn(
      "[locate-anything] detect failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRemoteBBox(
  b: (Partial<BBox> & { x1?: number; y1?: number; x2?: number; y2?: number }) | undefined,
  imgW?: number,
  imgH?: number,
): BBox | null {
  if (!b) return null;

  // xyxy absolute or normalized
  if (
    typeof b.x1 === "number" &&
    typeof b.y1 === "number" &&
    typeof b.x2 === "number" &&
    typeof b.y2 === "number"
  ) {
    let x1 = b.x1;
    let y1 = b.y1;
    let x2 = b.x2;
    let y2 = b.y2;
    const looksAbsolute = x2 > 1.5 || y2 > 1.5;
    if (looksAbsolute && imgW && imgH) {
      x1 /= imgW;
      y1 /= imgH;
      x2 /= imgW;
      y2 /= imgH;
    }
    return {
      x: clamp01(Math.min(x1, x2)),
      y: clamp01(Math.min(y1, y2)),
      width: clamp01(Math.abs(x2 - x1)),
      height: clamp01(Math.abs(y2 - y1)),
    };
  }

  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 0.01 || height < 0.01) return null;
  return { x: clamp01(x), y: clamp01(y), width: clamp01(width), height: clamp01(height) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
