import { v4 as uuid } from "uuid";
import type { GeoPoint, MemoryObject, Mission, TimelineEvent, AgentAccessRequest, BBox } from "../shared/types.js";
import { mirrorEvent, mirrorObject, mirrorAgentRequest } from "./db.js";

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class MemoryStore {
  private objects = new Map<string, MemoryObject>();
  private events: TimelineEvent[] = [];
  private missions: Mission[] = [];

  constructor(dbPath?: string) {}

  /** Restore a previous session's memory (from Atlas) into the live store. */
  hydrate(objects: MemoryObject[], events: TimelineEvent[]): void {
    for (const o of objects) if (!this.objects.has(o.id)) this.objects.set(o.id, o);
    const known = new Set(this.events.map((e) => e.id));
    for (const e of events) if (!known.has(e.id)) this.events.push(e);
  }

  resetDemo(): void {
    this.objects.clear();
    this.events = [];
    this.missions = [];
  }

  upsertSighting(input: any): { object: MemoryObject; isNew: boolean } {
    const normalized = normalizeLabel(input.label);
    const descriptors = unique([...(input.descriptors ?? []), input.displayName || "", normalized]);
    const displayName = (input.displayName?.trim() || buildDisplayName(normalized, descriptors) || normalized).toLowerCase();

    const existing = this.findBestMatch(normalized, descriptors, input.bbox, input.timestampMs);
    if (existing) {
      existing.descriptors = mergeDescriptors(existing.descriptors, descriptors);
      const nextName = displayName !== normalized && displayName.split(/\s+/).length >= 2 ? displayName : existing.displayName || displayName;
      existing.displayName = nextName;
      existing.lastSeenAtMs = input.timestampMs;
      if (input.location) existing.lastLocation = input.location;
      if (input.thumbJpeg) existing.lastFrameThumbJpeg = input.thumbJpeg;
      existing.lastBBox = input.bbox;
      existing.lastConfidence = input.confidence;
      existing.sightingCount++;
      existing.sessionId = input.sessionId;
      if (existing.status === "left_behind") existing.status = "observed";
      mirrorObject(existing);
      return { object: existing, isNew: false };
    }

    const id = uuid();
    const newObj: MemoryObject = {
      id, canonicalLabel: normalized, displayName, descriptors,
      firstSeenAtMs: input.timestampMs, lastSeenAtMs: input.timestampMs,
      lastLocation: input.location ?? null, lastFrameThumbJpeg: input.thumbJpeg ?? null,
      lastBBox: input.bbox, lastConfidence: input.confidence, sightingCount: 1,
      sessionId: input.sessionId, status: "observed"
    };
    this.objects.set(id, newObj);
    mirrorObject(newObj);
    return { object: newObj, isNew: true };
  }

  markLeftBehind(objectId: string, location: GeoPoint | null, description: string, sessionId: string): TimelineEvent {
    const obj = this.objects.get(objectId);
    if (obj) obj.status = "left_behind";
    return this.addEvent({ type: "left_behind", timestampMs: Date.now(), sessionId, severity: "warn", subjectObjectId: objectId, description, location });
  }

  markRecalled(objectId: string, sessionId: string): TimelineEvent {
    const obj = this.objects.get(objectId);
    if (obj) obj.status = "recalled";
    return this.addEvent({ type: "recalled", timestampMs: Date.now(), sessionId, severity: "info", subjectObjectId: objectId, description: obj ? `Recalled ${formatObjectPhrase(obj)} last seen ${new Date(obj.lastSeenAtMs).toLocaleString()}` : "Recalled object", location: obj?.lastLocation, frameRef: obj ? `object:${obj.id}` : undefined });
  }

  addEvent(partial: Omit<TimelineEvent, "id"> & { id?: string }): TimelineEvent {
    const event: TimelineEvent = { id: partial.id ?? uuid(), type: partial.type, timestampMs: partial.timestampMs, sessionId: partial.sessionId, missionId: partial.missionId, severity: partial.severity ?? "info", subjectObjectId: partial.subjectObjectId, description: partial.description, frameRef: partial.frameRef, location: partial.location ?? null };
    this.events.push(event);
    // Fire-and-forget: in-memory above is the live state, Atlas is what
    // survives a restart. The detection loop never waits on the network.
    mirrorEvent(event);
    return event;
  }

  listObjects(): MemoryObject[] { return Array.from(this.objects.values()).sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs); }
  getObject(id: string): MemoryObject | null { return this.objects.get(id) || null; }
  /**
   * Local recall search - the fallback when Atlas is unreachable, and the
   * resolver for ids Atlas hands back. Ranks by how many of the query's words
   * a card matches, prefers cards matching every word, and breaks ties by
   * most-recently-seen so the newest thing is always at the top.
   */
  searchObjects(query: string): MemoryObject[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return this.listObjects();

    const scored = this.listObjects()
      .map((o) => {
        const hay = `${o.displayName} ${o.canonicalLabel} ${o.descriptors.join(" ")}`.toLowerCase();
        const hits = tokens.filter((t) => matchesWord(hay, t));
        const complete = hits.length === tokens.length;
        return { o, score: hits.length + (complete ? 10 : 0), complete };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.o.lastSeenAtMs - a.o.lastSeenAtMs);

    // A specific query ("black laptop") should not return the white one just
    // because they are both laptops.
    const complete = scored.filter((x) => x.complete);
    const pool = complete.length > 0 ? complete : scored;
    return pool.map((x) => x.o);
  }
  listEvents(limit = 100): TimelineEvent[] { return [...this.events].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, limit); }
  
  createMission(mission: any): Mission {
    const full: Mission = { ...mission, id: mission.id ?? uuid() };
    this.missions.push(full);
    return full;
  }
  updateMissionStatus(id: string, status: Mission["status"]): void {
    const m = this.missions.find(m => m.id === id);
    if (m) m.status = status;
  }
  listMissions(): Mission[] { return [...this.missions].sort((a, b) => b.createdAtMs - a.createdAtMs); }
  saveAgentRequest(req: AgentAccessRequest): void { mirrorAgentRequest(req); }
  distanceMeters(a: GeoPoint, b: GeoPoint): number { return haversineMeters(a, b); }

  private findBestMatch(label: string, descriptors: string[], bbox: BBox, timestampMs: number): MemoryObject | null {
    const family = normalizeLabel(label);
    const candidates = this.listObjects().filter(o => normalizeLabel(o.canonicalLabel) === family);
    if (candidates.length === 0) return null;
    for (const c of candidates) {
      if (timestampMs - c.lastSeenAtMs <= 20000) return c;
    }
    return null;
  }
}

