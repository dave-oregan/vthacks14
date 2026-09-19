import { EventEmitter } from "node:events";
import { v4 as uuid } from "uuid";
import { config } from "./config.js";
import { RelayHub, type RelayVideoFrame } from "./relay/relayHub.js";
import { MemoryStore, formatObjectPhrase } from "./memory/store.js";
import { detectObjects, enrichWithGemini, cropThumb } from "./vision/detector.js";
import { answerRecallQuery } from "./gemini/reasoner.js";
import { listDemoAgents, verifyAgentAccess } from "./ans/trustGate.js";
import { speak } from "./voice/elevenlabs.js";
import type {
  DashboardState,
  Detection,
  GeoPoint,
  MemoryObject,
  Mission,
  TimelineEvent,
} from "./shared/types.js";

export class SightlineApp extends EventEmitter {
  readonly relay = new RelayHub();
  readonly store = new MemoryStore();

  private latestFrameJpeg: Buffer | null = null;
  private latestDetections: Detection[] = [];
  private frameCounter = 0;
  private visionBusy = false;
  private geminiCounter = 0;
  private transcriptSnippet = "";
  private mode = "STANDBY";
  private lastAccessRequest = null as DashboardState["lastAccessRequest"];
  private agentStates: DashboardState["agents"] = listDemoAgents();
  private placedAnchors = new Map<string, { location: GeoPoint; seenAtMs: number }>();

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
      this.broadcast();
    });

    this.relay.on("location", (geo: GeoPoint & { sessionId: string }) => {
      void this.evaluateLeaveBehind(geo);
      this.broadcast();
    });

    this.relay.on("video", (frame: RelayVideoFrame) => {
      this.latestFrameJpeg = frame.jpeg;
      this.frameCounter += 1;
      this.mode = "LIVE";
      this.broadcastFrame();
      if (this.frameCounter % config.visionEveryNFrames === 0) {
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
      this.broadcast();
    });

    this.relay.on("disconnected", () => {
      this.mode = "DISCONNECTED";
      this.broadcast();
    });

    this.relay.on("status", () => this.broadcast());
  }

  private async runVision(frame: RelayVideoFrame): Promise<void> {
    if (this.visionBusy) return;
    this.visionBusy = true;
    try {
      let detections = await detectObjects(frame.jpeg);
      this.geminiCounter += 1;
      if (config.geminiApiKey && this.geminiCounter % 4 === 0) {
        detections = await enrichWithGemini(frame.jpeg, detections);
      }
      this.latestDetections = detections;
      this.relay.markVisioned();

      const location = this.relay.getSession()?.lastLocation ?? null;
      for (const det of detections) {
        if (det.label === "person") continue;
        const thumb = await cropThumb(frame.jpeg, det.bbox);
        const { object, isNew } = this.store.upsertSighting({
          label: det.label,
          descriptors: det.descriptors.length ? det.descriptors : [det.displayName, det.label],
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
        } else {
          // periodic refresh event sparingly
          if (object.sightingCount % 15 === 0) {
            this.store.addEvent({
              type: "object_seen",
              timestampMs: frame.timestampMs,
              sessionId: frame.sessionId,
              subjectObjectId: object.id,
              description: `Still tracking ${formatObjectPhrase(object)}`,
              location,
            });
          }
        }
      }

      await this.syncTrackMissions(detections, location, frame.sessionId);
      this.broadcast();
    } catch (err) {
      console.warn("[vision] pipeline error:", err instanceof Error ? err.message : err);
    } finally {
      this.visionBusy = false;
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
    if (result.objectId) {
      this.store.markRecalled(result.objectId, this.relay.getSession()?.sessionId ?? "dashboard");
    }
    const voice = await speak(result.text);
    this.transcriptSnippet = query;
    this.emit("voice", voice);
    this.broadcast();
    return { ...result, voice };
  }

  requestAgentAccess(agentAnsName: string, scopes: string[]) {
    // set verifying briefly in UI state
    this.agentStates = this.agentStates.map((a) =>
      a.ans === agentAnsName ? { ...a, state: "VERIFYING…" as const } : a,
    );
    this.broadcast();

    const req = verifyAgentAccess(this.store, agentAnsName, scopes);
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

  simulateUnknownAgent() {
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
    this.mode = this.relay.getSession()?.connected ? "LIVE" : "STANDBY";
    this.broadcast();
  }

  getDashboardState(): DashboardState {
    return {
      live: Boolean(this.relay.getSession()?.connected),
      session: this.relay.getSession(),
      latestFrameJpegBase64: this.latestFrameJpeg
        ? this.latestFrameJpeg.toString("base64")
        : null,
      latestDetections: this.latestDetections,
      objects: this.store.listObjects().map(objectWithThumb) as unknown as MemoryObject[],
      events: this.store.listEvents(80),
      missions: this.store.listMissions(),
      agents: this.agentStates,
      lastAccessRequest: this.lastAccessRequest,
      mode: this.mode,
      transcriptSnippet: this.transcriptSnippet,
    };
  }

  private broadcast(): void {
    this.emit("dashboard", this.getDashboardState());
  }

  private broadcastFrame(): void {
    this.emit("frame", {
      jpegBase64: this.latestFrameJpeg?.toString("base64") ?? null,
      detections: this.latestDetections,
      session: this.relay.getSession(),
    });
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

export { objectWithThumb };
