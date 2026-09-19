import { EventEmitter } from "node:events";
import { config } from "../config.js";
import type { RelayHub, RelayVideoFrame } from "../relay/relayHub.js";
import type { MemoryStore } from "../memory/store.js";
import { formatObjectPhrase } from "../memory/store.js";
import { detectObjects, cropThumb, makePreviewJpeg } from "../vision/detector.js";
import { describeDetectionsLocally } from "../vision/appearance.js";
import { detectWithLocateAnything, hasLocateAnything } from "../vision/locateAnything.js";
import { enrichDetectionsWithGemini } from "../gemini/enricher.js";
import { hasGemini } from "../gemini/client.js";
import type { Detection, GeoPoint } from "../shared/types.js";

function boxIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

export class VisionService extends EventEmitter {
  private latestFrameJpeg: Buffer | null = null;
  public latestPreviewJpeg: Buffer | null = null;
  public latestDetections: Detection[] = [];
  private frameCounter = 0;
  private visionBusy = false;
  private geminiBusy = false;
  private geminiCounter = 0;
  private lastPreviewSentAt = 0;
  private previewBusy = false;

  constructor(
    private relay: RelayHub,
    private store: MemoryStore,
    private onSyncMissions: (detections: Detection[], location: GeoPoint | null, sessionId: string) => Promise<void>
  ) {
    super();
  }

  getLatestDetections() {
    return this.latestDetections;
  }
  
  getLatestPreviewJpeg() {
    return this.latestPreviewJpeg;
  }
  
  getLatestFrameJpeg() {
    return this.latestFrameJpeg;
  }

  reset() {
    this.latestDetections = [];
    this.latestPreviewJpeg = null;
    this.latestFrameJpeg = null;
    this.frameCounter = 0;
  }

  async processVideoFrame(frame: RelayVideoFrame): Promise<void> {
    this.latestFrameJpeg = frame.jpeg;
    this.frameCounter += 1;
    
    void this.maybeBroadcastPreview();
    
    if (
      (config.visionMode === "server" || config.visionMode === "both") &&
      this.frameCounter % config.visionEveryNFrames === 0
    ) {
      void this.runVision(frame);
    }
  }

  private async maybeBroadcastPreview(): Promise<void> {
    const minInterval = 1000 / Math.max(1, config.previewMaxFps);
    const now = Date.now();
    if (this.previewBusy || now - this.lastPreviewSentAt < minInterval) return;
    if (!this.latestFrameJpeg) return;

    this.previewBusy = true;
    this.lastPreviewSentAt = now;
    try {
      this.latestPreviewJpeg = await makePreviewJpeg(this.latestFrameJpeg);
      this.emit("frame", {
        jpegBase64: this.latestPreviewJpeg.toString("base64"),
        detections: this.latestDetections,
        session: this.relay.getSession(),
      });
    } catch (err) {
      console.warn("[preview] failed:", err instanceof Error ? err.message : err);
    } finally {
      this.previewBusy = false;
    }
  }

  private async runVision(frame: RelayVideoFrame): Promise<void> {
    if (this.visionBusy) return;
    this.visionBusy = true;
    try {
      let detections: Detection[];
      if (hasLocateAnything()) {
        const la = await detectWithLocateAnything(frame.jpeg);
        detections = la.length > 0 ? la : await detectObjects(frame.jpeg);
      } else {
        detections = await detectObjects(frame.jpeg);
      }
      detections = await describeDetectionsLocally(frame.jpeg, detections);
      this.latestDetections = detections;
      this.relay.markVisioned();

      this.geminiCounter += 1;
      if (
        hasGemini() &&
        !this.geminiBusy &&
        this.geminiCounter % Math.max(config.geminiEveryNVisionPasses, 8) === 0 &&
        detections.length > 0
      ) {
        void this.runGeminiEnrich(frame.jpeg, detections);
      }

      await this.persistDetections(detections, frame);
      await this.onSyncMissions(
        detections,
        this.relay.getSession()?.lastLocation ?? null,
        frame.sessionId,
      );
      
      this.emit("frame", {
        jpegBase64: this.latestPreviewJpeg?.toString("base64") ?? null,
        detections: this.latestDetections,
        session: this.relay.getSession(),
      });
      this.emit("vision_updated");
    } catch (err) {
      console.warn("[vision] failed:", err instanceof Error ? err.message : err);
    } finally {
      this.visionBusy = false;
    }
  }

