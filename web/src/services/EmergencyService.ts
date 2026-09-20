import { EventEmitter } from "node:events";
import type { RelayHub } from "../relay/relayHub.js";
import type { MemoryStore } from "../memory/store.js";
import { FallDetector, type FallEvent, type MotionSample } from "../motion/fallDetector.js";
import { speak } from "../voice/elevenlabs.js";
import type { EmergencyAlert, GeoPoint } from "../shared/types.js";
import { evaluateRisk } from "../api/guardian.js";
import { config } from "../config.js";

export class EmergencyService extends EventEmitter {
  private fallDetector = new FallDetector();
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
  }

  processMotion(sample: MotionSample) {
    const fall = this.fallDetector.push(sample);
    if (fall) this.triggerEmergency(fall);
  }

  updateLocation(geo: GeoPoint & { sessionId: string }) {
    if (Number.isFinite(geo.latitude) && Number.isFinite(geo.longitude)) {
      this.lastKnownLocation = {
        latitude: geo.latitude,
        longitude: geo.longitude,
        altitudeMeters: geo.altitudeMeters,
        horizontalAccuracyMeters: geo.horizontalAccuracyMeters,
        timestampMs: geo.timestampMs,
      };

      if (this.emergencyAlert?.active) {
        this.emergencyAlert = {
          ...this.emergencyAlert,
          location: this.lastKnownLocation,
          message: this.emergencyMessage(
            this.emergencyAlert.peakImpactG,
            this.lastKnownLocation,
            Boolean(this.emergencyAlert.guardianDistress ?? this.emergencyAlert.policeBackup),
          ),
        };
        this.emit("emergency", this.emergencyAlert);
      }
    }
  }

  simulateFall(): EmergencyAlert {
    this.fallDetector.resetCooldown();
    const sessionId = this.relay.getSession()?.sessionId ?? "demo";
    const fall = this.fallDetector.simulate(sessionId);
    return this.triggerEmergency(fall);
  }

  dismissEmergency(): void {
    this.fallDetector.resetCooldown();
    this.emergencyAlert = null;
    this.emit("emergency", null);
  }

  private triggerEmergency(fall: FallEvent): EmergencyAlert {
    const loc = this.resolvePhoneLocation();
    const guardianDistress = this.isGuardianMode();
    const alert: EmergencyAlert = {
      active: true,
      demo: true,
      triggeredAtMs: fall.triggeredAtMs,
      peakImpactG: fall.peakImpactG,
      freefallMs: fall.freefallMs,
      reason: fall.reason,
      message: this.emergencyMessage(fall.peakImpactG, loc, guardianDistress),
      location: loc,
      guardianDistress,
      policeBackup: guardianDistress,
    };

    this.emergencyAlert = alert;

    this.store.addEvent({
      type: "possible_emergency",
      timestampMs: fall.triggeredAtMs,
      sessionId: fall.sessionId,
      severity: "critical",
      description: alert.message,
      location: loc,
    });

    console.warn(
      `[emergency:demo] ${guardianDistress ? "guardian-distress" : "911"} ${fall.reason} peak=${fall.peakImpactG}g loc=${
        loc ? `${loc.latitude.toFixed(5)},${loc.longitude.toFixed(5)}` : "none"
      }`,
    );

    this.emit("emergency", alert);
    if (guardianDistress) {
      this.emit("guardian_responder_distress", {
        peakImpactG: fall.peakImpactG,
        location: loc,
        sessionId: fall.sessionId,
        alert,
      });
      // Compat alias for any leftover listeners
      this.emit("police_officer_down", {
        peakImpactG: fall.peakImpactG,
        location: loc,
        sessionId: fall.sessionId,
        alert,
      });
    }

    const impactScore = Math.min(100, Math.max(0, (fall.peakImpactG / 5.0) * 100));
    void evaluateRisk(
      { timestampMs: fall.triggeredAtMs, impactScore },
      undefined,
      `ans://v1.0.0.guardian.${config.ansTeamDomain}`,
    ).catch((err) =>
      console.error("[EmergencyService] Failed to evaluate risk with Guardian API:", err),
    );

    void speak(
      guardianDistress
        ? loc
          ? `SIGHTLINE guardian demo. Possible responder distress near ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}. This is a demonstration only.`
          : "SIGHTLINE guardian demo. Possible responder distress. This is a demonstration only."
        : loc
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
      candidates.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
      return candidates[0]!;
    }
    const withGeo = this.store
      .listObjects()
      .filter((o) => o.lastLocation && Number.isFinite(o.lastLocation.latitude));
    withGeo.sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
    return withGeo[0]?.lastLocation ?? null;
  }

  private emergencyMessage(peakG: number, loc: GeoPoint | null, guardianDistress: boolean): string {
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
}
