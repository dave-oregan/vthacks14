import { EventEmitter } from "node:events";
import type { RelayHub } from "../relay/relayHub.js";
import type { MemoryStore } from "../memory/store.js";
import { FallDetector, type FallEvent, type MotionSample } from "../motion/fallDetector.js";
import { CrashDetector, type CrashEvent } from "../motion/crashDetector.js";
import { speak } from "../voice/elevenlabs.js";
import type { EmergencyAlert, EmergencyKind, GeoPoint } from "../shared/types.js";
import { evaluateRisk } from "../api/guardian.js";
import { config } from "../config.js";

export class EmergencyService extends EventEmitter {
  private fallDetector = new FallDetector();
  private crashDetector = new CrashDetector();
  public emergencyAlert: EmergencyAlert | null = null;
  public lastKnownLocation: GeoPoint | null = null;
  private isGuardianMode: () => boolean = () => false;

  constructor(
    private relay: RelayHub,
    private store: MemoryStore,
  ) {
    super();
  }

  setGuardianModeGetter(fn: () => boolean): void {
    this.isGuardianMode = fn;
  }

  /** @deprecated Use setGuardianModeGetter */
  setPoliceModeGetter(fn: () => boolean): void {
    this.setGuardianModeGetter(fn);
  }

  reset() {
    this.emergencyAlert = null;
    this.fallDetector.resetCooldown();
    this.crashDetector.resetCooldown();
  }

  processMotion(sample: MotionSample) {
    const fall = this.fallDetector.push(sample);
    if (fall) {
      this.triggerFall(fall);
      return;
    }
    const crash = this.crashDetector.pushMotion(sample);
    if (crash) this.triggerCrash(crash);
  }

  updateLocation(geo: GeoPoint & { sessionId: string }) {
    if (Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude)) {
      this.lastKnownLocation = {
        latitude: geo.latitude,
        longitude: geo.longitude,
        altitudeMeters: geo.altitudeMeters,
        horizontalAccuracyMeters: geo.horizontalAccuracyMeters,
        speedMetersPerSecond: geo.speedMetersPerSecond ?? null,
        courseDegrees: geo.courseDegrees ?? null,
        timestampMs: geo.timestampMs,
      };

      if (this.emergencyAlert?.active) {
        this.emergencyAlert = {
          ...this.emergencyAlert,
          location: this.lastKnownLocation,
          message: this.emergencyMessage(this.emergencyAlert, this.lastKnownLocation),
        };
        this.emit("emergency", this.emergencyAlert);
      }
    }

