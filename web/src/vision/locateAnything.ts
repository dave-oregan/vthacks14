/**
 * Optional NVIDIA LocateAnything client.
 *
 * LocateAnything ([project page](https://research.nvidia.com/labs/lpr/locate-anything/))
 * is a 3B VLM with Parallel Box Decoding — needs a CUDA GPU (~7–8GB weights).
 * It does not run in-process on a Mac laptop. Point LOCATE_ANYTHING_URL at a
 * remote worker (Modal / DGX / self-hosted FastAPI) that exposes POST /detect.
 *
 * Expected request:  { image_base64, categories?, generation_mode? }
 * Expected response: { items: [{ label, confidence?, bbox: {x,y,width,height} }] }
 *                    bbox normalized 0..1, or absolute pixels if image_width/height given
 */
import { config } from "../config.js";
import type { BBox, Detection } from "../shared/types.js";
import { normalizeLabel } from "../memory/store.js";
import sharp from "sharp";

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

/** Extra LocateAnything classes when Police mode is on. */
export const POLICE_CATEGORIES = [
  "gun",
  "handgun",
  "pistol",
  "rifle",
  "firearm",
  "weapon",
  "knife",
  "blade",
  "license plate",
  "car",
  "person",
];

export function getDetectCategories(policeMode: boolean): string[] {
  if (!policeMode) return DEFAULT_CATEGORIES;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...POLICE_CATEGORIES, ...DEFAULT_CATEGORIES]) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function hasLocateAnything(): boolean {
  return Boolean(config.locateAnythingUrl);
}

export type LocateAnythingHealth = {
  configured: boolean;
  ok: boolean;
  checkedAtMs: number;
  latencyMs: number | null;
  detail?: string;
};

/** Lightweight GET /health probe for the Mission Control LAs pill. */
export async function checkLocateAnythingHealth(
  timeoutMs = 4000,
): Promise<LocateAnythingHealth> {
  const base = config.locateAnythingUrl;
  const checkedAtMs = Date.now();
  if (!base) {
    return { configured: false, ok: false, checkedAtMs, latencyMs: null, detail: "unset" };
  }
  const url = base.replace(/\/$/, "") + "/health";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return {
        configured: true,
        ok: false,
        checkedAtMs,
        latencyMs,
        detail: `HTTP ${res.status}`,
      };
    }
    return { configured: true, ok: true, checkedAtMs, latencyMs };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      checkedAtMs,
      latencyMs: Date.now() - t0,
      detail: err instanceof Error ? err.message : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function detectWithLocateAnything(
  jpeg: Buffer,
  options?: { categories?: string[] },
): Promise<Detection[]> {
  const base = config.locateAnythingUrl;
  if (!base) return [];

  const url = base.replace(/\/$/, "") + "/detect";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.locateAnythingTimeoutMs);
  const categories = options?.categories?.length ? options.categories : DEFAULT_CATEGORIES;

  try {
    // Smaller payload = faster round-trip on the CUDA worker.
    const payloadJpeg = await sharp(jpeg)
      .rotate()
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        image_base64: payloadJpeg.toString("base64"),
        categories,
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
      warning?: string;
      error?: string;
      items?: Array<RemoteItem>;
      detections?: Array<RemoteItem>;
    };

    const rawItems = data.items ?? data.detections ?? [];
    if (rawItems.length === 0) {
      const hint = data.warning || data.error || `keys=${Object.keys(data).join(",")}`;
      console.warn(`[locate-anything] 0 items (${hint})`);
    }

    const imgW = data.image_width;
    const imgH = data.image_height;
    const out: Detection[] = [];
    for (const [index, item] of rawItems.entries()) {
      const bbox = normalizeRemoteBBox(item, imgW, imgH);
      if (!bbox) continue;
      const label = normalizeLabel(item.label || item.displayName || item.class || "object");
      out.push({
        trackId: `la-${index}-${label}-${Math.round(bbox.x * 40)}-${Math.round(bbox.y * 40)}`,
        label,
        displayName: (item.displayName || label).trim(),
        descriptors: [label],
        confidence: clamp01(item.confidence ?? item.score ?? 0.75),
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

type RemoteItem = {
  label?: string;
  displayName?: string;
  class?: string;
  confidence?: number;
  score?: number;
  box?: number[];
  bbox?: Partial<BBox> & { x1?: number; y1?: number; x2?: number; y2?: number };
};

function normalizeRemoteBBox(
  item: RemoteItem,
  imgW?: number,
  imgH?: number,
): BBox | null {
  const b = item.bbox;
  if (
    b &&
    typeof b.x1 === "number" &&
    typeof b.y1 === "number" &&
    typeof b.x2 === "number" &&
    typeof b.y2 === "number"
  ) {
    return fromXyxy(b.x1, b.y1, b.x2, b.y2, imgW, imgH);
  }

  if (Array.isArray(item.box) && item.box.length === 4) {
    const [x1, y1, x2, y2] = item.box.map(Number);
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      return fromXyxy(x1!, y1!, x2!, y2!, imgW, imgH);
    }
  }

  if (!b) return null;
  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 0.01 || height < 0.01) return null;
  return { x: clamp01(x), y: clamp01(y), width: clamp01(width), height: clamp01(height) };
}

function fromXyxy(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  imgW?: number,
  imgH?: number,
): BBox {
  let a = x1;
  let b = y1;
  let c = x2;
  let d = y2;
  const looksAbsolute = c > 1.5 || d > 1.5;
  if (looksAbsolute && imgW && imgH) {
    a /= imgW;
    b /= imgH;
    c /= imgW;
    d /= imgH;
  }
  return {
    x: clamp01(Math.min(a, c)),
    y: clamp01(Math.min(b, d)),
    width: clamp01(Math.abs(c - a)),
    height: clamp01(Math.abs(d - b)),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
