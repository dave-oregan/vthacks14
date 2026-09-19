import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { RelayHub, type RelayVideoFrame } from "./relay/relayHub.js";
import { MemoryStore, formatObjectPhrase } from "./memory/store.js";
import {
  detectObjects,
  cropThumb,
  makePreviewJpeg,
} from "./vision/detector.js";
import { describeDetectionsLocally } from "./vision/appearance.js";
import {
  detectWithLocateAnything,
  hasLocateAnything,
} from "./vision/locateAnything.js";
import { enrichDetectionsWithGemini } from "./gemini/enricher.js";
import { hasGemini } from "./gemini/client.js";
import { answerRecallQuery, toRecallMatch } from "./gemini/reasoner.js";
import { listDemoAgents, verifyAgentAccess } from "./ans/trustGate.js";
import { speak } from "./voice/elevenlabs.js";
import { FallDetector, type FallEvent } from "./motion/fallDetector.js";
import type {
  DashboardState,
  Detection,
  EmergencyAlert,
  GeoPoint,
  MemoryObject,
  Mission,
} from "./shared/types.js";

export class SightlineApp extends EventEmitter {
  readonly relay = new RelayHub();
  readonly store = new MemoryStore();

  private latestFrameJpeg: Buffer | null = null;
  private latestPreviewJpeg: Buffer | null = null;
  private latestDetections: Detection[] = [];
  private frameCounter = 0;
  private visionBusy = false;
  private geminiBusy = false;
  private geminiCounter = 0;
  private transcriptSnippet = "";
  private mode = "STANDBY";
  private lastAccessRequest = null as DashboardState["lastAccessRequest"];
  private agentStates: DashboardState["agents"] = listDemoAgents();
  private placedAnchors = new Map<string, { location: GeoPoint; seenAtMs: number }>();
  private lastPreviewSentAt = 0;
  private lastStateBroadcastAt = 0;
  private previewBusy = false;
  private fallDetector = new FallDetector();
  private emergencyAlert: EmergencyAlert | null = null;
  /** Survives brief session gaps so fall alerts still have GPS. */
  private lastKnownLocation: GeoPoint | null = null;

  constructor() {
    super();
    this.wireRelay();
  }

  private wireRelay(): void {
    this.relay.on("hello", () => {
      this.mode = "LIVE";
      this.store.addEvent({
        type: "stream_event",
        timestampMs: Date.now(),
        sessionId: this.relay.getSession()?.sessionId,
        description: "iOS Link connected (hello)",
      });
      this.broadcast(true);
    });

    this.relay.on("location", (geo: GeoPoint & { sessionId: string }) => {
      if (Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude)) {
        this.lastKnownLocation = {
          latitude: geo.latitude,
          longitude: geo.longitude,
          altitudeMeters: geo.altitudeMeters,
          horizontalAccuracyMeters: geo.horizontalAccuracyMeters,
          timestampMs: geo.timestampMs,
        };
        // Refresh an open emergency alert with the latest fix.
        if (this.emergencyAlert?.active) {
          this.emergencyAlert = {
            ...this.emergencyAlert,
            location: this.lastKnownLocation,
            message: this.emergencyMessage(
              this.emergencyAlert.peakImpactG,
              this.lastKnownLocation,
            ),
          };
          this.emit("emergency", this.emergencyAlert);
        }
      }
      void this.evaluateLeaveBehind(geo);
      this.broadcast();
    });

    this.relay.on("motion", (sample) => {
      const fall = this.fallDetector.push(sample);
      if (fall) this.triggerEmergency(fall);
    });

    this.relay.on("video", (frame: RelayVideoFrame) => {
      this.latestFrameJpeg = frame.jpeg;
      this.frameCounter += 1;
      this.mode = "LIVE";
      void this.maybeBroadcastPreview();
      // Server-side detect only when explicitly enabled (browser mode is default for smoothness).
      if (
        (config.visionMode === "server" || config.visionMode === "both") &&
        this.frameCounter % config.visionEveryNFrames === 0
      ) {
        void this.runVision(frame);
      }
    });

    this.relay.on("stream_event", (e) => {
      this.store.addEvent({
        type: "stream_event",
        timestampMs: Date.now(),
        sessionId: e.sessionId,
        description: `Stream: ${e.event}`,
      });
      this.broadcast(true);
    });

    this.relay.on("disconnected", () => {
      this.mode = "DISCONNECTED";
      this.broadcast(true);
    });

