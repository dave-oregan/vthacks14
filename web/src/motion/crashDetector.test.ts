import { describe, expect, it } from "vitest";
import { CrashDetector } from "./crashDetector.js";

const MPS_PER_MPH = 1 / 2.23693629;

describe("CrashDetector", () => {
  it("fires when >25 mph then rapid deceleration", () => {
    const d = new CrashDetector();
    const t0 = 1_000_000;
    expect(
      d.pushSpeed({
        sessionId: "s1",
        timestampMs: t0,
        speedMetersPerSecond: 40 * MPS_PER_MPH,
      }),
    ).toBeNull();

    const crash = d.pushSpeed({
      sessionId: "s1",
      timestampMs: t0 + 1500,
      speedMetersPerSecond: 5 * MPS_PER_MPH,
    });
    expect(crash).not.toBeNull();
    expect(crash!.peakSpeedMph).toBeGreaterThanOrEqual(25);
    expect(crash!.reason).toMatch(/rapid deceleration/i);
  });

  it("does not fire below 25 mph even with a big drop", () => {
    const d = new CrashDetector();
    const t0 = 2_000_000;
    d.pushSpeed({
      sessionId: "s1",
      timestampMs: t0,
      speedMetersPerSecond: 20 * MPS_PER_MPH,
    });
    expect(
      d.pushSpeed({
        sessionId: "s1",
        timestampMs: t0 + 1000,
        speedMetersPerSecond: 0,
      }),
    ).toBeNull();
  });

  it("confirms with IMU impact while high-speed armed", () => {
    const d = new CrashDetector();
    const t0 = 3_000_000;
    d.pushSpeed({
      sessionId: "s1",
      timestampMs: t0,
      speedMetersPerSecond: 35 * MPS_PER_MPH,
    });
    const crash = d.pushMotion({
      sessionId: "s1",
      timestampMs: t0 + 400,
      userAccelerationG: { x: 0, y: 0, z: 4.0 },
    });
    expect(crash).not.toBeNull();
    expect(crash!.peakImpactG).toBeGreaterThanOrEqual(3.2);
  });
});
