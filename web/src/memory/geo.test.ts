import { describe, expect, it } from "vitest";
import { MemoryStore, isValidGeo } from "../memory/store.js";

describe("memory geo stamping", () => {
  it("rejects invalid coords", () => {
    expect(isValidGeo(null)).toBe(false);
    expect(
      isValidGeo({ latitude: NaN, longitude: -80, timestampMs: 1 }),
    ).toBe(false);
    expect(
      isValidGeo({ latitude: 0, longitude: 0, timestampMs: 1 }),
    ).toBe(false);
    expect(
      isValidGeo({ latitude: 37.2, longitude: -80.4, timestampMs: 1 }),
    ).toBe(true);
  });

  it("backfills lastLocation onto recent objects when GPS arrives late", () => {
    const store = new MemoryStore();
    const now = Date.now();
    store.upsertSighting({
      label: "laptop",
      displayName: "black laptop",
      descriptors: ["black", "laptop"],
      confidence: 0.9,
      bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      location: null,
      sessionId: "s1",
      timestampMs: now,
    });
    expect(store.listObjects()[0]!.lastLocation).toBeNull();

    const n = store.stampLocation({
      latitude: 37.229,
      longitude: -80.414,
      timestampMs: now,
      horizontalAccuracyMeters: 8,
    });
    expect(n).toBe(1);
    expect(store.listObjects()[0]!.lastLocation?.latitude).toBeCloseTo(37.229);
    expect(store.listObjects()[0]!.lastLocation?.longitude).toBeCloseTo(-80.414);
  });

  it("records geo on upsert when location is present", () => {
    const store = new MemoryStore();
    const { object } = store.upsertSighting({
      label: "phone",
      confidence: 0.8,
      bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.2 },
      location: { latitude: 37.1, longitude: -80.5, timestampMs: Date.now() },
      sessionId: "s1",
      timestampMs: Date.now(),
    });
    expect(object.lastLocation?.latitude).toBeCloseTo(37.1);
  });
});
