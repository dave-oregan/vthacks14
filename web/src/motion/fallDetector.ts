/**
 * Phone-drop / hard-impact detector from iPhone CoreMotion samples.
 * Demo only — never places a real emergency call.
 */

export type MotionSample = {
  sessionId: string;
  timestampMs: number;
  userAccelerationG: { x: number; y: number; z: number };
  gravityG?: { x: number; y: number; z: number } | null;
};

export type FallEvent = {
  sessionId: string;
  triggeredAtMs: number;
  peakImpactG: number;
  freefallMs: number;
  reason: string;
};

/** Free-fall: total accel magnitude near 0g (stricter than a running bounce). */
const FREEFALL_TOTAL_G = 0.28;
/** Impact after freefall (g) — above typical running footstrike (~2–3.5g). */
const IMPACT_USER_G = 4.0;
/** How long freefall window can be before impact (ms). */
const FREEFALL_WINDOW_MS = 1500;
/** Min sustained freefall before an impact counts as a fall (ms). */
const MIN_FREEFALL_MS = 180;
/** Cooldown between *automatic* motion alerts (ms). Dismiss resets this. */
const COOLDOWN_MS = 4_000;

export class FallDetector {
  private freefallStartedAt: number | null = null;
  private lastAlertAt = 0;

  /** Allow a new alert immediately (e.g. after user cancels the demo modal). */
  resetCooldown(): void {
    this.lastAlertAt = 0;
    this.freefallStartedAt = null;
  }

  push(sample: MotionSample): FallEvent | null {
    const now = sample.timestampMs;
    const ux = sample.userAccelerationG.x;
    const uy = sample.userAccelerationG.y;
    const uz = sample.userAccelerationG.z;
    const userMag = Math.sqrt(ux * ux + uy * uy + uz * uz);

    let totalMag = userMag;
    if (sample.gravityG) {
      const tx = sample.gravityG.x + ux;
      const ty = sample.gravityG.y + uy;
      const tz = sample.gravityG.z + uz;
      totalMag = Math.sqrt(tx * tx + ty * ty + tz * tz);
    }

    // Track freefall (weightlessness) — required for a real drop.
    if (totalMag < FREEFALL_TOTAL_G) {
      if (this.freefallStartedAt == null) this.freefallStartedAt = now;
    } else if (
      this.freefallStartedAt != null &&
      now - this.freefallStartedAt > FREEFALL_WINDOW_MS
    ) {
      this.freefallStartedAt = null;
    }

    const freefallMs =
      this.freefallStartedAt != null ? Math.max(0, now - this.freefallStartedAt) : 0;

    // Real fall only: sustained freefall, then a hard impact. No spike-only path
    // (that was catching running / pocket bumps).
    const hadFreefall = freefallMs >= MIN_FREEFALL_MS;
    const hardImpact = userMag >= IMPACT_USER_G;

    if (!(hadFreefall && hardImpact)) {
      // Clear freefall after normal motion resumes.
      if (userMag > 0.6 && totalMag > 0.7) this.freefallStartedAt = null;
      return null;
    }

    if (now - this.lastAlertAt < COOLDOWN_MS) {
      this.freefallStartedAt = null;
      return null;
    }

    this.lastAlertAt = now;
    this.freefallStartedAt = null;

    return {
      sessionId: sample.sessionId,
      triggeredAtMs: now,
      peakImpactG: Number(userMag.toFixed(2)),
      freefallMs,
      reason: `Freefall ~${freefallMs}ms then impact ${userMag.toFixed(1)}g`,
    };
  }

  /** Force a demo alert (no real motion required). */
  simulate(sessionId: string): FallEvent {
    const now = Date.now();
    this.lastAlertAt = now;
    this.freefallStartedAt = null;
    return {
      sessionId,
      triggeredAtMs: now,
      peakImpactG: 5.2,
      freefallMs: 320,
      reason: "DEMO: simulated phone drop / possible injury",
    };
  }
}
