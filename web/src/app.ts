import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { RelayHub, type RelayVideoFrame } from "./relay/relayHub.js";
import { MemoryStore } from "./memory/store.js";
import { answerRecallQuery, toRecallMatch } from "./gemini/reasoner.js";
import { listDemoAgents, verifyAgentAccess } from "./ans/trustGate.js";
import { speak } from "./voice/elevenlabs.js";
import type {
  DashboardState,
  Detection,
  GeoPoint,
  MemoryObject,
  Mission,
} from "./shared/types.js";

import { VisionService } from "./services/VisionService.js";
import { EmergencyService } from "./services/EmergencyService.js";
import { MissionService } from "./services/MissionService.js";
import { PoliceService } from "./services/PoliceService.js";
import {
  checkLocateAnythingHealth,
  hasLocateAnything,
  type LocateAnythingHealth,
} from "./vision/locateAnything.js";

export class SightlineApp extends EventEmitter {
  readonly relay = new RelayHub();
  readonly store = new MemoryStore();

  private visionService: VisionService;
  private emergencyService: EmergencyService;
  private missionService: MissionService;
  private policeService: PoliceService;

  private transcriptSnippet = "";
  private mode = "STANDBY";
  private lastAccessRequest = null as DashboardState["lastAccessRequest"];
  private agentStates: DashboardState["agents"] = listDemoAgents();
  private lastStateBroadcastAt = 0;
  private locateAnythingHealth: LocateAnythingHealth = {
    configured: hasLocateAnything(),
    ok: false,
    checkedAtMs: 0,
    latencyMs: null,
    detail: hasLocateAnything() ? "checking…" : "unset",
  };
  private locateAnythingTimer: ReturnType<typeof setInterval> | null = null;
  private cocoFallbackEnabled = config.cocoFallback;

  constructor() {
    super();

    this.missionService = new MissionService(this.store);
    this.emergencyService = new EmergencyService(this.relay, this.store);
    this.policeService = new PoliceService(this.store);
    this.emergencyService.setPoliceModeGetter(() => this.policeService.isEnabled());
    this.visionService = new VisionService(
      this.relay,
      this.store,
      async (dets, loc, session) => {
        await this.missionService.syncTrackMissions(dets, loc, session);
      },
      () => this.policeService.isEnabled(),
      () => this.cocoFallbackEnabled,
    );

    this.wireServices();
    this.wireRelay();
    this.startLocateAnythingMonitor();
  }

  private startLocateAnythingMonitor(): void {
    void this.refreshLocateAnythingHealth();
    if (this.locateAnythingTimer) clearInterval(this.locateAnythingTimer);
    this.locateAnythingTimer = setInterval(() => {
      void this.refreshLocateAnythingHealth();
    }, 8000);
  }

  private async refreshLocateAnythingHealth(): Promise<void> {
    const prev = this.locateAnythingHealth;
    const next = await checkLocateAnythingHealth();
    this.locateAnythingHealth = next;
    if (prev.ok !== next.ok || prev.configured !== next.configured) {
      console.log(
        `[vision] LAs ${next.configured ? (next.ok ? "OK" : "DOWN") : "OFF"}` +
          (next.latencyMs != null ? ` ${next.latencyMs}ms` : "") +
          (next.detail ? ` (${next.detail})` : ""),
      );
      this.broadcast(true);
    } else if (next.checkedAtMs - prev.checkedAtMs > 0) {
      this.broadcast();
    }
  }

