import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../memory/store.js";
import { cropThumb } from "../vision/detector.js";
import type { Detection, GeoPoint, SideAlert } from "../shared/types.js";

const WEAPON_RE = /\b(gun|handgun|pistol|rifle|firearm|weapon|knife|blade|machete)\b/i;
const PLATE_RE = /\b(license\s*plate|number\s*plate|licence\s*plate|plate)\b/i;
const PERSON_RE = /\b(person|people|crowd|pedestrian|human)\b/i;
const HOSTILE_RE =
  /\b(fight|fighting|punch|punching|fist|raised\s*fist|aggressive|hostile|assault|attack|scuffle|brawl)\b/i;

/** People count at/above this = large group. */
const LARGE_GROUP_MIN = 5;
/** Danger meter level that counts as an elevated "tick". */
const DANGER_TICK_MIN = 30;
/** Consecutive elevated scans before auto backup alert. */
const BACKUP_AFTER_DANGER_TICKS = 2;
/** Cooldown so the same threat/plate doesn't spam the stack. */
const ALERT_COOLDOWN_MS = 12_000;

export type PoliceStatus = {
  dangerLevel: number; // 0..100
  dangerLabel: string;
  topThreat: string | null;
  topConfidence: number;
  backupThreshold: number; // 0..1
  backupArmed: boolean;
  groupCount: number;
  largeGroup: boolean;
  hostility: number; // 0..100
  hostilityLabel: string;
  /** Consecutive elevated danger scans (resets when clear). */
  dangerTicks: number;
};

