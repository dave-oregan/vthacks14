import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import type {
  GeoPoint,
  MemoryObject,
  Mission,
  TimelineEvent,
  AgentAccessRequest,
  BBox,
} from "../shared/types.js";

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath = config.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        canonical_label TEXT NOT NULL,
        descriptors_json TEXT NOT NULL,
        first_seen_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL,
        last_location_json TEXT,
        last_frame_thumb BLOB,
        last_bbox_json TEXT,
        last_confidence REAL NOT NULL,
        sighting_count INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT,
        mission_id TEXT,
        severity TEXT,
        subject_object_id TEXT,
        description TEXT NOT NULL,
        frame_ref TEXT,
        location_json TEXT
      );
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        target_object_id TEXT,
        target_label TEXT,
        target_descriptors_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        trigger_config_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_requests (
        id TEXT PRIMARY KEY,
        agent_ans_name TEXT NOT NULL,
        requested_scopes_json TEXT NOT NULL,
        mission_id TEXT,
        verification_status TEXT NOT NULL,
        decision TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_objects_label ON objects(canonical_label);
      CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp_ms DESC);
    `);
  }

  resetDemo(): void {
    this.db.exec(`DELETE FROM objects; DELETE FROM events; DELETE FROM missions; DELETE FROM agent_requests;`);
  }

  upsertSighting(input: {
    label: string;
    descriptors: string[];
    confidence: number;
    bbox: BBox;
    location?: GeoPoint | null;
    thumbJpeg?: Buffer | null;
    sessionId: string;
    timestampMs: number;
  }): { object: MemoryObject; isNew: boolean } {
    const normalized = normalizeLabel(input.label);
    const existing = this.findBestMatch(normalized, input.descriptors);
    if (existing) {
      const descriptors = mergeDescriptors(existing.descriptors, input.descriptors);
      this.db
        .prepare(
          `UPDATE objects SET
            descriptors_json = ?,
            last_seen_at_ms = ?,
            last_location_json = ?,
            last_frame_thumb = COALESCE(?, last_frame_thumb),
            last_bbox_json = ?,
            last_confidence = ?,
            sighting_count = sighting_count + 1,
            session_id = ?,
            status = CASE WHEN status = 'left_behind' THEN 'observed' ELSE status END
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(descriptors),
          input.timestampMs,
          input.location ? JSON.stringify(input.location) : existing.lastLocation
            ? JSON.stringify(existing.lastLocation)
            : null,
          input.thumbJpeg ?? null,
          JSON.stringify(input.bbox),
          input.confidence,
          input.sessionId,
          existing.id,
        );
      const updated = this.getObject(existing.id)!;
      return { object: updated, isNew: false };
    }

    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO objects (
          id, canonical_label, descriptors_json, first_seen_at_ms, last_seen_at_ms,
          last_location_json, last_frame_thumb, last_bbox_json, last_confidence,
          sighting_count, session_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'observed')`,
      )
      .run(
        id,
        normalized,
        JSON.stringify(unique(input.descriptors)),
        input.timestampMs,
        input.timestampMs,
        input.location ? JSON.stringify(input.location) : null,
        input.thumbJpeg ?? null,
        JSON.stringify(input.bbox),
        input.confidence,
        input.sessionId,
      );
    return { object: this.getObject(id)!, isNew: true };
  }

  markLeftBehind(objectId: string, location: GeoPoint | null, description: string, sessionId: string): TimelineEvent {
    this.db.prepare(`UPDATE objects SET status = 'left_behind' WHERE id = ?`).run(objectId);
    return this.addEvent({
      type: "left_behind",
      timestampMs: Date.now(),
      sessionId,
      severity: "warn",
      subjectObjectId: objectId,
      description,
      location,
    });
  }

  markRecalled(objectId: string, sessionId: string): TimelineEvent {
    this.db.prepare(`UPDATE objects SET status = 'recalled' WHERE id = ?`).run(objectId);
    const obj = this.getObject(objectId);
    return this.addEvent({
      type: "recalled",
      timestampMs: Date.now(),
      sessionId,
      severity: "info",
      subjectObjectId: objectId,
      description: obj
        ? `Recalled ${formatObjectPhrase(obj)} last seen ${formatWhen(obj.lastSeenAtMs)}${formatWhere(obj.lastLocation)}`
        : "Recalled object",
      location: obj?.lastLocation,
      frameRef: obj ? `object:${obj.id}` : undefined,
    });
  }

  addEvent(partial: Omit<TimelineEvent, "id"> & { id?: string }): TimelineEvent {
    const event: TimelineEvent = {
      id: partial.id ?? uuid(),
      type: partial.type,
      timestampMs: partial.timestampMs,
      sessionId: partial.sessionId,
      missionId: partial.missionId,
      severity: partial.severity ?? "info",
      subjectObjectId: partial.subjectObjectId,
      description: partial.description,
      frameRef: partial.frameRef,
      location: partial.location,
    };
    this.db
      .prepare(
        `INSERT INTO events (
          id, type, timestamp_ms, session_id, mission_id, severity,
          subject_object_id, description, frame_ref, location_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.timestampMs,
        event.sessionId ?? null,
        event.missionId ?? null,
        event.severity ?? null,
        event.subjectObjectId ?? null,
        event.description,
        event.frameRef ?? null,
        event.location ? JSON.stringify(event.location) : null,
      );
    return event;
  }

  listObjects(): MemoryObject[] {
    const rows = this.db.prepare(`SELECT * FROM objects ORDER BY last_seen_at_ms DESC`).all() as RawObject[];
    return rows.map(rowToObject);
  }

  getObject(id: string): MemoryObject | null {
    const row = this.db.prepare(`SELECT * FROM objects WHERE id = ?`).get(id) as RawObject | undefined;
    return row ? rowToObject(row) : null;
  }

  searchObjects(query: string): MemoryObject[] {
    const q = query.toLowerCase().trim();
    return this.listObjects().filter((o) => {
      const hay = `${o.canonicalLabel} ${o.descriptors.join(" ")}`.toLowerCase();
      return q.split(/\s+/).every((token) => hay.includes(token));
    });
  }

  listEvents(limit = 100): TimelineEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events ORDER BY timestamp_ms DESC LIMIT ?`)
      .all(limit) as RawEvent[];
    return rows.map(rowToEvent);
  }

  createMission(mission: Omit<Mission, "id"> & { id?: string }): Mission {
    const full: Mission = { ...mission, id: mission.id ?? uuid() };
    this.db
      .prepare(
        `INSERT INTO missions (
          id, type, status, target_object_id, target_label, target_descriptors_json,
          created_at_ms, trigger_config_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.type,
        full.status,
        full.targetObjectId ?? null,
        full.targetLabel ?? null,
        JSON.stringify(full.targetDescriptors),
        full.createdAtMs,
        JSON.stringify(full.triggerConfig),
      );
    return full;
  }

  updateMissionStatus(id: string, status: Mission["status"]): void {
    this.db.prepare(`UPDATE missions SET status = ? WHERE id = ?`).run(status, id);
  }

  listMissions(): Mission[] {
    const rows = this.db.prepare(`SELECT * FROM missions ORDER BY created_at_ms DESC`).all() as RawMission[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type as Mission["type"],
      status: r.status as Mission["status"],
      targetObjectId: r.target_object_id ?? undefined,
      targetLabel: r.target_label ?? undefined,
      targetDescriptors: JSON.parse(r.target_descriptors_json) as string[],
      createdAtMs: r.created_at_ms,
      triggerConfig: JSON.parse(r.trigger_config_json) as Mission["triggerConfig"],
    }));
  }

  saveAgentRequest(req: AgentAccessRequest): void {
    this.db
      .prepare(
        `INSERT INTO agent_requests (
          id, agent_ans_name, requested_scopes_json, mission_id,
          verification_status, decision, timestamp_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.id,
        req.agentAnsName,
        JSON.stringify(req.requestedScopes),
        req.missionId ?? null,
        req.verificationStatus,
        req.decision,
        req.timestampMs,
      );
  }

  distanceMeters(a: GeoPoint, b: GeoPoint): number {
    return haversineMeters(a, b);
  }

  private findBestMatch(label: string, descriptors: string[]): MemoryObject | null {
    const candidates = this.listObjects().filter((o) => o.canonicalLabel === label);
    if (candidates.length === 0) {
      // soft match: phone/cell phone/iphone family
      const family = labelFamily(label);
      const soft = this.listObjects().filter((o) => labelFamily(o.canonicalLabel) === family);
      if (soft.length === 0) return null;
      return pickByDescriptorOverlap(soft, descriptors);
    }
    return pickByDescriptorOverlap(candidates, descriptors);
  }
}

interface RawObject {
  id: string;
  canonical_label: string;
  descriptors_json: string;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  last_location_json: string | null;
  last_frame_thumb: Buffer | null;
  last_bbox_json: string | null;
  last_confidence: number;
  sighting_count: number;
  session_id: string;
  status: string;
}

interface RawEvent {
  id: string;
  type: string;
  timestamp_ms: number;
  session_id: string | null;
  mission_id: string | null;
  severity: string | null;
  subject_object_id: string | null;
  description: string;
  frame_ref: string | null;
  location_json: string | null;
}

interface RawMission {
  id: string;
  type: string;
  status: string;
  target_object_id: string | null;
  target_label: string | null;
  target_descriptors_json: string;
  created_at_ms: number;
  trigger_config_json: string;
}

function rowToObject(row: RawObject): MemoryObject {
  return {
    id: row.id,
    canonicalLabel: row.canonical_label,
    descriptors: JSON.parse(row.descriptors_json) as string[],
    firstSeenAtMs: row.first_seen_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    lastLocation: row.last_location_json
      ? (JSON.parse(row.last_location_json) as GeoPoint)
      : null,
    lastFrameThumbJpeg: row.last_frame_thumb,
    lastBBox: row.last_bbox_json ? (JSON.parse(row.last_bbox_json) as BBox) : null,
    lastConfidence: row.last_confidence,
    sightingCount: row.sighting_count,
    sessionId: row.session_id,
    status: row.status as MemoryObject["status"],
  };
}

function rowToEvent(row: RawEvent): TimelineEvent {
  return {
    id: row.id,
    type: row.type as TimelineEvent["type"],
    timestampMs: row.timestamp_ms,
    sessionId: row.session_id ?? undefined,
    missionId: row.mission_id ?? undefined,
    severity: (row.severity as TimelineEvent["severity"]) ?? "info",
    subjectObjectId: row.subject_object_id ?? undefined,
    description: row.description,
    frameRef: row.frame_ref ?? undefined,
    location: row.location_json ? (JSON.parse(row.location_json) as GeoPoint) : null,
  };
}

export function normalizeLabel(label: string): string {
  const l = label.toLowerCase().trim();
  if (["cell phone", "mobile phone", "iphone", "smartphone", "phone"].includes(l)) {
    return "phone";
  }
  if (["laptop", "notebook", "macbook"].includes(l)) return "laptop";
  if (["backpack", "rucksack"].includes(l)) return "backpack";
  if (["handbag", "purse"].includes(l)) return "bag";
  return l.replace(/\s+/g, " ");
}

function labelFamily(label: string): string {
  return normalizeLabel(label);
}

function mergeDescriptors(a: string[], b: string[]): string[] {
  return unique([...a, ...b]).slice(0, 12);
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const k = item.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function pickByDescriptorOverlap(candidates: MemoryObject[], descriptors: string[]): MemoryObject {
  if (candidates.length === 1) return candidates[0]!;
  const set = new Set(descriptors.map((d) => d.toLowerCase()));
  let best = candidates[0]!;
  let bestScore = -1;
  for (const c of candidates) {
    const score = c.descriptors.reduce((n, d) => n + (set.has(d.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore || (score === bestScore && c.lastSeenAtMs > best.lastSeenAtMs)) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export function formatObjectPhrase(obj: MemoryObject): string {
  const desc = obj.descriptors.filter((d) => d !== obj.canonicalLabel).slice(0, 3);
  if (desc.length === 0) return obj.canonicalLabel;
  return `${desc.join(" ")} ${obj.canonicalLabel}`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatWhere(loc?: GeoPoint | null): string {
  if (!loc) return "";
  return ` @ ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
}
