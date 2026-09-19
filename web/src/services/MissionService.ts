import { EventEmitter } from "node:events";
import { config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { formatObjectPhrase } from "../memory/store.js";
import { speak } from "../voice/elevenlabs.js";
import type { Detection, GeoPoint, Mission } from "../shared/types.js";

export class MissionService extends EventEmitter {
  private placedAnchors = new Map<string, { location: GeoPoint; seenAtMs: number }>();

  constructor(private store: MemoryStore) {
    super();
  }

  reset() {
    this.placedAnchors.clear();
  }

  placeAnchor(objectId: string, location: GeoPoint, timestampMs: number) {
    this.placedAnchors.set(objectId, { location, seenAtMs: timestampMs });
  }

  async syncTrackMissions(
    detections: Detection[],
    location: GeoPoint | null | undefined,
    sessionId: string,
  ): Promise<void> {
    const active = this.store.listMissions().filter((m) => m.status === "active" && m.type === "track");
    for (const mission of active) {
      const target = mission.targetObjectId
        ? this.store.getObject(mission.targetObjectId)
        : this.store.searchObjects(mission.targetLabel ?? "")[0];
      if (!target) continue;

      const visible = detections.some((d) => {
        const hay = `${d.label} ${d.displayName} ${d.descriptors.join(" ")}`.toLowerCase();
        const needle = (mission.targetLabel ?? target.canonicalLabel).toLowerCase();
        return hay.includes(needle) || target.descriptors.some((desc) => hay.includes(desc));
      });

      if (visible && location) {
        this.placedAnchors.set(target.id, { location, seenAtMs: Date.now() });
      }
    }
  }

  async evaluateLeaveBehind(
    geo: GeoPoint & { sessionId: string },
    latestDetections: Detection[]
  ): Promise<void> {
    const active = this.store.listMissions().filter((m) => m.status === "active" && m.type === "track");
    for (const mission of active) {
      const target = mission.targetObjectId
        ? this.store.getObject(mission.targetObjectId)
        : this.store.searchObjects(mission.targetLabel ?? "")[0];
      if (!target) continue;

      const anchor = this.placedAnchors.get(target.id);
      if (!anchor?.location) continue;

      const moved = this.store.distanceMeters(anchor.location, geo);
      const absent = Date.now() - target.lastSeenAtMs;
      const currentlyVisible = latestDetections.some((d) =>
        `${d.label} ${d.descriptors.join(" ")}`.toLowerCase().includes(target.canonicalLabel),
      );

      if (
        !currentlyVisible &&
        moved >= (mission.triggerConfig.leaveBehindMeters ?? config.leaveBehindMeters) &&
        absent >= (mission.triggerConfig.absentMs ?? config.leaveBehindAbsentMs)
      ) {
        this.store.updateMissionStatus(mission.id, "triggered");
        const phrase = formatObjectPhrase(target);
        const event = this.store.markLeftBehind(
          target.id,
          target.lastLocation ?? anchor.location,
          `Left behind: ${phrase} (~${Math.round(moved)} m away, absent ${Math.round(absent / 1000)}s)`,
          geo.sessionId,
        );
        this.store.addEvent({
          type: "alerted",
          timestampMs: Date.now(),
          sessionId: geo.sessionId,
          missionId: mission.id,
          subjectObjectId: target.id,
          severity: "warn",
          description: `Alert: you may have left your ${phrase}`,
          location: target.lastLocation,
        });
        const voice = await speak(`SIGHTLINE alert. You may have left your ${phrase}.`);
        this.emit("voice", voice);
        this.emit("timeline", event);
        this.emit("mission_alerted");
      }
    }
  }

  startTrackMission(targetQuery: string): Mission {
    const hits = this.store.searchObjects(targetQuery);
    const target = hits[0];
    const mission = this.store.createMission({
      type: "track",
      status: "active",
      targetObjectId: target?.id,
      targetLabel: target?.canonicalLabel ?? targetQuery.toLowerCase(),
      targetDescriptors: target?.descriptors ?? [targetQuery.toLowerCase()],
      createdAtMs: Date.now(),
      triggerConfig: {
        leaveBehindMeters: config.leaveBehindMeters,
        absentMs: config.leaveBehindAbsentMs,
      },
    });
    
    this.store.addEvent({
      type: "mission_started",
      timestampMs: Date.now(),
      missionId: mission.id,
      subjectObjectId: target?.id,
      description: `Track mission started for “${mission.targetLabel}”`,
      location: target?.lastLocation,
    });
    
    if (target?.lastLocation) {
      this.placedAnchors.set(target.id, {
        location: target.lastLocation,
        seenAtMs: target.lastSeenAtMs,
      });
    }
    
    this.emit("mission_started", mission);
    return mission;
  }
}