  async ingestClientDetections(
    raw: Array<{
      trackId?: string;
      label?: string;
      displayName?: string;
      descriptors?: string[];
      confidence?: number;
      bbox?: { x: number; y: number; width: number; height: number };
    }>,
    timestampMs?: number,
  ): Promise<{ count: number }> {
    const detections: Detection[] = (raw ?? [])
      .filter((d) => d && d.bbox && typeof d.label === "string")
      .map((d, index) => ({
        trackId: d.trackId || `client-${index}`,
        label: String(d.label).toLowerCase(),
        displayName: String(d.displayName || d.label),
        descriptors: Array.isArray(d.descriptors) ? d.descriptors.map(String) : [String(d.label)],
        confidence: Number(d.confidence ?? 0.5),
        bbox: {
          x: Number(d.bbox!.x),
          y: Number(d.bbox!.y),
          width: Number(d.bbox!.width),
          height: Number(d.bbox!.height),
        },
        source: "coco" as const,
      }));

    this.latestDetections = detections;
    this.relay.markVisioned();

    const session = this.relay.getSession();
    const frameLike = {
      jpeg: this.latestFrameJpeg ?? Buffer.alloc(0),
      sessionId: session?.sessionId ?? "browser",
      timestampMs: timestampMs ?? Date.now(),
      sequence: this.frameCounter,
    };

    if (this.latestFrameJpeg) {
      let toPersist = await describeDetectionsLocally(this.latestFrameJpeg, detections);
      this.latestDetections = toPersist;

      this.geminiCounter += 1;
      if (
        hasGemini() &&
        !this.geminiBusy &&
        this.geminiCounter % Math.max(config.geminiEveryNVisionPasses, 8) === 0
      ) {
        this.geminiBusy = true;
        try {
          toPersist = await enrichDetectionsWithGemini(this.latestFrameJpeg, toPersist);
          this.latestDetections = toPersist;
        } finally {
          this.geminiBusy = false;
        }
      }
      await this.persistDetections(toPersist, frameLike);
    }

    await this.onSyncMissions(
      detections,
      session?.lastLocation ?? null,
      session?.sessionId ?? "browser",
    );
    
    this.emit("frame", {
      jpegBase64: this.latestPreviewJpeg?.toString("base64") ?? null,
      detections: this.latestDetections,
      session,
    });
    this.emit("vision_updated");
    return { count: detections.length };
  }

  private async persistDetections(
    detections: Detection[],
    frame: { jpeg: Buffer; sessionId: string; timestampMs: number; sequence: number },
  ): Promise<void> {
    const location = this.relay.getSession()?.lastLocation ?? null;
    const toStore = detections.filter((d) => d.label !== "person");
    await Promise.all(
      toStore.map(async (det) => {
        const thumb =
          frame.jpeg.length > 0 && det.confidence >= 0.5
            ? await cropThumb(frame.jpeg, det.bbox)
            : null;
        const { object, isNew } = this.store.upsertSighting({
          label: det.label,
          displayName: det.displayName,
          descriptors: det.descriptors.length
            ? det.descriptors
            : [det.displayName, det.label],
          confidence: det.confidence,
          bbox: det.bbox,
          location,
          thumbJpeg: thumb,
          sessionId: frame.sessionId,
          timestampMs: frame.timestampMs,
        });

        if (location) {
          this.emit("anchor_placed", object.id, location, frame.timestampMs);
        }

        if (isNew) {
          this.store.addEvent({
            type: "object_seen",
            timestampMs: frame.timestampMs,
            sessionId: frame.sessionId,
            subjectObjectId: object.id,
            description: `Seen ${formatObjectPhrase(object)}`,
            frameRef: `frame:${frame.sequence}`,
            location,
          });
        } else if (object.sightingCount % 25 === 0) {
          this.store.addEvent({
            type: "object_seen",
            timestampMs: frame.timestampMs,
            sessionId: frame.sessionId,
            subjectObjectId: object.id,
            description: `Still tracking ${formatObjectPhrase(object)}`,
            location,
          });
        }
      }),
    );
  }

  private async runGeminiEnrich(jpeg: Buffer, snapshot: Detection[]): Promise<void> {
    if (this.geminiBusy) return;
    this.geminiBusy = true;
    try {
      const enriched = await enrichDetectionsWithGemini(jpeg, snapshot);
      if (enriched === snapshot) return;
      this.latestDetections = this.latestDetections.map((cur) => {
        const match = enriched.find(
          (e) =>
            e.trackId === cur.trackId ||
            (e.label === cur.label && boxIoU(e.bbox, cur.bbox) > 0.4),
        );
        if (!match) return cur;
        return {
          ...cur,
          displayName: match.displayName || cur.displayName,
          descriptors: match.descriptors.length ? match.descriptors : cur.descriptors,
          label: match.label || cur.label,
          source: match.source === "gemini" ? "gemini" : cur.source,
        };
      });
      this.emit("frame", {
        jpegBase64: this.latestPreviewJpeg?.toString("base64") ?? null,
        detections: this.latestDetections,
        session: this.relay.getSession(),
      });
    } catch (err) {
      console.warn("[gemini] enrich path failed:", err instanceof Error ? err.message : err);
    } finally {
      this.geminiBusy = false;
    }
  }
}
