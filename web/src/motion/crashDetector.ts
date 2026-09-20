/**
 * Vehicle crash heuristic from GPS speed (+ optional IMU impact).
 * Requires travel above 25 mph immediately before a rapid deceleration.
 * Demo only — never places a real emergency call.
 */

export type SpeedSample = {
  sessionId: string;
  timestampMs: number;
  /** CoreLocation speed; negative / null means unknown. */
  speedMetersPerSecond: number | null;
};

export type MotionImpactSample = {
  sessionId: string;
  timestampMs: number;
  userAccelerationG: { x: number; y: number; z: number };
};

export type CrashEvent = {
  sessionId: string;
  triggeredAtMs: number;
  peakImpactG: number;
  peakSpeedMph: number;
  decelerationMphPerSec: number;
  reason: string;
};

const MPH_PER_MPS = 2.23693629;
/** Must have been traveling at least this fast before the smash. */
const HIGH_SPEED_MPH = 25;
/** Look back this far for the pre-crash speed peak. */
const HIGH_SPEED_LOOKBACK_MS = 4_000;
/** Speed drop (mph) within the deceleration window that counts as a crash. */
const RAPID_DROP_MPH = 15;
/** Window over which the drop must occur. */
const DECEL_WINDOW_MS = 2_000;
/** Min average deceleration (mph/s) across the window. */
const MIN_DECEL_MPH_PER_SEC = 8;
/** IMU impact (user-g) that can confirm a crash while still high-speed-armed. */
const IMPACT_CONFIRM_G = 3.2;
/** How long after last >25 mph sample we still accept an IMU smash. */
const ARMED_HOLD_MS = 3_000;
const COOLDOWN_MS = 6_000;
const MAX_HISTORY = 40;

function toMph(mps: number): number {
  return mps * MPH_PER_MPS;
}

export class CrashDetector {
  private history: Array<{ t: number; mph: number; sessionId: string }> = [];
  private lastHighSpeedAt = 0;
  private peakArmedMph = 0;
  private lastAlertAt = 0;

  resetCooldown(): void {
    this.lastAlertAt = 0;
    this.history = [];
    this.lastHighSpeedAt = 0;
    this.peakArmedMph = 0;
  }

  /** Feed a GPS speed sample. Returns a crash event when criteria match. */
  pushSpeed(sample: SpeedSample): CrashEvent | null {
    const mps = sample.speedMetersPerSecond;
    if (mps == null || !Number.isFinite(mps) || mps < 0) return null;

    const now = sample.timestampMs;
    const mph = toMph(mps);
    this.history.push({ t: now, mph, sessionId: sample.sessionId });
    while (this.history.length > MAX_HISTORY) this.history.shift();
    while (this.history.length && now - this.history[0]!.t > HIGH_SPEED_LOOKBACK_MS + DECEL_WINDOW_MS) {
      this.history.shift();
    }

    if (mph >= HIGH_SPEED_MPH) {
      this.lastHighSpeedAt = now;
      this.peakArmedMph = Math.max(this.peakArmedMph, mph);
    } else if (now - this.lastHighSpeedAt > ARMED_HOLD_MS) {
      this.peakArmedMph = 0;
    }

    const priorPeak = this.peakInWindow(now - DECEL_WINDOW_MS, now);
    const hadHighSpeed =
      priorPeak >= HIGH_SPEED_MPH ||
      (this.peakArmedMph >= HIGH_SPEED_MPH && now - this.lastHighSpeedAt <= ARMED_HOLD_MS);

    if (!hadHighSpeed) return null;

    const drop = priorPeak - mph;
    const dtSec = Math.max(0.25, DECEL_WINDOW_MS / 1000);
    const decelMphPerSec = drop / dtSec;

    const rapidDrop = drop >= RAPID_DROP_MPH && decelMphPerSec >= MIN_DECEL_MPH_PER_SEC;
    if (!rapidDrop) return null;

    return this.fire({
      sessionId: sample.sessionId,
      triggeredAtMs: now,
      peakImpactG: 0,
      peakSpeedMph: Number(Math.max(priorPeak, this.peakArmedMph).toFixed(1)),
      decelerationMphPerSec: Number(decelMphPerSec.toFixed(1)),
      reason: `Traveling ${Math.max(priorPeak, this.peakArmedMph).toFixed(0)} mph then rapid deceleration (−${drop.toFixed(0)} mph / ${(DECEL_WINDOW_MS / 1000).toFixed(1)}s)`,
    });
  }

  /**
   * Optional IMU confirm: hard impact while recently above 25 mph
   * (covers GPS update lag during a real collision).
   */
  pushMotion(sample: MotionImpactSample): CrashEvent | null {
    const now = sample.timestampMs;
    if (now - this.lastHighSpeedAt > ARMED_HOLD_MS || this.peakArmedMph < HIGH_SPEED_MPH) {
      return null;
    }
    const { x, y, z } = sample.userAccelerationG;
    const userMag = Math.sqrt(x * x + y * y + z * z);
    if (userMag < IMPACT_CONFIRM_G) return null;

    return this.fire({
      sessionId: sample.sessionId,
      triggeredAtMs: now,
      peakImpactG: Number(userMag.toFixed(2)),
      peakSpeedMph: Number(this.peakArmedMph.toFixed(1)),
      decelerationMphPerSec: 0,
      reason: `Traveling ${this.peakArmedMph.toFixed(0)} mph then impact ${userMag.toFixed(1)}g`,
    });
  }

  simulate(sessionId: string): CrashEvent {
    const now = Date.now();
    this.lastAlertAt = now;
    this.lastHighSpeedAt = 0;
    this.peakArmedMph = 0;
    this.history = [];
    return {
      sessionId,
      triggeredAtMs: now,
      peakImpactG: 4.8,
      peakSpeedMph: 42,
      decelerationMphPerSec: 18,
      reason: "DEMO: simulated vehicle crash (42 mph → rapid deceleration)",
    };
  }

  private peakInWindow(fromMs: number, toMs: number): number {
    let peak = 0;
    for (const p of this.history) {
      if (p.t >= fromMs && p.t <= toMs) peak = Math.max(peak, p.mph);
    }
    return peak;
  }

  private fire(event: CrashEvent): CrashEvent | null {
    if (event.triggeredAtMs - this.lastAlertAt < COOLDOWN_MS) return null;
    this.lastAlertAt = event.triggeredAtMs;
    this.history = [];
    this.lastHighSpeedAt = 0;
    this.peakArmedMph = 0;
    return event;
  }
}