    const crash = this.crashDetector.pushSpeed({
      sessionId: geo.sessionId,
      timestampMs: geo.timestampMs,
      speedMetersPerSecond: geo.speedMetersPerSecond ?? null,
    });
    if (crash) this.triggerCrash(crash);
  }

  simulateFall(): EmergencyAlert {
    this.fallDetector.resetCooldown();
    const sessionId = this.relay.getSession()?.sessionId ?? "demo";
    const fall = this.fallDetector.simulate(sessionId);
    return this.triggerFall(fall);
  }

  simulateCrash(): EmergencyAlert {
    this.crashDetector.resetCooldown();
    const sessionId = this.relay.getSession()?.sessionId ?? "demo";
    const crash = this.crashDetector.simulate(sessionId);
    return this.triggerCrash(crash);
  }

  dismissEmergency(): void {
    this.fallDetector.resetCooldown();
    this.crashDetector.resetCooldown();
    this.emergencyAlert = null;
    this.emit("emergency", null);
  }

  private triggerFall(fall: FallEvent): EmergencyAlert {
    return this.publishAlert({
      kind: "fall",
      sessionId: fall.sessionId,
      triggeredAtMs: fall.triggeredAtMs,
      peakImpactG: fall.peakImpactG,
      freefallMs: fall.freefallMs,
      reason: fall.reason,
    });
  }

  private triggerCrash(crash: CrashEvent): EmergencyAlert {
    return this.publishAlert({
      kind: "crash",
      sessionId: crash.sessionId,
      triggeredAtMs: crash.triggeredAtMs,
      peakImpactG: crash.peakImpactG,
      freefallMs: 0,
      peakSpeedMph: crash.peakSpeedMph,
      decelerationMphPerSec: crash.decelerationMphPerSec,
      reason: crash.reason,
    });
  }

  private publishAlert(opts: {
    kind: EmergencyKind;
    sessionId: string;
    triggeredAtMs: number;
    peakImpactG: number;
    freefallMs: number;
    peakSpeedMph?: number;
    decelerationMphPerSec?: number;
    reason: string;
  }): EmergencyAlert {
    const loc = this.resolvePhoneLocation();
    const guardianDistress = this.isGuardianMode();
    const alert: EmergencyAlert = {
      active: true,
      demo: true,
      kind: opts.kind,
      triggeredAtMs: opts.triggeredAtMs,
      peakImpactG: opts.peakImpactG,
      freefallMs: opts.freefallMs,
      peakSpeedMph: opts.peakSpeedMph,
      decelerationMphPerSec: opts.decelerationMphPerSec,
      reason: opts.reason,
      message: "",
      location: loc,
      guardianDistress,
      policeBackup: guardianDistress,
    };
    alert.message = this.emergencyMessage(alert, loc);

    this.emergencyAlert = alert;

    this.store.addEvent({
      type: "possible_emergency",
      timestampMs: opts.triggeredAtMs,
      sessionId: opts.sessionId,
      severity: "critical",
      description: alert.message,
      location: loc,
    });

    console.warn(
      `[emergency:demo] ${opts.kind} ${guardianDistress ? "guardian-distress" : "911"} ${opts.reason} peak=${opts.peakImpactG}g loc=${
        loc ? `${loc.latitude.toFixed(5)},${loc.longitude.toFixed(5)}` : "none"
      }`,
    );

    this.emit("emergency", alert);
    if (guardianDistress) {
      this.emit("guardian_responder_distress", {
        peakImpactG: opts.peakImpactG,
        location: loc,
        sessionId: opts.sessionId,
        alert,
      });
      this.emit("police_officer_down", {
        peakImpactG: opts.peakImpactG,
        location: loc,
        sessionId: opts.sessionId,
        alert,
      });
    }

    const impactScore = Math.min(
      100,
      Math.max(
        0,
        opts.kind === "crash"
          ? Math.max((opts.peakImpactG / 5.0) * 100, ((opts.peakSpeedMph ?? 25) / 60) * 100)
          : (opts.peakImpactG / 5.0) * 100,
      ),
    );
    void evaluateRisk(
      { timestampMs: opts.triggeredAtMs, impactScore },
      undefined,
      `ans://v1.0.0.guardian.${config.ansTeamDomain}`,
    ).catch((err) =>
      console.error("[EmergencyService] Failed to evaluate risk with Guardian API:", err),
    );

    void speak(this.voiceLine(alert, loc)).then((voice) => this.emit("voice", voice));

    return alert;
  }

  private resolvePhoneLocation(): GeoPoint | null {
    const sessionLoc = this.relay.getSession()?.lastLocation ?? null;
    const candidates = [sessionLoc, this.lastKnownLocation].filter(
      (g): g is GeoPoint =>
        Boolean(g) && Number.isFinite(g!.latitude) && Number.isFinite(g!.longitude),
    );
    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
      return candidates[0]!;
    }
    const withGeo = this.store
      .listObjects()
      .filter((o) => o.lastLocation && Number.isFinite(o.lastLocation.latitude));
    withGeo.sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
    return withGeo[0]?.lastLocation ?? null;
  }

  private emergencyMessage(alert: EmergencyAlert, loc: GeoPoint | null): string {
    const guardianDistress = Boolean(alert.guardianDistress ?? alert.policeBackup);
    if (alert.kind === "crash") {
      const spd = alert.peakSpeedMph != null ? `${alert.peakSpeedMph} mph` : "high speed";
      if (guardianDistress) {
        return loc
          ? `Possible vehicle crash after ${spd}. DEMO: would escalate with location ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}. No real dispatch.`
          : `Possible vehicle crash after ${spd}. DEMO: would escalate — waiting for phone GPS. No real dispatch.`;
      }
      return loc
        ? `Possible vehicle crash after ${spd}. DEMO: would contact 911 at ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}. No real call is placed.`
        : `Possible vehicle crash after ${spd}. DEMO: would contact 911 — waiting for phone GPS fix. No real call is placed.`;
    }

    const peakG = alert.peakImpactG;
    if (guardianDistress) {
      if (loc) {
        return `Possible responder distress / impact ${peakG}g. DEMO: would escalate with location ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}. No real dispatch.`;
      }
      return `Possible responder distress / impact ${peakG}g. DEMO: would escalate — waiting for phone GPS. No real dispatch.`;
    }
    if (loc) {
      const acc =
        loc.horizontalAccuracyMeters != null && Number.isFinite(loc.horizontalAccuracyMeters)
          ? ` (±${Math.round(loc.horizontalAccuracyMeters)}m)`
          : "";
      return `Possible hard fall detected (${peakG}g). DEMO: would contact 911 at ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}${acc}. No real call is placed.`;
    }
    return `Possible hard fall detected (${peakG}g). DEMO: would contact 911 — waiting for phone GPS fix. No real call is placed.`;
  }

  private voiceLine(alert: EmergencyAlert, loc: GeoPoint | null): string {
    const guardianDistress = Boolean(alert.guardianDistress ?? alert.policeBackup);
    const near = loc
      ? ` near ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`
      : "";
    if (alert.kind === "crash") {
      const spd =
        alert.peakSpeedMph != null ? ` after ${Math.round(alert.peakSpeedMph)} miles per hour` : "";
      return guardianDistress
        ? `SIGHTLINE guardian demo. Possible vehicle crash${spd}${near}. This is a demonstration only.`
        : `SIGHTLINE demo alert. Possible vehicle crash detected${spd}${near}. Contacting nine one one. This is a demonstration only.`;
    }
    return guardianDistress
      ? loc
        ? `SIGHTLINE guardian demo. Possible responder distress near ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}. This is a demonstration only.`
        : "SIGHTLINE guardian demo. Possible responder distress. This is a demonstration only."
      : loc
        ? `SIGHTLINE demo alert. Possible fall detected near ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}. Contacting nine one one. This is a demonstration only.`
        : "SIGHTLINE demo alert. Possible fall detected. Contacting nine one one. This is a demonstration only.";
  }
}
