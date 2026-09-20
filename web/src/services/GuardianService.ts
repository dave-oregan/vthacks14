/**
 * Guardian Mode — situational awareness + visual memory for first responders.
 *
 * Philosophy: "SIGHTLINE surfaces observations. Humans make decisions."
 * No danger meter, hostility score, or person-judgment labels.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../memory/store.js";
import { cropThumb } from "../vision/detector.js";
import type {
  Detection,
  GeoPoint,
  GuardianEvent,
  GuardianEventSeverity,
  GuardianEventStatus,
  GuardianStatus,
} from "../shared/types.js";
import {
  ADDRESS_RE,
  ALTERCATION_RE,
  DISTRESS_PHRASE_RE,
  HAZARD_RE,
  PERSON_RE,
  PLATE_RE,
  SAFETY_RESOURCE_RE,
  WEAPON_RE,
  countDistinctPeople,
  isBladeLabel,
  isFirearmLabel,
  nameOf,
  normalizeKey,
  prettyLabel,
  safetyResourceType,
} from "../guardian/matchers.js";
import { queryGuardianMemory } from "../guardian/memoryQuery.js";

const LARGE_GROUP_MIN = 5;
const ALERT_COOLDOWN_MS = 12_000;
const MAX_EVENTS = 80;
/** Multimodal distress fusion window. */
const DISTRESS_WINDOW_MS = 20_000;
/** Need this many independent signals before critical distress (single signal stays medium). */
const DISTRESS_FUSION_MIN = 2;

type DistressSignal = {
  kind: "motion_fall" | "orientation" | "audio_help" | "inactivity";
  atMs: number;
  detail: string;
};

export class GuardianService extends EventEmitter {
  private enabled = false;
  private events: GuardianEvent[] = [];
  private lastKeyAt = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private groupCount = 0;
  private largeGroup = false;
  private distressSignals: DistressSignal[] = [];
  private sensors = {
    camera: false,
    location: false,
    motion: false,
    audio: false,
  };

