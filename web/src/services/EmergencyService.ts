import { EventEmitter } from "node:events";
import type { RelayHub } from "../relay/relayHub.js";
import type { MemoryStore } from "../memory/store.js";
import { FallDetector, type FallEvent, type MotionSample } from "../motion/fallDetector.js";
import { speak } from "../voice/elevenlabs.js";
import type { EmergencyAlert, GeoPoint } from "../shared/types.js";

export class EmergencyService extends EventEmitter {
  private fallDetector = new FallDetector();
  public emergencyAlert: EmergencyAlert | null = null;
  public lastKnownLocation: GeoPoint | null = null;

  constructor(
    private relay: RelayHub,
    private store: MemoryStore
  ) {
    super();
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
      `[emergency:demo] ${fall.reason} peak=${fall.peakImpactG}g loc=${
        loc ? `${loc.latitude.toFixed(5)},${loc.longitude.toFixed(5)}` : "none"
      }`,
    );
    
    this.emit("emergency", alert);
    
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
      candidates.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
      return candidates[0]!;
    }
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
}