    // Lightweight status — throttled, never includes full-res JPEG spam.
    this.relay.on("status", () => this.broadcast());
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
      // Local / LocateAnything detection only — Gemini never blocks this path.
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

      // Schedule Gemini enrichment separately (descriptors / display names).
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
      await this.syncTrackMissions(
        detections,
        this.relay.getSession()?.lastLocation ?? null,
        frame.sessionId,
      );
      // Push detections quickly via frame channel; full state less often.
      this.emit("frame", {
        jpegBase64: this.latestPreviewJpeg?.toString("base64") ?? null,
        detections: this.latestDetections,
        session: this.relay.getSession(),
      });
      this.broadcast();
    } catch (err) {
      console.warn("[vision] failed:", err instanceof Error ? err.message : err);
    } finally {
      this.visionBusy = false;
    }
  }

  /** Accept browser (or remote) detections into memory without running Node COCO. */
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
    this.mode = "LIVE";

    const session = this.relay.getSession();
    const frameLike = {
      jpeg: this.latestFrameJpeg ?? Buffer.alloc(0),
      sessionId: session?.sessionId ?? "browser",
      timestampMs: timestampMs ?? Date.now(),
      sequence: this.frameCounter,
    };

    if (this.latestFrameJpeg) {
      // Local color/material from pixels — works offline, no hallucination.
      let toPersist = await describeDetectionsLocally(this.latestFrameJpeg, detections);
      this.latestDetections = toPersist;

      // Optional Gemini polish (skipped automatically when quota-cooled).
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

    await this.syncTrackMissions(
      detections,
      session?.lastLocation ?? null,
      session?.sessionId ?? "browser",
    );
    this.emit("frame", {
      jpegBase64: this.latestPreviewJpeg?.toString("base64") ?? null,
      detections: this.latestDetections,
      session,
    });
    this.broadcast();
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
          this.placedAnchors.set(object.id, {
            location,
            seenAtMs: frame.timestampMs,
          });
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

  /** Async descriptor pass — must not stall COCO / LocateAnything detection. */
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

  private async syncTrackMissions(
    detections: Detection[],
    location: GeoPoint | null | undefined,
    sessionId: string,
  ): Promise<void> {
    const active = this.store.listMissions().filter((m) => m.status === "active" && m.type === "track");
    for (const mission of active) {
      const target = mission.targetObjectId
        ? this.store.getObject(mission.targetObjectId)
        : this.store.searchObjects(mission.targetLabel ?? "")[0];
      if (!target) continue;

      const visible = detections.some((d) => {
        const hay = `${d.label} ${d.displayName} ${d.descriptors.join(" ")}`.toLowerCase();
        const needle = (mission.targetLabel ?? target.canonicalLabel).toLowerCase();
        return hay.includes(needle) || target.descriptors.some((desc) => hay.includes(desc));
      });

      if (visible && location) {
        this.placedAnchors.set(target.id, { location, seenAtMs: Date.now() });
      }
    }
  }

  private async evaluateLeaveBehind(geo: GeoPoint & { sessionId: string }): Promise<void> {
    const active = this.store.listMissions().filter((m) => m.status === "active" && m.type === "track");
    for (const mission of active) {
      const target = mission.targetObjectId
        ? this.store.getObject(mission.targetObjectId)
        : this.store.searchObjects(mission.targetLabel ?? "")[0];
      if (!target) continue;

      const anchor = this.placedAnchors.get(target.id);
      if (!anchor?.location) continue;

      const moved = this.store.distanceMeters(anchor.location, geo);
      const absent = Date.now() - target.lastSeenAtMs;
      const currentlyVisible = this.latestDetections.some((d) =>
        `${d.label} ${d.descriptors.join(" ")}`.toLowerCase().includes(target.canonicalLabel),
      );

      if (
        !currentlyVisible &&
        moved >= (mission.triggerConfig.leaveBehindMeters ?? config.leaveBehindMeters) &&
        absent >= (mission.triggerConfig.absentMs ?? config.leaveBehindAbsentMs)
      ) {
        this.store.updateMissionStatus(mission.id, "triggered");
        const phrase = formatObjectPhrase(target);
        const event = this.store.markLeftBehind(
          target.id,
          target.lastLocation ?? anchor.location,
          `Left behind: ${phrase} (~${Math.round(moved)} m away, absent ${Math.round(absent / 1000)}s)`,
          geo.sessionId,
        );
        this.store.addEvent({
          type: "alerted",
          timestampMs: Date.now(),
          sessionId: geo.sessionId,
          missionId: mission.id,
          subjectObjectId: target.id,
          severity: "warn",
          description: `Alert: you may have left your ${phrase}`,
          location: target.lastLocation,
        });
        const voice = await speak(`SIGHTLINE alert. You may have left your ${phrase}.`);
        this.emit("voice", voice);
        this.emit("timeline", event);
        this.broadcast();
      }
    }
  }

  simulateFall(): EmergencyAlert {
    // Always allow demo button re-fire after cancel.
    this.fallDetector.resetCooldown();
    const sessionId = this.relay.getSession()?.sessionId ?? "demo";
    const fall = this.fallDetector.simulate(sessionId);
    return this.triggerEmergency(fall);
  }

  dismissEmergency(): void {
    this.fallDetector.resetCooldown();
    this.emergencyAlert = null;
    this.mode = this.relay.getSession()?.connected ? "LIVE" : "STANDBY";
    this.emit("emergency", null);
    this.broadcast(true);
  }

  private triggerEmergency(fall: FallEvent): EmergencyAlert {
    const loc = this.resolvePhoneLocation();
    const alert: EmergencyAlert = {
      active: true,
      demo: true,
      triggeredAtMs: fall.triggeredAtMs,
      peakImpactG: fall.peakImpactG,
      freefallMs: fall.freefallMs,
      reason: fall.reason,
      message: this.emergencyMessage(fall.peakImpactG, loc),
      location: loc,
    };
    // Replace entirely so the UI always remounts on re-trigger.
    this.emergencyAlert = alert;
    this.mode = "EMERGENCY";
    this.store.addEvent({
      type: "possible_emergency",
      timestampMs: fall.triggeredAtMs,
      sessionId: fall.sessionId,
      severity: "critical",
      description: alert.message,
      location: loc,
    });
    console.warn(
      `[emergency:demo] ${fall.reason} peak=${fall.peakImpactG}g loc=${
        loc ? `${loc.latitude.toFixed(5)},${loc.longitude.toFixed(5)}` : "none"
      }`,
    );
    this.emit("emergency", alert);
    this.broadcast(true);
    void speak(
      loc
        ? `SIGHTLINE demo alert. Possible fall detected near ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}. Contacting nine one one. This is a demonstration only.`
        : "SIGHTLINE demo alert. Possible fall detected. Contacting nine one one. This is a demonstration only.",
    ).then((voice) => this.emit("voice", voice));
    return alert;
  }

  private resolvePhoneLocation(): GeoPoint | null {
    const sessionLoc = this.relay.getSession()?.lastLocation ?? null;
    const candidates = [sessionLoc, this.lastKnownLocation].filter(
      (g): g is GeoPoint =>
        Boolean(g) && Number.isFinite(g!.latitude) && Number.isFinite(g!.longitude),
    );
    if (candidates.length > 0) {
      // Prefer the freshest fix.
      candidates.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
      return candidates[0]!;
    }
    // Last resort: most recent remembered object with geo (same phone session area).
    const withGeo = this.store
      .listObjects()
      .filter((o) => o.lastLocation && Number.isFinite(o.lastLocation.latitude));
    withGeo.sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
    return withGeo[0]?.lastLocation ?? null;
  }

  private emergencyMessage(peakG: number, loc: GeoPoint | null): string {
    if (loc) {
      const acc =
        loc.horizontalAccuracyMeters != null && Number.isFinite(loc.horizontalAccuracyMeters)
          ? ` (±${Math.round(loc.horizontalAccuracyMeters)}m)`
          : "";
      return `Possible hard fall detected (${peakG}g). DEMO: would contact 911 at ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}${acc}. No real call is placed.`;
    }
    return `Possible hard fall detected (${peakG}g). DEMO: would contact 911 — waiting for phone GPS fix. No real call is placed.`;
  }

  startTrackMission(targetQuery: string): Mission {
    const hits = this.store.searchObjects(targetQuery);
    const target = hits[0];
    const mission = this.store.createMission({
      type: "track",
      status: "active",
      targetObjectId: target?.id,
      targetLabel: target?.canonicalLabel ?? targetQuery.toLowerCase(),
      targetDescriptors: target?.descriptors ?? [targetQuery.toLowerCase()],
      createdAtMs: Date.now(),
      triggerConfig: {
        leaveBehindMeters: config.leaveBehindMeters,
        absentMs: config.leaveBehindAbsentMs,
      },
    });
    this.store.addEvent({
      type: "mission_started",
      timestampMs: Date.now(),
      missionId: mission.id,
      subjectObjectId: target?.id,
      description: `Track mission started for “${mission.targetLabel}”`,
      location: target?.lastLocation,
    });
    if (target?.lastLocation) {
      this.placedAnchors.set(target.id, {
        location: target.lastLocation,
        seenAtMs: target.lastSeenAtMs,
      });
    }
    this.broadcast();
    return mission;
  }

  async recall(query: string) {
    const result = await answerRecallQuery(query, this.store);
    this.transcriptSnippet = query;
    // Only auto-mark when a single specific match; multi-match waits for user pick.
    if (!result.needsChoice && result.objectId) {
      this.store.markRecalled(result.objectId, this.relay.getSession()?.sessionId ?? "dashboard");
      const voice = await speak(result.text);
      this.emit("voice", voice);
      this.broadcast();
      return { ...result, voice };
    }
    this.broadcast();
    return result;
  }

  async selectRecall(objectId: string) {
    const obj = this.store.getObject(objectId);
    if (!obj) return { ok: false as const, text: "That memory card is gone." };
    this.store.markRecalled(objectId, this.relay.getSession()?.sessionId ?? "dashboard");
    const match = toRecallMatch(obj);
    const text = match.mapsUrl
      ? `${match.phrase} last seen at ${match.latitude?.toFixed(5)}, ${match.longitude?.toFixed(5)}.`
      : `${match.phrase} has no GPS fix yet.`;
    const voice = await speak(text);
    this.transcriptSnippet = match.phrase;
    this.emit("voice", voice);
    this.broadcast();
    return { ok: true as const, text, match, voice };
  }

  async requestAgentAccess(agentAnsName: string, scopes: string[]) {
    // set verifying briefly in UI state
    this.agentStates = this.agentStates.map((a) =>
      a.ans === agentAnsName ? { ...a, state: "VERIFYING…" as const } : a,
    );
    this.broadcast();

    const req = await verifyAgentAccess(this.store, agentAnsName, scopes);
    this.lastAccessRequest = req;
    this.agentStates = this.agentStates.map((a) => {
      if (a.ans !== agentAnsName) return a;
      return {
        ...a,
        state: req.decision === "allow" ? ("IDENTITY VERIFIED" as const) : ("BLOCKED" as const),
      };
    });
    this.broadcast();
    return req;
  }

  async simulateUnknownAgent() {
    return this.requestAgentAccess("ans://v1.0.0.rogue.unknown.agent", [
      "location",
      "memory.read",
    ]);
  }

  resetDemo(): void {
    this.store.resetDemo();
    this.latestDetections = [];
    this.placedAnchors.clear();
    this.lastAccessRequest = null;
    this.agentStates = listDemoAgents();
    this.transcriptSnippet = "";
    this.emergencyAlert = null;
    this.mode = this.relay.getSession()?.connected ? "LIVE" : "STANDBY";
    this.broadcast();
  }

  getDashboardState(): DashboardState {
    return {
      live: Boolean(this.relay.getSession()?.connected),
      session: this.relay.getSession(),
      // Preview-sized JPEG only — never the full camera frame.
      latestFrameJpegBase64: this.latestPreviewJpeg
        ? this.latestPreviewJpeg.toString("base64")
        : null,
      latestDetections: this.latestDetections,
      objects: this.store.listObjects().map(objectWithThumb) as unknown as MemoryObject[],
      events: this.store.listEvents(40),
      missions: this.store.listMissions(),
      agents: this.agentStates,
      lastAccessRequest: this.lastAccessRequest,
      mode: this.mode,
      transcriptSnippet: this.transcriptSnippet,
      emergencyAlert: this.emergencyAlert,
    };
  }

  private broadcast(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStateBroadcastAt < 400) return;
    this.lastStateBroadcastAt = now;
    this.emit("dashboard", this.getDashboardState());
  }
}

function objectWithThumb(obj: MemoryObject) {
  return {
    ...obj,
    lastFrameThumbJpeg: undefined,
    thumbBase64: obj.lastFrameThumbJpeg
      ? Buffer.from(obj.lastFrameThumbJpeg).toString("base64")
      : null,
  };
}

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

export { objectWithThumb };