export class PoliceService extends EventEmitter {
  private enabled = false;
  private alerts: SideAlert[] = [];
  private lastKeyAt = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Min weapon confidence (0–1) required to recommend / call backup. */
  private backupThreshold = 0.55;
  private dangerLevel = 0;
  private dangerLabel = "Clear";
  private topThreat: string | null = null;
  private topConfidence = 0;
  private groupCount = 0;
  private largeGroup = false;
  private hostility = 0;
  private hostilityLabel = "Calm";
  private lastThreatAtMs = 0;
  private dangerTicks = 0;

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
      this.alerts = [];
      this.lastKeyAt.clear();
      this.resetMeter();
      this.emit("alerts", this.alerts);
      this.emit("status", this.getStatus());
    }
  }

  setBackupThreshold(threshold: number): void {
    this.backupThreshold = Math.min(0.95, Math.max(0.2, threshold));
    this.emit("status", this.getStatus());
  }

  getBackupThreshold(): number {
    return this.backupThreshold;
  }

  getStatus(): PoliceStatus {
    return {
      dangerLevel: this.dangerLevel,
      dangerLabel: this.dangerLabel,
      topThreat: this.topThreat,
      topConfidence: this.topConfidence,
      backupThreshold: this.backupThreshold,
      backupArmed:
        this.dangerTicks >= BACKUP_AFTER_DANGER_TICKS ||
        (this.topConfidence >= this.backupThreshold && this.dangerLevel >= 40),
      groupCount: this.groupCount,
      largeGroup: this.largeGroup,
      hostility: this.hostility,
      hostilityLabel: this.hostilityLabel,
      dangerTicks: this.dangerTicks,
    };
  }

  getAlerts(): SideAlert[] {
    return this.alerts;
  }

  reset(): void {
    this.enabled = false;
    this.alerts = [];
    this.lastKeyAt.clear();
    this.backupThreshold = 0.55;
    this.resetMeter();
    this.emit("alerts", this.alerts);
    this.emit("status", this.getStatus());
  }

  dismiss(id: string): void {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.emit("alerts", this.alerts);
  }

  dismissAll(): void {
    this.alerts = [];
    this.emit("alerts", this.alerts);
  }

  /**
   * Fast crowd hint from browser COCO (people only) — updates group meter
   * without clobbering LocateAnything weapon boxes.
   */
  ingestCrowdHint(people: Detection[]): void {
    if (!this.enabled) return;
    const count = countDistinctPeople(people.filter((d) => PERSON_RE.test(nameOf(d))));
    this.groupCount = count;
    this.largeGroup = this.groupCount >= LARGE_GROUP_MIN;
    if (this.largeGroup && this.dangerLabel === "Clear") this.dangerLabel = "Monitor";
    if (this.largeGroup) {
      this.dangerLevel = Math.max(
        this.dangerLevel,
        28 + Math.min(20, (this.groupCount - LARGE_GROUP_MIN) * 3),
      );
    } else if (count === 0) {
      // Camera moved away from the crowd — don't keep a stuck group assessment.
      this.largeGroup = false;
    }
    this.emit("status", this.getStatus());
  }

  /**
   * Scan detections while Police mode is on — weapons, groups, hostility, plates.
   * Non-weapon clutter (phones, bottles, etc.) is ignored.
   */
  async ingestDetections(
    jpeg: Buffer,
    detections: Detection[],
    location: GeoPoint | null,
    sessionId: string,
  ): Promise<void> {
    if (!this.enabled) return;

    const weapons = detections.filter((d) => WEAPON_RE.test(nameOf(d)));
    const plates = detections.filter((d) => PLATE_RE.test(nameOf(d)));
    const people = detections.filter((d) => PERSON_RE.test(nameOf(d)));
    const hostileCues = detections.filter((d) => HOSTILE_RE.test(nameOf(d)));

    // Empty / cleared scan — reset assessments so they don't stick after the camera turns.
    if (detections.length === 0) {
      this.resetMeter();
      this.emit("status", this.getStatus());
      return;
    }

    if (weapons.length || hostileCues.length) {
      this.lastThreatAtMs = Date.now();
    }

    this.updateDangerMeter(weapons, plates, people, hostileCues);
    this.advanceDangerTicks(location, sessionId);
    this.emit("status", this.getStatus());

    for (const w of weapons) {
      const key = `weapon:${normalizeThreatKey(w)}`;
      if (!this.canFire(key)) continue;
      const thumb = jpeg.length ? await cropThumb(jpeg, w.bbox) : null;
      this.pushAlert({
        kind: "danger_weapon",
        severity: "critical",
        title: "Weapon in view",
        message: `${prettyLabel(w)} · ${Math.round(w.confidence * 100)}% confidence.`,
        ttlMs: 14_000,
        thumbBase64: thumb?.toString("base64") ?? null,
        label: w.displayName || w.label,
        location,
      });
      this.store.addEvent({
        type: "alerted",
        timestampMs: Date.now(),
        sessionId,
        severity: "critical",
        description: `Police mode: weapon sighted (${w.displayName || w.label})`,
        location,
      });
    }

    if (this.largeGroup) {
      const key = `group:${this.groupCount}`;
      if (this.canFire(key)) {
        this.pushAlert({
          kind: "info",
          severity: "warn",
          title: "Large group",
          message: `${this.groupCount} people in frame — track crowd dynamics.`,
          ttlMs: 14_000,
          location,
        });
        this.store.addEvent({
          type: "alerted",
          timestampMs: Date.now(),
          sessionId,
          severity: "warn",
          description: `Police mode: large group (${this.groupCount})`,
          location,
        });
      }
    }

    if (this.hostility >= 55) {
      const key = `hostility:${this.hostilityLabel}`;
      if (this.canFire(key)) {
        this.pushAlert({
          kind: "backup_recommend",
          severity: this.hostility >= 75 ? "critical" : "warn",
          title: `Hostility · ${this.hostilityLabel}`,
          message:
            this.hostilityLabel === "Armed confrontation"
              ? "Weapon + person cues — advise backup if not already on scene."
              : hostileCues[0]
                ? `${prettyLabel(hostileCues[0])} detected · hostility ${this.hostility}.`
                : `Crowd/aggression heuristics · hostility ${this.hostility}.`,
          ttlMs: 16_000,
          location,
        });
      }
    }

    for (const p of plates) {
      const key = `plate:${Math.round(p.bbox.x * 20)}:${Math.round(p.bbox.y * 20)}`;
      if (!this.canFire(key)) continue;
      const thumb = jpeg.length ? await cropThumb(jpeg, p.bbox) : null;
      this.store.upsertSighting({
        label: "license plate",
        displayName: "license plate",
        descriptors: ["license plate", "plate capture", "police mode"],
        confidence: p.confidence,
        bbox: p.bbox,
        location,
        thumbJpeg: thumb,
        sessionId,
        timestampMs: Date.now(),
      });
      this.pushAlert({
        kind: "plate_capture",
        severity: "warn",
        title: "Plate captured",
        message: "License plate logged to memory with last-known GPS.",
        ttlMs: 12_000,
        thumbBase64: thumb?.toString("base64") ?? null,
        label: "license plate",
        location,
      });
    }

    const maxWeaponConf = weapons.reduce((m, w) => Math.max(m, w.confidence), 0);
    const shouldBackup =
      maxWeaponConf >= this.backupThreshold &&
      (people.length > 0 ||
        weapons.length >= 2 ||
        this.hostility >= 70 ||
        maxWeaponConf >= this.backupThreshold + 0.1);

    if (shouldBackup && weapons.length > 0) {
      const key = "backup:threshold";
      if (this.canFire(key)) {
        const top = weapons.slice().sort((a, b) => b.confidence - a.confidence)[0]!;
        this.pushAlert({
          kind: "backup_recommend",
          severity: "critical",
          title: "Request backup",
          message:
            `${prettyLabel(top)} at ${Math.round(top.confidence * 100)}% ` +
            `(threshold ${Math.round(this.backupThreshold * 100)}%)` +
            (people.length ? ` · ${people.length} person(s)` : "") +
            (this.largeGroup ? " · large group" : "") +
            `. Hostility ${this.hostilityLabel}. DEMO: would advise units.`,
          ttlMs: 18_000,
          location,
        });
      }
    }
  }

  /** Officer fall while Police mode — non-blocking officer-down / backup alert. */
  pushOfficerDown(opts: {
    peakImpactG: number;
    location: GeoPoint | null;
    sessionId: string;
  }): SideAlert {
    this.dangerLevel = 100;
    this.dangerLabel = "Officer down";
    this.topThreat = "officer down";
    this.topConfidence = 1;
    this.hostility = 100;
    this.hostilityLabel = "Officer down";
    this.emit("status", this.getStatus());

    const locLine = opts.location
      ? `${opts.location.latitude.toFixed(5)}, ${opts.location.longitude.toFixed(5)}`
      : "GPS pending";
    const alert = this.pushAlert({
      kind: "officer_down",
      severity: "critical",
      title: "Officer down — requesting backup",
      message: `Fall/impact ${opts.peakImpactG}g. DEMO: would request backup at ${locLine}. No real dispatch.`,
      ttlMs: null,
      location: opts.location,
    });
    this.store.addEvent({
      type: "possible_emergency",
      timestampMs: Date.now(),
      sessionId: opts.sessionId,
      severity: "critical",
      description: alert.message,
      location: opts.location,
    });
    return alert;
  }

  private resetMeter(): void {
    this.dangerLevel = 0;
    this.dangerLabel = "Clear";
    this.topThreat = null;
    this.topConfidence = 0;
    this.groupCount = 0;
    this.largeGroup = false;
    this.hostility = 0;
    this.hostilityLabel = "Calm";
    this.lastThreatAtMs = 0;
    this.dangerTicks = 0;
  }

  /**
   * Each elevated scan counts as a tick. Two consecutive ticks → backup alert.
   * A clear scan resets the streak.
   */
  private advanceDangerTicks(
    location: GeoPoint | null,
    sessionId: string,
  ): void {
    if (this.dangerLevel >= DANGER_TICK_MIN) {
      this.dangerTicks += 1;
    } else {
      this.dangerTicks = 0;
      return;
    }

    if (this.dangerTicks < BACKUP_AFTER_DANGER_TICKS) return;
    if (!this.canFire("backup:danger-ticks")) return;

    this.pushAlert({
      kind: "backup_recommend",
      severity: "critical",
      title: "Request backup",
      message:
        `Danger held for ${this.dangerTicks} scans ` +
        `(${this.dangerLabel} · ${this.dangerLevel}` +
        (this.topThreat ? ` · ${this.topThreat}` : "") +
        `). DEMO: would call backup — no real dispatch.`,
      ttlMs: 20_000,
      location,
    });
    this.store.addEvent({
      type: "alerted",
      timestampMs: Date.now(),
      sessionId,
      severity: "critical",
      description: `Police mode: backup after ${this.dangerTicks} danger ticks`,
      location,
    });
  }

  private updateDangerMeter(
    weapons: Detection[],
    plates: Detection[],
    people: Detection[],
    hostileCues: Detection[],
  ): void {
    const maxW = weapons.reduce((m, w) => Math.max(m, w.confidence), 0);
    const top = weapons.slice().sort((a, b) => b.confidence - a.confidence)[0];
    this.topThreat = top
      ? prettyLabel(top)
      : hostileCues[0]
        ? prettyLabel(hostileCues[0])
        : plates[0]
          ? "license plate"
          : null;
    this.topConfidence =
      top?.confidence ?? hostileCues[0]?.confidence ?? plates[0]?.confidence ?? 0;

    // Group: unique-ish people by spatial separation
    this.groupCount = countDistinctPeople(people);
    this.largeGroup = this.groupCount >= LARGE_GROUP_MIN;

    // Hostility heuristic (no dedicated model — cue labels + weapon/person context)
    let hostility = 0;
    if (hostileCues.length) {
      const maxH = hostileCues.reduce((m, d) => Math.max(m, d.confidence), 0);
      hostility += 40 + maxH * 35;
    }
    if (weapons.length && people.length) hostility += 35 + maxW * 20;
    if (weapons.length >= 2) hostility += 15;
    if (this.largeGroup && weapons.length) hostility += 20;
    else if (this.largeGroup) hostility += 10;
    // Dense cluster of people → agitation risk
    const clusterTightness = averagePairIoU(people);
    if (people.length >= 3 && clusterTightness > 0.05) hostility += 12;

    this.hostility = Math.min(100, Math.round(hostility));
    if (this.hostility >= 80) this.hostilityLabel = "Armed confrontation";
    else if (this.hostility >= 55) this.hostilityLabel = "Elevated";
    else if (this.hostility >= 30) this.hostilityLabel = "Tense";
    else this.hostilityLabel = "Calm";

    let score = 0;
    if (weapons.length) score += 35 + maxW * 40;
    if (weapons.length >= 2) score += 15;
    if (weapons.length && people.length) score += 20;
    if (this.largeGroup) score += 12 + Math.min(15, (this.groupCount - LARGE_GROUP_MIN) * 3);
    score += this.hostility * 0.25;
    if (plates.length) score += 5;
    this.dangerLevel = Math.min(100, Math.round(score));

    if (this.dangerLevel >= 85) this.dangerLabel = "Critical";
    else if (this.dangerLevel >= 60) this.dangerLabel = "Elevated";
    else if (this.dangerLevel >= 30) this.dangerLabel = "Caution";
    else if (this.largeGroup) this.dangerLabel = "Monitor";
    else if (plates.length) this.dangerLabel = "Monitor";
    else this.dangerLabel = "Clear";
  }

  private pushAlert(
    partial: Omit<SideAlert, "id" | "timestampMs"> & { timestampMs?: number },
  ): SideAlert {
    const alert: SideAlert = {
      id: randomUUID(),
      timestampMs: partial.timestampMs ?? Date.now(),
      kind: partial.kind,
      severity: partial.severity,
      title: partial.title,
      message: partial.message,
      ttlMs: partial.ttlMs,
      thumbBase64: partial.thumbBase64,
      label: partial.label,
      location: partial.location,
    };
    this.alerts = [alert, ...this.alerts].slice(0, 8);
    this.emit("alerts", this.alerts);
    return alert;
  }

  private canFire(key: string): boolean {
    const now = Date.now();
    const last = this.lastKeyAt.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN_MS) return false;
    this.lastKeyAt.set(key, now);
    return true;
  }

  private pruneExpired(): void {
    const now = Date.now();
    const next = this.alerts.filter(
      (a) => a.ttlMs == null || now - a.timestampMs < a.ttlMs,
    );
    if (next.length !== this.alerts.length) {
      this.alerts = next;
      this.emit("alerts", this.alerts);
    }
  }
}

function nameOf(d: Detection): string {
  return `${d.label} ${d.displayName}`;
}

function prettyLabel(d: Detection): string {
  return (d.displayName || d.label || "threat").trim();
}

function normalizeThreatKey(d: Detection): string {
  const label = (d.label || "").toLowerCase().replace(/\s+/g, "_");
  return `${label}:${Math.round(d.bbox.x * 10)}:${Math.round(d.bbox.y * 10)}`;
}

function countDistinctPeople(people: Detection[]): number {
  if (people.length === 0) return 0;
  const kept: Detection[] = [];
  for (const p of people.slice().sort((a, b) => b.confidence - a.confidence)) {
    const dup = kept.some(
      (k) =>
        Math.abs(k.bbox.x - p.bbox.x) < 0.08 &&
        Math.abs(k.bbox.y - p.bbox.y) < 0.08 &&
        Math.abs(k.bbox.width - p.bbox.width) < 0.12,
    );
    if (!dup) kept.push(p);
  }
  return kept.length;
}

function averagePairIoU(people: Detection[]): number {
  if (people.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      sum += boxIoU(people[i]!.bbox, people[j]!.bbox);
      n += 1;
    }
  }
  return n ? sum / n : 0;
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