export function normalizeLabel(label: string): string {
  const l = label.toLowerCase().trim();
  if (["cell phone", "mobile phone", "iphone", "smartphone", "phone"].includes(l)) return "phone";
  if (["laptop", "notebook", "macbook"].includes(l)) return "laptop";
  if (["backpack", "rucksack"].includes(l)) return "backpack";
  if (["handbag", "purse"].includes(l)) return "bag";
  return l.replace(/\s+/g, " ");
}

/**
 * Match a token at a word boundary, not anywhere in the string. Plain
 * `includes` made "where is it" match "white laptop" (the "it" inside
 * "white"). Prefix matching is still allowed, so "lap" finds "laptop".
 */
function matchesWord(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}`, "i").test(haystack);
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[?.,!'"]/g, " ")
    .split(/\s+/)
    .map((t) => (t === "iphone" || t === "smartphone" ? "phone" : t))
    .map((t) => (t === "macbook" || t === "notebook" ? "laptop" : t))
    .map((t) => (t === "gray" ? "grey" : t))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function mergeDescriptors(a: string[], b: string[]): string[] { return unique([...a, ...b]).slice(0, 14); }
function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const k = item.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(k);
  }
  return out;
}

const COLORS = new Set(["black", "white", "grey", "gray", "silver", "space gray", "graphite", "blue", "red", "green", "yellow", "pink", "purple", "orange", "brown", "gold", "beige", "navy", "teal"]);
const STOPWORDS = new Set(["where", "is", "my", "the", "a", "an", "did", "i", "leave", "find", "last", "seen", "at", "of", "to", "me", "was", "are", "what", "which", "please", "show", "recall", "locate", "for", "and", "or", "in", "on", "with"]);

function buildDisplayName(label: string, descriptors: string[]): string {
  const family = normalizeLabel(label);
  const extras = descriptors.map(d => d.toLowerCase().trim()).filter(d => d && d !== family && !STOPWORDS.has(d));
  const colors = extras.filter(d => COLORS.has(d) || d === "grey" || d === "gray");
  const other = extras.filter(d => !COLORS.has(d) && d !== "grey" && d !== "gray").slice(0, 3);
  const parts = unique([...colors.slice(0, 1), ...other, family]);
  return parts.join(" ");
}

export function formatObjectPhrase(obj: MemoryObject): string {
  if (obj.displayName && obj.displayName.trim()) return obj.displayName.trim();
  const desc = obj.descriptors.filter((d) => d !== obj.canonicalLabel).slice(0, 3);
  if (desc.length === 0) return obj.canonicalLabel;
  return `${desc.join(" ")} ${obj.canonicalLabel}`;
}

