import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../memory/store.js";
import { cropThumb } from "../vision/detector.js";
import type { Detection, GeoPoint, SideAlert } from "../shared/types.js";

const WEAPON_RE = /\b(gun|handgun|pistol|rifle|firearm|weapon|knife|blade|machete)\b/i;
const PLATE_RE = /\b(license\s*plate|number\s*plate|licence\s*plate|plate)\b/i;

/** Cooldown so the same threat/plate doesn't spam the stack. */
const ALERT_COOLDOWN_MS = 12_000;

export class PoliceService extends EventEmitter {
  private enabled = false;
  private alerts: SideAlert[] = [];
  private lastKeyAt = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

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
      this.emit("alerts", this.alerts);
    }
  }

  getAlerts(): SideAlert[] {
    return this.alerts;
  }

  reset(): void {
    this.enabled = false;
    this.alerts = [];
    this.lastKeyAt.clear();
    this.emit("alerts", this.alerts);
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
   * Scan detections while Police mode is on — weapons, plates, backup recommend.
   */
  async ingestDetections(
    jpeg: Buffer,
    detections: Detection[],
    location: GeoPoint | null,
    sessionId: string,
  ): Promise<void> {
    if (!this.enabled || detections.length === 0) return;

    const weapons = detections.filter((d) => WEAPON_RE.test(`${d.label} ${d.displayName}`));
    const plates = detections.filter((d) => PLATE_RE.test(`${d.label} ${d.displayName}`));
    const people = detections.filter((d) => /\bperson\b/i.test(d.label));

    for (const w of weapons) {
      const key = `weapon:${normalizeThreatKey(w)}`;
      if (!this.canFire(key)) continue;
      const thumb = jpeg.length ? await cropThumb(jpeg, w.bbox) : null;
      this.pushAlert({
        kind: "danger_weapon",
        severity: "critical",
        title: "Weapon in view",
        message: `${prettyLabel(w)} detected — recommend calling backup if not already on scene.`,
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
      this.store.addEvent({
        type: "object_seen",
        timestampMs: Date.now(),
        sessionId,
        severity: "info",
        description: "Police mode: license plate captured",
        location,
      });
    }

    // Person + weapon in the same frame → recommend backup (if not already weapon-alerted heavily)
    if (weapons.length > 0 && people.length > 0) {
      const key = "backup:person+weapon";
      if (this.canFire(key)) {
        this.pushAlert({
          kind: "backup_recommend",
          severity: "critical",
          title: "Recommend backup",
          message: `Person and ${prettyLabel(weapons[0]!)} in frame — advise additional units.`,
          ttlMs: 16_000,
          location,
        });
      }
    } else if (weapons.length >= 2) {
      const key = "backup:multi-weapon";
      if (this.canFire(key)) {
        this.pushAlert({
          kind: "backup_recommend",
          severity: "critical",
          title: "Recommend backup",
          message: "Multiple weapons in view — advise additional units.",
          ttlMs: 16_000,
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

function prettyLabel(d: Detection): string {
  return (d.displayName || d.label || "weapon").trim();
}

function normalizeThreatKey(d: Detection): string {
  const label = (d.label || "").toLowerCase().replace(/\s+/g, "_");
  return `${label}:${Math.round(d.bbox.x * 10)}:${Math.round(d.bbox.y * 10)}`;
}