  constructor(private store: MemoryStore) {
    super();
    this.pruneTimer = setInterval(() => this.pruneExpired(), 2000);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.events = this.events.map((e) =>
        e.status === "new" ? { ...e, status: "dismissed" as const } : e,
      );
      this.lastKeyAt.clear();
      this.distressSignals = [];
      this.groupCount = 0;
      this.largeGroup = false;
    }
    this.emit("events", this.getEvents());
    this.emit("status", this.getStatus());
  }

  getStatus(): GuardianStatus {
    const live = this.events.filter((e) => e.status === "new" || e.status === "confirmed");
    const highPriority = live.filter(
      (e) => e.severity === "high" || e.severity === "critical",
    ).length;
    const informational = live.filter(
      (e) => e.severity === "info" || e.severity === "low" || e.severity === "medium",
    ).length;
    return {
      highPriority,
      informational,
      groupCount: this.groupCount,
      largeGroup: this.largeGroup,
      sensors: { ...this.sensors },
      eventCount: live.length,
    };
  }

  getEvents(): GuardianEvent[] {
    return this.events.filter((e) => e.status !== "dismissed");
  }

  /** Full timeline including dismissed (for incident log / tests). */
  getAllEvents(): GuardianEvent[] {
    return this.events.slice();
  }

  setSensorHints(partial: Partial<GuardianStatus["sensors"]>): void {
    this.sensors = { ...this.sensors, ...partial };
    this.emit("status", this.getStatus());
  }

  reset(): void {
    this.enabled = false;
    this.events = [];
    this.lastKeyAt.clear();
    this.distressSignals = [];
    this.groupCount = 0;
    this.largeGroup = false;
    this.emit("events", this.getEvents());
    this.emit("status", this.getStatus());
  }

  confirm(id: string): void {
    this.patchStatus(id, "confirmed");
  }

  dismiss(id: string): void {
    this.patchStatus(id, "dismissed");
  }

  resolve(id: string): void {
    this.patchStatus(id, "resolved");
  }

  dismissAll(): void {
    this.events = this.events.map((e) =>
      e.status === "new" ? { ...e, status: "dismissed" as const } : e,
    );
    this.emit("events", this.getEvents());
    this.emit("status", this.getStatus());
  }

  queryMemory(query: string): { text: string; matches: GuardianEvent[] } {
    return queryGuardianMemory(this.getAllEvents(), query);
  }

  /**
   * Browser COCO people hint — crowd count only, no judgment labels.
   */
  ingestCrowdHint(people: Detection[]): void {
    if (!this.enabled) return;
    this.sensors.camera = true;
    this.groupCount = countDistinctPeople(people.filter((d) => PERSON_RE.test(nameOf(d))));
    this.largeGroup = this.groupCount >= LARGE_GROUP_MIN;
    this.emit("status", this.getStatus());
  }

  /**
   * Main vision pass — emit observation events (not person danger scores).
   */
  async ingestDetections(
    jpeg: Buffer,
    detections: Detection[],
    location: GeoPoint | null,
    sessionId: string,
  ): Promise<void> {
    if (!this.enabled) return;
    this.sensors.camera = true;
    if (location) this.sensors.location = true;

    if (detections.length === 0) {
      this.groupCount = 0;
      this.largeGroup = false;
      this.emit("status", this.getStatus());
      return;
    }

    const weapons = detections.filter((d) => WEAPON_RE.test(nameOf(d)));
    const plates = detections.filter((d) => PLATE_RE.test(nameOf(d)));
    const people = detections.filter((d) => PERSON_RE.test(nameOf(d)));
    const altercations = detections.filter((d) => ALTERCATION_RE.test(nameOf(d)));
    const resources = detections.filter((d) => SAFETY_RESOURCE_RE.test(nameOf(d)));
    const hazards = detections.filter((d) => HAZARD_RE.test(nameOf(d)));
    const addresses = detections.filter((d) => ADDRESS_RE.test(nameOf(d)));

    this.groupCount = countDistinctPeople(people);
    this.largeGroup = this.groupCount >= LARGE_GROUP_MIN;
    this.emit("status", this.getStatus());

    for (const w of weapons) {
      const key = `weapon:${normalizeKey(w)}`;
      if (!this.canFire(key)) continue;
      const thumb = jpeg.length ? await cropThumb(jpeg, w.bbox) : null;
      const firearm = isFirearmLabel(nameOf(w));
      const blade = isBladeLabel(nameOf(w));
      const type = firearm ? "possible_firearm" : blade ? "possible_blade" : "possible_weapon";
      const title = firearm
        ? "Possible firearm detected"
        : blade
          ? "Possible knife / blade detected"
          : "Possible weapon detected";
      this.pushEvent({
        category: "potential_threat",
        type,
        title,
        description: `${prettyLabel(w)} · confidence ${Math.round(w.confidence * 100)}%. Observation only — review required.`,
        confidence: w.confidence,
        severity: w.confidence >= 0.7 ? "high" : "medium",
        source: "vision",
        location: toGuardianLoc(location),
        frameReference: thumb ? `data:image/jpeg;base64,${thumb.toString("base64")}` : undefined,
        metadata: {
          label: w.displayName || w.label,
          bbox: w.bbox,
          simulated: false,
        },
        requiresReview: true,
        status: "new",
      });
      this.store.addEvent({
        type: "alerted",
        timestampMs: Date.now(),
        sessionId,
        severity: "critical",
        description: `Guardian: ${title} (${prettyLabel(w)})`,
        location,
      });
    }

    for (const cue of altercations) {
      const key = `altercation:${normalizeKey(cue)}`;
      if (!this.canFire(key)) continue;
      this.pushEvent({
        category: "potential_threat",
        type: "possible_physical_altercation",
        title: "Possible physical altercation detected",
        description: `${prettyLabel(cue)} cue · confidence ${Math.round(cue.confidence * 100)}%. Neutral observation — no intent inferred.`,
        confidence: cue.confidence,
        severity: "medium",
        source: "vision",
        location: toGuardianLoc(location),
        metadata: { label: cue.displayName || cue.label },
        requiresReview: true,
        status: "new",
      });
    }

    for (const p of plates) {
      const key = `plate:${Math.round(p.bbox.x * 20)}:${Math.round(p.bbox.y * 20)}`;
      if (!this.canFire(key)) continue;
      const thumb = jpeg.length ? await cropThumb(jpeg, p.bbox) : null;
      const plateText = p.descriptors?.find((d) => /^[A-Z0-9-]{4,}$/i.test(d));
      this.store.upsertSighting({
        label: "license plate",
        displayName: plateText ? `plate ${plateText}` : "license plate",
        descriptors: ["license plate", "plate capture", "guardian mode", ...(plateText ? [plateText] : [])],
        confidence: p.confidence,
        bbox: p.bbox,
        location,
        thumbJpeg: thumb,
        sessionId,
        timestampMs: Date.now(),
      });
      this.pushEvent({
        category: "vehicle",
        type: "license_plate_observed",
        title: plateText ? `Plate ${plateText} observed` : "License plate observed",
        description: "Vehicle plate logged to Guardian memory with last-known GPS.",
        confidence: p.confidence,
        severity: "medium",
        source: "vision",
        location: toGuardianLoc(location),
        frameReference: thumb ? `data:image/jpeg;base64,${thumb.toString("base64")}` : undefined,
        metadata: { plateText: plateText ?? null, label: "license plate" },
        requiresReview: false,
        status: "new",
      });
    }

    for (const r of resources) {
      const key = `resource:${normalizeKey(r)}`;
      if (!this.canFire(key)) continue;
      const thumb = jpeg.length ? await cropThumb(jpeg, r.bbox) : null;
      const rType = safetyResourceType(nameOf(r));
      this.store.upsertSighting({
        label: rType.replace(/_/g, " "),
        displayName: prettyLabel(r),
        descriptors: [rType, "safety resource", "guardian mode", prettyLabel(r)],
        confidence: r.confidence,
        bbox: r.bbox,
        location,
        thumbJpeg: thumb,
        sessionId,
        timestampMs: Date.now(),
      });
      this.pushEvent({
        category: "safety_resource",
        type: rType,
        title: `${prettyLabel(r)} observed`,
        description: "Safety resource remembered for nearby recall.",
        confidence: r.confidence,
        severity: "info",
        source: "vision",
        location: toGuardianLoc(location),
        frameReference: thumb ? `data:image/jpeg;base64,${thumb.toString("base64")}` : undefined,
        metadata: { resourceType: rType },
        requiresReview: false,
        status: "new",
      });
    }

    for (const h of hazards) {
      const key = `hazard:${normalizeKey(h)}`;
      if (!this.canFire(key)) continue;
      this.pushEvent({
        category: "hazard",
        type: prettyLabel(h).toLowerCase().replace(/\s+/g, "_"),
        title: `Possible ${prettyLabel(h)} detected`,
        description: `Confidence ${Math.round(h.confidence * 100)}%. Review scene conditions.`,
        confidence: h.confidence,
        severity: /fire|smoke/i.test(nameOf(h)) ? "high" : "medium",
        source: "vision",
        location: toGuardianLoc(location),
        requiresReview: true,
        status: "new",
      });
    }

    for (const a of addresses) {
      const key = `address:${normalizeKey(a)}`;
      if (!this.canFire(key)) continue;
      this.pushEvent({
        category: "location",
        type: "address_observed",
        title: `${prettyLabel(a)} observed`,
        description: "Environmental text/context stored in Guardian memory.",
        confidence: a.confidence,
        severity: "info",
        source: "vision",
        location: toGuardianLoc(location),
        metadata: { label: a.displayName || a.label },
        requiresReview: false,
        status: "new",
      });
    }

    if (this.largeGroup && this.canFire(`group:${this.groupCount}`)) {
      this.pushEvent({
        category: "environment",
        type: "crowd_observed",
        title: "Large group in frame",
        description: `${this.groupCount} people estimated in view — informational only.`,
        severity: "low",
        source: "vision",
        location: toGuardianLoc(location),
        metadata: { groupCount: this.groupCount },
        requiresReview: false,
        status: "new",
      });
    }
  }

  /**
   * Motion fall / impact while Guardian is on — contributes to multimodal distress.
   * A single motion signal alone does NOT auto-confirm emergency.
   */
  ingestMotionFall(opts: {
    peakImpactG: number;
    location: GeoPoint | null;
    sessionId: string;
  }): GuardianEvent | null {
    if (!this.enabled) return null;
    this.sensors.motion = true;
    if (opts.location) this.sensors.location = true;

    this.addDistressSignal({
      kind: "motion_fall",
      atMs: Date.now(),
      detail: `rapid camera fall / impact ${opts.peakImpactG}g`,
    });

    return this.maybeFuseDistress(opts.location, opts.sessionId, {
      peakImpactG: opts.peakImpactG,
    });
  }

  /** Spoken distress phrases from transcript (when available). */
  ingestAudioTranscript(text: string, location: GeoPoint | null, sessionId: string): void {
    if (!this.enabled || !text.trim()) return;
    this.sensors.audio = true;
    if (!DISTRESS_PHRASE_RE.test(text)) return;
    this.addDistressSignal({
      kind: "audio_help",
      atMs: Date.now(),
      detail: `distress phrase in audio: “${text.trim().slice(0, 80)}”`,
    });
    this.maybeFuseDistress(location, sessionId);
  }

  /** Demo / manual: inject a fully formed Guardian observation. */
  injectDemoEvent(
    partial: Omit<GuardianEvent, "id" | "timestamp" | "status"> & {
      status?: GuardianEventStatus;
      timestamp?: number;
      simulated?: boolean;
    },
  ): GuardianEvent {
    const { simulated, status, ...rest } = partial;
    return this.pushEvent({
      ...rest,
      metadata: {
        ...(partial.metadata ?? {}),
        simulated: simulated ?? true,
      },
      status: status ?? "new",
    });
  }

  private maybeFuseDistress(
    location: GeoPoint | null,
    sessionId: string,
    extra?: { peakImpactG?: number },
  ): GuardianEvent | null {
    const now = Date.now();
    this.distressSignals = this.distressSignals.filter((s) => now - s.atMs <= DISTRESS_WINDOW_MS);
    const kinds = new Set(this.distressSignals.map((s) => s.kind));
    if (kinds.size === 0) return null;

    const fused = kinds.size >= DISTRESS_FUSION_MIN;
    const severity: GuardianEventSeverity = fused ? "critical" : "medium";
    const key = fused ? "distress:fused" : `distress:single:${[...kinds].sort().join("+")}`;
    if (!this.canFire(key)) return null;

    const evidence = this.distressSignals.map((s) => s.detail);
    const title = "Possible responder distress";
    const description = fused
      ? `Multiple independent signals agree. Evidence:\n${evidence.map((e) => `• ${e}`).join("\n")}`
      : `Single signal — not auto-confirmed. Evidence:\n${evidence.map((e) => `• ${e}`).join("\n")}\nAwait additional cues or human review.`;

    const event = this.pushEvent({
      category: "distress",
      type: fused ? "possible_responder_distress" : "possible_responder_distress_weak",
      title,
      description,
      confidence: fused ? Math.min(0.95, 0.55 + kinds.size * 0.12) : 0.45,
      severity,
      source: kinds.size > 1 ? "multimodal" : "motion",
      location: toGuardianLoc(location),
      metadata: {
        evidence,
        signalKinds: [...kinds],
        fused,
        peakImpactG: extra?.peakImpactG ?? null,
      },
      requiresReview: true,
      status: "new",
    });

    this.store.addEvent({
      type: "possible_emergency",
      timestampMs: Date.now(),
      sessionId,
      severity: fused ? "critical" : "warn",
      description: event.description,
      location,
    });

    return event;
  }

  private addDistressSignal(signal: DistressSignal): void {
    this.distressSignals.push(signal);
  }

  private patchStatus(id: string, status: GuardianEventStatus): void {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx < 0) return;
    this.events[idx] = { ...this.events[idx]!, status };
    this.emit("events", this.getEvents());
    this.emit("status", this.getStatus());
  }

  private pushEvent(
    partial: Omit<GuardianEvent, "id" | "timestamp"> & { timestamp?: number },
  ): GuardianEvent {
    const event: GuardianEvent = {
      id: randomUUID(),
      timestamp: partial.timestamp ?? Date.now(),
      category: partial.category,
      type: partial.type,
      title: partial.title,
      description: partial.description,
      confidence: partial.confidence,
      severity: partial.severity,
      source: partial.source,
      location: partial.location,
      videoTimestamp: partial.videoTimestamp,
      frameReference: partial.frameReference,
      clipReference: partial.clipReference,
      metadata: partial.metadata,
      status: partial.status,
      requiresReview: partial.requiresReview,
    };
    this.events = [event, ...this.events].slice(0, MAX_EVENTS);
    this.emit("events", this.getEvents());
    this.emit("status", this.getStatus());
    return event;
  }

  private canFire(key: string): boolean {
    const now = Date.now();
    const last = this.lastKeyAt.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN_MS) return false;
    this.lastKeyAt.set(key, now);
    return true;
  }

  private pruneExpired(): void {
    // Keep confirmed/resolved; auto-age informational "new" after 3 minutes without TTL field
    const now = Date.now();
    const next = this.events.filter((e) => {
      if (e.status !== "new") return true;
      if (e.severity === "critical" || e.severity === "high") return true;
      return now - e.timestamp < 180_000;
    });
    if (next.length !== this.events.length) {
      this.events = next;
      this.emit("events", this.getEvents());
      this.emit("status", this.getStatus());
    }
  }
}

function toGuardianLoc(
  location: GeoPoint | null,
): GuardianEvent["location"] | undefined {
  if (!location) return undefined;
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.horizontalAccuracyMeters ?? undefined,
  };
}

// Re-export for tests
export type { GuardianEvent };