  private wireServices(): void {
    this.visionService.on("frame", (frame) => this.emit("frame", frame));
    this.visionService.on("vision_updated", () => this.broadcast());
    this.visionService.on("anchor_placed", (id, loc, ts) => this.missionService.placeAnchor(id, loc, ts));
    this.visionService.on(
      "detections",
      (payload: {
        jpeg: Buffer;
        detections: Detection[];
        location: GeoPoint | null;
        sessionId: string;
      }) => {
        void this.policeService.ingestDetections(
          payload.jpeg,
          payload.detections,
          payload.location,
          payload.sessionId,
        );
      },
    );

    this.policeService.on("alerts", () => this.broadcast(true));

    this.emergencyService.on("emergency", (alert) => {
      this.mode = alert ? "EMERGENCY" : this.relay.getSession()?.connected ? "LIVE" : "STANDBY";
      this.emit("emergency", alert);
      this.broadcast(true);
    });
    this.emergencyService.on(
      "police_officer_down",
      (payload: {
        peakImpactG: number;
        location: GeoPoint | null;
        sessionId: string;
      }) => {
        this.policeService.pushOfficerDown(payload);
      },
    );
    this.emergencyService.on("voice", (voice) => this.emit("voice", voice));

    this.missionService.on("voice", (voice) => this.emit("voice", voice));
    this.missionService.on("timeline", (event) => this.emit("timeline", event));
    this.missionService.on("mission_alerted", () => this.broadcast());
    this.missionService.on("mission_started", () => this.broadcast());
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
      this.emergencyService.updateLocation(geo);
      void this.missionService.evaluateLeaveBehind(geo, this.visionService.getLatestDetections());
      this.broadcast();
    });

    this.relay.on("motion", (sample) => {
      this.emergencyService.processMotion(sample);
    });

    this.relay.on("video", (frame: RelayVideoFrame) => {
      this.mode = "LIVE";
      void this.visionService.processVideoFrame(frame);
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

    this.relay.on("status", () => this.broadcast());
  }

  setPoliceMode(enabled: boolean): { policeMode: boolean } {
    this.policeService.setEnabled(enabled);
    if (enabled) {
      this.store.addEvent({
        type: "stream_event",
        timestampMs: Date.now(),
        sessionId: this.relay.getSession()?.sessionId,
        description: "Police mode ON — scanning for weapons, plates, officer safety",
      });
      console.log("[police] mode ON");
    } else {
      console.log("[police] mode OFF");
    }
    this.broadcast(true);
    return { policeMode: this.policeService.isEnabled() };
  }

  setCocoFallback(enabled: boolean): { cocoFallback: boolean } {
    this.cocoFallbackEnabled = enabled;
    console.log(`[vision] COCO fallback ${enabled ? "ON" : "OFF"}`);
    this.broadcast(true);
    return { cocoFallback: this.cocoFallbackEnabled };
  }

  dismissSideAlert(id: string): void {
    this.policeService.dismiss(id);
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
    this.mode = "LIVE";
    return this.visionService.ingestClientDetections(raw, timestampMs);
  }

  simulateFall() {
    return this.emergencyService.simulateFall();
  }

  dismissEmergency(): void {
    this.emergencyService.dismissEmergency();
  }

  startTrackMission(targetQuery: string): Mission {
    return this.missionService.startTrackMission(targetQuery);
  }

  async recall(query: string) {
    const result = await answerRecallQuery(query, this.store);
    this.transcriptSnippet = query;
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
    this.visionService.reset();
    this.emergencyService.reset();
    this.missionService.reset();
    this.policeService.reset();
    this.lastAccessRequest = null;
    this.agentStates = listDemoAgents();
    this.transcriptSnippet = "";
    this.mode = this.relay.getSession()?.connected ? "LIVE" : "STANDBY";
    this.broadcast();
  }

  getDashboardState(): DashboardState {
    const latestPreviewJpeg = this.visionService.getLatestPreviewJpeg();
    return {
      live: Boolean(this.relay.getSession()?.connected),
      session: this.relay.getSession(),
      latestFrameJpegBase64: latestPreviewJpeg
        ? latestPreviewJpeg.toString("base64")
        : null,
      latestDetections: this.visionService.getLatestDetections(),
      objects: this.store.listObjects().map(objectWithThumb) as unknown as MemoryObject[],
      events: this.store.listEvents(40),
      missions: this.store.listMissions(),
      agents: this.agentStates,
      lastAccessRequest: this.lastAccessRequest,
      mode: this.mode,
      transcriptSnippet: this.transcriptSnippet,
      emergencyAlert: this.emergencyService.emergencyAlert,
      locateAnything: this.locateAnythingHealth,
      policeMode: this.policeService.isEnabled(),
      cocoFallback: this.cocoFallbackEnabled,
      sideAlerts: this.policeService.getAlerts(),
    };
  }

  private broadcast(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStateBroadcastAt < 400) return;
    this.lastStateBroadcastAt = now;
    this.emit("dashboard", this.getDashboardState());
  }
}

export function objectWithThumb(obj: MemoryObject) {
  return {
    ...obj,
    lastFrameThumbJpeg: undefined,
    thumbBase64: obj.lastFrameThumbJpeg
      ? Buffer.from(obj.lastFrameThumbJpeg).toString("base64")
      : null,
  };
}
