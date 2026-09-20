import { describe, expect, it, beforeEach } from "vitest";
import { MemoryStore } from "../memory/store.js";
import { GuardianService } from "../services/GuardianService.js";
import { queryGuardianMemory } from "./memoryQuery.js";
import type { Detection, GuardianEvent } from "../shared/types.js";

function det(partial: Partial<Detection> & { label: string }): Detection {
  return {
    trackId: partial.trackId ?? `t-${partial.label}`,
    label: partial.label,
    displayName: partial.displayName ?? partial.label,
    descriptors: partial.descriptors ?? [partial.label],
    confidence: partial.confidence ?? 0.91,
    bbox: partial.bbox ?? { x: 0.2, y: 0.2, width: 0.2, height: 0.3 },
    source: partial.source ?? "manual",
  };
}

describe("GuardianService", () => {
  let store: MemoryStore;
  let guardian: GuardianService;

  beforeEach(() => {
    store = new MemoryStore();
    guardian = new GuardianService(store);
    guardian.setEnabled(true);
  });

  it("creates potential_threat observation for a firearm without hostility/person-danger labels", async () => {
    await guardian.ingestDetections(
      Buffer.alloc(0),
      [det({ label: "firearm", confidence: 0.91 })],
      null,
      "test",
    );
    const events = guardian.getEvents();
    expect(events.some((e) => e.type === "possible_firearm")).toBe(true);
    const firearm = events.find((e) => e.type === "possible_firearm")!;
    expect(firearm.category).toBe("potential_threat");
    expect(firearm.title.toLowerCase()).toContain("firearm");
    expect(firearm.description.toLowerCase()).not.toMatch(/hostile|dangerous person|suspect|attacker/);
    expect(JSON.stringify(guardian.getStatus()).toLowerCase()).not.toMatch(/hostility|dangerLevel/);
  });

  it("creates vehicle event for license plate", async () => {
    await guardian.ingestDetections(
      Buffer.alloc(0),
      [det({ label: "license plate", confidence: 0.88, descriptors: ["license plate", "ABC-1234"] })],
      null,
      "test",
    );
    const plate = guardian.getEvents().find((e) => e.category === "vehicle");
    expect(plate).toBeTruthy();
    expect(plate!.type).toBe("license_plate_observed");
  });

  it("stores safety-resource observation in memory", async () => {
    await guardian.ingestDetections(
      Buffer.alloc(0),
      [det({ label: "AED", displayName: "AED", confidence: 0.9 })],
      null,
      "test",
    );
    const aed = guardian.getEvents().find((e) => e.category === "safety_resource");
    expect(aed).toBeTruthy();
    expect(aed!.type).toBe("aed");
  });

  it("single motion signal does not auto-confirm critical fused emergency", () => {
    const event = guardian.ingestMotionFall({
      peakImpactG: 4.1,
      location: null,
      sessionId: "test",
    });
    expect(event).toBeTruthy();
    expect(event!.type).toBe("possible_responder_distress_weak");
    expect(event!.severity).toBe("medium");
    expect(event!.metadata?.fused).toBe(false);
  });

  it("fall + help produces fused responder-distress event", () => {
    guardian.ingestAudioTranscript("help", null, "test");
    const event = guardian.ingestMotionFall({
      peakImpactG: 4.2,
      location: null,
      sessionId: "test",
    });
    expect(event).toBeTruthy();
    expect(event!.type).toBe("possible_responder_distress");
    expect(event!.severity).toBe("critical");
    expect(event!.metadata?.fused).toBe(true);
    expect(event!.source).toBe("multimodal");
  });

  it("propagates confidence and supports confirm/dismiss", async () => {
    await guardian.ingestDetections(
      Buffer.alloc(0),
      [det({ label: "knife", confidence: 0.77 })],
      null,
      "test",
    );
    const blade = guardian.getEvents().find((e) => e.type === "possible_blade")!;
    expect(blade.confidence).toBeCloseTo(0.77);
    guardian.confirm(blade.id);
    expect(guardian.getAllEvents().find((e) => e.id === blade.id)?.status).toBe("confirmed");
    guardian.dismiss(blade.id);
    expect(guardian.getEvents().find((e) => e.id === blade.id)).toBeUndefined();
    expect(guardian.getAllEvents().find((e) => e.id === blade.id)?.status).toBe("dismissed");
  });

  it("memory query does not fabricate nonexistent observations", () => {
    const empty = queryGuardianMemory([], "Where was the last AED?");
    expect(empty.text).toMatch(/don.t have a recorded observation/i);
    expect(empty.matches).toHaveLength(0);

    const withAed = guardian.injectDemoEvent({
      category: "safety_resource",
      type: "aed",
      title: "AED observed",
      description: "Near elevator",
      confidence: 0.9,
      severity: "info",
      source: "manual",
      requiresReview: false,
      status: "new",
    });
    const hit = queryGuardianMemory([withAed], "Where was the last AED?");
    expect(hit.matches.length).toBeGreaterThan(0);
    expect(hit.text).toMatch(/AED/i);

    const miss = queryGuardianMemory([withAed], "What was the plate on the gray car?");
    expect(miss.matches).toHaveLength(0);
    expect(miss.text).toMatch(/don.t have a recorded observation/i);
  });

  it("incident timeline orders newest first", () => {
    const a = guardian.injectDemoEvent({
      category: "safety_resource",
      type: "aed",
      title: "AED",
      description: "a",
      severity: "info",
      source: "manual",
      status: "new",
      timestamp: 1000,
    });
    const b = guardian.injectDemoEvent({
      category: "vehicle",
      type: "license_plate_observed",
      title: "Plate",
      description: "b",
      severity: "medium",
      source: "manual",
      status: "new",
      timestamp: 2000,
    });
    const events = guardian.getEvents();
    expect(events[0]!.id).toBe(b.id);
    expect(events[1]!.id).toBe(a.id);
  });
});
