import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { RelayHub, type RelayVideoFrame } from "./relay/relayHub.js";
import { MemoryStore } from "./memory/store.js";
import { answerRecallQuery, toRecallMatch } from "./gemini/reasoner.js";
import { listDemoAgents, verifyAgentAccess } from "./ans/trustGate.js";
import { speak } from "./voice/elevenlabs.js";
import { mirrorTranscript } from "./memory/db.js";
import { SpeechTranscriber, callScribe, type Utterance } from "./voice/transcribe.js";
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
import { GuardianService } from "./services/GuardianService.js";
import {
  checkLocateAnythingHealth,
  hasLocateAnything,
  type LocateAnythingHealth,
} from "./vision/locateAnything.js";

export class SightlineApp extends EventEmitter {
  readonly relay = new RelayHub();
  readonly store = new MemoryStore();
  readonly transcriber = new SpeechTranscriber();

  private visionService: VisionService;
  private emergencyService: EmergencyService;
  private missionService: MissionService;
  private guardianService: GuardianService;

  private transcriptSnippet = "";
  private transcriptLog: DashboardState["recentTranscripts"] = [];
  private micSpeaking = false;
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
    this.guardianService = new GuardianService(this.store);
    this.emergencyService.setGuardianModeGetter(() => this.guardianService.isEnabled());
    this.visionService = new VisionService(
      this.relay,
      this.store,
      async (dets, loc, session) => {
        await this.missionService.syncTrackMissions(dets, loc, session);
      },
      () => this.guardianService.isEnabled(),
      () => this.cocoFallbackEnabled,
      () => this.emergencyService.lastKnownLocation ?? this.relay.getSession()?.lastLocation ?? null,
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
        void this.guardianService.ingestDetections(
          payload.jpeg,
          payload.detections,
          payload.location,
          payload.sessionId,
        );
      },
    );

    this.guardianService.on("events", () => this.broadcast(true));
    this.guardianService.on("status", () => this.broadcast());

    this.emergencyService.on("emergency", (alert) => {
      this.mode = alert ? "EMERGENCY" : this.relay.getSession()?.connected ? "LIVE" : "STANDBY";
      this.emit("emergency", alert);
      this.broadcast(true);
    });
    this.emergencyService.on(
      "guardian_responder_distress",
      (payload: {
        peakImpactG: number;
        location: GeoPoint | null;
        sessionId: string;
      }) => {
        this.guardianService.ingestMotionFall(payload);
      },
    );
    // Wearable + phone mic audio arrives here. Until now nothing subscribed
    // to it, so the microphone was a dead end.
    this.relay.on("audio", (chunk) => this.transcriber.push(chunk));
    this.transcriber.on("transcript", (u: Utterance) => void this.onHeard(u));
    this.transcriber.on("listening", (l: { speaking: boolean }) => {
      this.micSpeaking = l.speaking;
      this.broadcast();
    });

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
      // GPS often arrives after the first vision pass — backfill recent cards.
      const stamped = this.store.stampLocation(geo);
      if (stamped > 0) {
        console.log(
          `[memory] stamped GPS onto ${stamped} recent object(s) ` +
            `(${geo.latitude.toFixed(5)}, ${geo.longitude.toFixed(5)})`,
        );
      }
      this.guardianService.setSensorHints({ location: true });
      void this.missionService.evaluateLeaveBehind(geo, this.visionService.getLatestDetections());
      this.broadcast(true);
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

  setGuardianMode(enabled: boolean): { guardianMode: boolean; policeMode: boolean } {
    this.guardianService.setEnabled(enabled);
    if (enabled) {
      this.store.addEvent({
        type: "stream_event",
        timestampMs: Date.now(),
        sessionId: this.relay.getSession()?.sessionId,
        description: "Guardian mode ON — situational awareness & visual memory for first responders",
      });
      console.log("[guardian] mode ON");
    } else {
      console.log("[guardian] mode OFF");
    }
    this.broadcast(true);
    const on = this.guardianService.isEnabled();
    return { guardianMode: on, policeMode: on };
  }

  /** @deprecated Use setGuardianMode */
  setPoliceMode(enabled: boolean): { guardianMode: boolean; policeMode: boolean } {
    return this.setGuardianMode(enabled);
  }

  setCocoFallback(enabled: boolean): { cocoFallback: boolean } {
    this.cocoFallbackEnabled = enabled;
    console.log(`[vision] COCO fallback ${enabled ? "ON" : "OFF"}`);
    this.broadcast(true);
    return { cocoFallback: this.cocoFallbackEnabled };
  }

  dismissGuardianEvent(id: string): void {
    this.guardianService.dismiss(id);
  }

  confirmGuardianEvent(id: string): void {
    this.guardianService.confirm(id);
  }

  /** @deprecated */
  dismissSideAlert(id: string): void {
    this.dismissGuardianEvent(id);
  }

  queryGuardianMemory(query: string) {
    return this.guardianService.queryMemory(query);
  }

  injectGuardianDemo(scenario: string) {
    const sessionId = this.relay.getSession()?.sessionId ?? "demo";
    const loc = this.relay.getSession()?.lastLocation ?? null;
    const baseLoc = loc
      ? { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.horizontalAccuracyMeters }
      : undefined;
    switch (scenario) {
      case "plate":
        return this.guardianService.injectDemoEvent({
          category: "vehicle",
          type: "license_plate_observed",
          title: "Plate ABC-1234 observed",
          description: "Simulated plate OCR for demo — Gray Toyota sedan.",
          confidence: 0.96,
          severity: "medium",
          source: "manual",
          location: baseLoc,
          metadata: { plateText: "ABC-1234", vehicle: "Gray Toyota sedan", simulated: true },
          requiresReview: false,
          simulated: true,
        });
      case "aed":
        return this.guardianService.injectDemoEvent({
          category: "safety_resource",
          type: "aed",
          title: "AED observed",
          description: "Simulated safety resource near north hallway / elevator.",
          confidence: 0.93,
          severity: "info",
          source: "manual",
          location: baseLoc,
          metadata: { resourceType: "aed", humanReadable: "North hallway near elevator", simulated: true },
          requiresReview: false,
          simulated: true,
        });
      case "firearm":
        return this.guardianService.injectDemoEvent({
          category: "potential_threat",
          type: "possible_firearm",
          title: "Possible firearm detected",
          description: "Simulated training imagery — confidence 91%. Observation only; review required.",
          confidence: 0.91,
          severity: "high",
          source: "manual",
          location: baseLoc,
          metadata: { simulated: true, trainingImage: true },
          requiresReview: true,
          simulated: true,
        });
      case "distress": {
        this.guardianService.setEnabled(true);
        this.guardianService.ingestAudioTranscript("help", loc, sessionId);
        return this.guardianService.ingestMotionFall({
          peakImpactG: 4.2,
          location: loc,
          sessionId,
        });
      }
      case "address":
        return this.guardianService.injectDemoEvent({
          category: "location",
          type: "address_observed",
          title: "214 Main Street observed",
          description: "Simulated address / street-sign observation.",
          confidence: 0.93,
          severity: "info",
          source: "manual",
          location: baseLoc,
          metadata: { address: "214 Main Street", simulated: true },
          requiresReview: false,
          simulated: true,
        });
      case "extinguisher":
        return this.guardianService.injectDemoEvent({
          category: "safety_resource",
          type: "fire_extinguisher",
          title: "Fire extinguisher observed",
          description: "Simulated safety resource near west stairwell.",
          confidence: 0.9,
          severity: "info",
          source: "manual",
          location: baseLoc,
          metadata: { resourceType: "fire_extinguisher", simulated: true },
          requiresReview: false,
          simulated: true,
        });
      default:
        throw new Error(`Unknown guardian demo scenario: ${scenario}`);
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
    this.mode = "LIVE";

    // Police mode: browser only feeds people for fast crowd tracking — never overwrite LA.
    if (this.guardianService.isEnabled()) {
      const people = (raw ?? [])
        .filter(
          (d) =>
            d &&
            d.bbox &&
            typeof d.label === "string" &&
            /\b(person|people|crowd|pedestrian)\b/i.test(String(d.label)),
        )
        .map((d, index) => ({
          trackId: d.trackId || `crowd-${index}`,
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
      this.guardianService.ingestCrowdHint(people);
      this.broadcast();
      return { count: people.length };
    }

    return this.visionService.ingestClientDetections(raw, timestampMs);
  }

  simulateFall() {
    return this.emergencyService.simulateFall();
  }

  simulateCrash() {
    return this.emergencyService.simulateCrash();
  }

  dismissEmergency(): void {
    this.emergencyService.dismissEmergency();
  }

  startTrackMission(targetQuery: string): Mission {
    return this.missionService.startTrackMission(targetQuery);
  }

  /** Transcribe an uploaded audio file - used by /api/stt/test. */
  async transcribeBuffer(bytes: Buffer) {
    const r = await callScribe(bytes, "upload.wav", "audio/wav");
    if (r.ok && r.text) {
      await this.onHeard({
        text: r.text,
        source: "upload",
        sessionId: this.relay.getSession()?.sessionId ?? "dashboard",
        startedAtMs: Date.now(),
        durationMs: 0,
        latencyMs: r.latencyMs,
        languageCode: r.languageCode,
        confidence: r.confidence,
      });
    }
    return r;
  }

  /** A transcribed utterance from the wearer's own microphone. */
  private async onHeard(u: Utterance): Promise<void> {
    this.transcriptSnippet = u.text;
    this.pushTranscriptLog({
      id: `heard-${u.startedAtMs}-${Math.random().toString(36).slice(2, 7)}`,
      direction: "heard",
      text: u.text,
      timestampMs: u.startedAtMs,
      source: u.source,
    });
    mirrorTranscript({
      direction: "heard",
      text: u.text,
      sessionId: u.sessionId,
      source: u.source,
      durationMs: u.durationMs,
      latencyMs: u.latencyMs,
      context: "wearable-mic",
    });
    this.store.addEvent({
      type: "heard",
      timestampMs: u.startedAtMs,
      sessionId: u.sessionId,
      severity: "info",
      description: `Heard (${u.source}): "${u.text}"`,
    });
    this.guardianService.ingestAudioTranscript(
      u.text,
      this.relay.getSession()?.lastLocation ?? null,
      u.sessionId,
    );
    this.emit("heard", u);
    this.broadcast(true);

    // Opt-in: let the wearer ask out loud instead of typing. Off by default so
    // a stray sentence during the demo can't fire a recall nobody asked for.
    if (config.sttAutoRecall && looksLikeRecallQuestion(u.text)) {
      console.log(`[stt] auto-recall triggered by: "${u.text}"`);
      await this.recall(u.text);
    }
  }

  private pushTranscriptLog(entry: DashboardState["recentTranscripts"][number]): void {
    this.transcriptLog = [entry, ...this.transcriptLog].slice(0, 200);
  }

  async recall(query: string) {
    const sessionId = this.relay.getSession()?.sessionId ?? "dashboard";
    this.pushTranscriptLog({
      id: `asked-${Date.now()}`,
      direction: "asked",
      text: query,
      timestampMs: Date.now(),
      source: "mission-control",
    });
    mirrorTranscript({ direction: "asked", text: query, sessionId, context: "recall" });
    const result = await answerRecallQuery(query, this.store);
    this.transcriptSnippet = query;
    if (!result.needsChoice && result.objectId) {
      this.store.markRecalled(result.objectId, this.relay.getSession()?.sessionId ?? "dashboard");
      const voice = await speak(result.text);
      this.emit("voice", voice);
      this.broadcast();
      return { ...result, voice };
    }
    // Single transcript answer — still speak it.
    if (
      !result.needsChoice &&
      result.matches.length === 1 &&
      result.matches[0]?.kind === "transcript"
    ) {
      const voice = await speak(result.text);
      this.emit("voice", voice);
      this.broadcast();
      return { ...result, voice };
    }
    this.broadcast();
    return result;
  }

  async selectRecall(
    objectId: string,
    kind?: "object" | "transcript",
    transcriptText?: string,
  ) {
    if (kind === "transcript") {
      const fromLog = this.transcriptLog.find((t) => t.id === objectId);
      const line = transcriptText?.trim() || fromLog?.text;
      const when = fromLog?.timestampMs ?? Date.now();
      const text = line
        ? `You heard: “${line}” ${new Date(when).toLocaleString()}.`
        : "Selected conversation line.";
      const voice = await speak(text);
      this.transcriptSnippet = line ?? text;
      this.emit("voice", voice);
      this.broadcast();
      return {
        ok: true as const,
        text,
        match: {
          id: objectId,
          kind: "transcript" as const,
          phrase: line ?? "transcript",
          label: "transcript",
          descriptors: [],
          lastSeenAtMs: when,
          lastSeenLabel: new Date(when).toLocaleString(),
          latitude: null,
          longitude: null,
          mapsUrl: null,
          thumbBase64: null,
          sightingCount: 1,
          status: "heard",
          transcriptText: line,
        },
        voice,
      };
    }
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
        state: req.verificationStatus === "PENDING VALIDATION" 
          ? ("PENDING VALIDATION" as const)
          : req.decision === "allow" ? ("IDENTITY VERIFIED" as const) : ("BLOCKED" as const),
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
    this.guardianService.reset();
    this.lastAccessRequest = null;
    this.agentStates = listDemoAgents();
    this.transcriptSnippet = "";
    this.transcriptLog = [];
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
      recentTranscripts: this.transcriptLog,
      emergencyAlert: this.emergencyService.emergencyAlert,
      locateAnything: this.locateAnythingHealth,
      guardianMode: this.guardianService.isEnabled(),
      policeMode: this.guardianService.isEnabled(),
      cocoFallback: this.cocoFallbackEnabled,
      guardianEvents: this.guardianService.getEvents(),
      guardianStatus: this.guardianService.getStatus(),
      sideAlerts: [],
      policeStatus: {
        dangerLevel: 0,
        dangerLabel: "Clear",
        topThreat: null,
        topConfidence: 0,
        backupThreshold: 0.55,
        backupArmed: false,
        groupCount: this.guardianService.getStatus().groupCount,
        largeGroup: this.guardianService.getStatus().largeGroup,
        hostility: 0,
        hostilityLabel: "n/a",
        dangerTicks: 0,
      },
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

/** Heuristic: is this spoken line a question SIGHTLINE should answer? */
function looksLikeRecallQuestion(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\b(where|did i|have i|find|locate|what did i)\b/.test(t)) return false;
  return /\b(is|are|did|leave|left|put|see|saw|my)\b/.test(t);
}
