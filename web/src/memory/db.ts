import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../config.js";
import type { MemoryObject, TimelineEvent, AgentAccessRequest } from "../shared/types.js";

/**
 * MongoDB Atlas persistence for SIGHTLINE.
 *
 * MemoryStore holds the live state in plain Maps and arrays, which is fast and
 * never blocks the detection loop — but it dies with the process. Atlas is the
 * only thing in this system that survives a restart, so it is not a nice-to-have
 * mirror: it is the memory layer.
 *
 * Two directions:
 *   write — every event, object and ANS decision is mirrored FIRE-AND-FORGET.
 *           Nothing in the live loop ever awaits Atlas. If the cluster is slow,
 *           down, or unreachable on venue wifi, the demo is unaffected.
 *   read  — on startup we rehydrate the in-memory store from Atlas, so killing
 *           and restarting the backend does not lose the session's memory.
 *
 * Nothing here ever throws into a caller.
 */

const DB_NAME = "sightline";

let client: MongoClient | null = null;
let db: Db | null = null;

const counts = { events: 0, objects: 0, agents: 0, transcripts: 0, failures: 0 };
let lastError: string | null = null;
let connectedAt: number | null = null;
let restored = { objects: 0, events: 0 };

/** Documents use the same uuid the in-memory store uses, not ObjectIds. */
interface WithStringId {
  _id: string;
}
type EventDoc = WithStringId & Record<string, unknown>;
type ObjectDoc = WithStringId & Record<string, unknown>;
type AgentDoc = WithStringId & Record<string, unknown>;
type TranscriptDoc = Record<string, unknown>;

/** Strip credentials out of a mongodb+srv URI so we can log it safely. */
function redactUri(uri: string): string {
  try {
    const u = new URL(uri);
    u.password = "";
    u.username = u.username ? "***" : "";
    return `${u.protocol}//${u.username ? "***@" : ""}${u.host}${u.pathname}`;
  } catch {
    return "(unparseable uri)";
  }
}

function events(): Collection<EventDoc> | null {
  return db ? db.collection<EventDoc>("events") : null;
}

export async function connectDatabases(): Promise<void> {
  if (!config.mongoUri) {
    console.warn("[db] MONGO_URI not set - running in-memory only, state is lost on restart");
    return;
  }

  try {
    client = new MongoClient(config.mongoUri, {
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000,
      retryWrites: true,
      appName: "sightline-backend",
    });
    await client.connect();
    await client.db(DB_NAME).command({ ping: 1 });
    db = client.db(DB_NAME);
    connectedAt = Date.now();

    await Promise.all([
      db.collection("events").createIndex({ timestampMs: -1 }),
      db.collection("events").createIndex({ sessionId: 1, timestampMs: -1 }),
      db.collection("events").createIndex({ type: 1, timestampMs: -1 }),
      db.collection("objects").createIndex({ canonicalLabel: 1 }),
      db.collection("objects").createIndex({ lastSeenAtMs: -1 }),
      db.collection("objects").createIndex({ descriptors: 1 }),
      db.collection("agent_requests").createIndex({ timestampMs: -1 }),
      db.collection("transcripts").createIndex({ timestampMs: -1 }),
      db.collection("transcripts").createIndex({ direction: 1, timestampMs: -1 }),
    ]);

    console.log(`[db] MongoDB Atlas connected -> ${DB_NAME} @ ${redactUri(config.mongoUri)}`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[db] MongoDB unavailable, continuing in-memory only: ${lastError}`);
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    client = null;
    db = null;
  }

  if (config.tigerDataUri) {
    console.log("[db] TIGER_DATA_URI present (time-series store not wired in this build)");
  }
}

function note(kind: keyof typeof counts, err: unknown): void {
  counts.failures += 1;
  const msg = err instanceof Error ? err.message : String(err);
  lastError = `${kind}: ${msg}`;
  if (counts.failures <= 3) console.warn(`[db] write failed (${kind}): ${msg}`);
}

export function mirrorEvent(event: TimelineEvent): void {
  const coll = events();
  if (!coll) return;
  const ms = Number(event.timestampMs ?? Date.now());
  void coll
    .insertOne({
      _id: event.id,
      correlationId: event.sessionId ?? "unknown",
      timestampMs: ms,
      timestampIso: new Date(ms).toISOString(),
      type: event.type,
      sessionId: event.sessionId ?? null,
      missionId: event.missionId ?? null,
      severity: event.severity ?? "info",
      subjectObjectId: event.subjectObjectId ?? null,
      description: event.description,
      frameRef: event.frameRef ?? null,
      location: event.location ?? null,
      mirroredAt: new Date(),
    })
    .then(() => {
      counts.events += 1;
    })
    .catch((err) => {
      if ((err as { code?: number })?.code === 11000) return;
      note("events", err);
    });
}

const lastObjectMirrorMs = new Map<string, number>();
const OBJECT_MIRROR_THROTTLE_MS = 5000;

/**
 * Upsert an object memory card. The JPEG thumbnail is deliberately NOT sent -
 * it is large, and it is a frame of someone's room.
 */
export function mirrorObject(
  object: MemoryObject,
  opts?: { force?: boolean },
): void {
  if (!db) return;
  const now = Date.now();
  const prev = lastObjectMirrorMs.get(object.id);
  const stateful = object.status !== "observed";
  if (
    !opts?.force &&
    !stateful &&
    prev !== undefined &&
    now - prev < OBJECT_MIRROR_THROTTLE_MS
  ) {
    return;
  }
  lastObjectMirrorMs.set(object.id, now);

  void db
    .collection<ObjectDoc>("objects")
    .updateOne(
      { _id: object.id },
      {
        $set: {
          canonicalLabel: object.canonicalLabel,
          displayName: object.displayName,
          descriptors: object.descriptors,
          lastSeenAtMs: object.lastSeenAtMs,
          lastSeenIso: new Date(object.lastSeenAtMs).toISOString(),
          lastLocation: object.lastLocation ?? null,
          lastBBox: object.lastBBox ?? null,
          lastConfidence: object.lastConfidence,
          sightingCount: object.sightingCount,
          sessionId: object.sessionId,
          status: object.status,
          mirroredAt: new Date(),
        },
        $setOnInsert: {
          firstSeenAtMs: object.firstSeenAtMs,
          firstSeenIso: new Date(object.firstSeenAtMs).toISOString(),
        },
      },
      { upsert: true },
    )
    .then(() => {
      counts.objects += 1;
    })
    .catch((err) => note("objects", err));
}

/** Audit trail for the ANS trust layer: who asked, for what, and the verdict. */
export function mirrorAgentRequest(req: AgentAccessRequest): void {
  if (!db) return;
  void db
    .collection<AgentDoc>("agent_requests")
    .insertOne({
      _id: req.id,
      agentAnsName: req.agentAnsName,
      requestedScopes: req.requestedScopes,
      missionId: req.missionId ?? null,
      verificationStatus: req.verificationStatus,
      decision: req.decision,
      timestampMs: req.timestampMs,
      timestampIso: new Date(req.timestampMs).toISOString(),
      mirroredAt: new Date(),
    })
    .then(() => {
      counts.agents += 1;
    })
    .catch((err) => {
      if ((err as { code?: number })?.code === 11000) return;
      note("agents", err);
    });
}

/**
 * Read the previous session's memory back out of Atlas. This is what makes the
 * database load-bearing rather than decorative: kill the backend mid-demo and
 * the object memory and timeline come back.
 */
export async function loadPersistedState(): Promise<{
  objects: MemoryObject[];
  events: TimelineEvent[];
} | null> {
  if (!db) return null;
  try {
    const [objDocs, evDocs] = await Promise.all([
      db.collection("objects").find({}).sort({ lastSeenAtMs: -1 }).limit(200).toArray(),
      db.collection("events").find({}).sort({ timestampMs: -1 }).limit(200).toArray(),
    ]);

    const objects = objDocs.map((d) => ({
      id: String(d._id),
      canonicalLabel: String(d.canonicalLabel ?? ""),
      displayName: String(d.displayName ?? d.canonicalLabel ?? ""),
      descriptors: Array.isArray(d.descriptors) ? (d.descriptors as string[]) : [],
      firstSeenAtMs: Number(d.firstSeenAtMs ?? d.lastSeenAtMs ?? 0),
      lastSeenAtMs: Number(d.lastSeenAtMs ?? 0),
      lastLocation: (d.lastLocation ?? null) as MemoryObject["lastLocation"],
      lastFrameThumbJpeg: null,
      lastBBox: (d.lastBBox ?? null) as MemoryObject["lastBBox"],
      lastConfidence: Number(d.lastConfidence ?? 0),
      sightingCount: Number(d.sightingCount ?? 1),
      sessionId: String(d.sessionId ?? "restored"),
      status: String(d.status ?? "observed") as MemoryObject["status"],
    })) as MemoryObject[];

    const restoredEvents = evDocs.map((d) => ({
      id: String(d._id),
      type: d.type,
      timestampMs: Number(d.timestampMs ?? 0),
      sessionId: (d.sessionId ?? undefined) as string | undefined,
      missionId: (d.missionId ?? undefined) as string | undefined,
      severity: (d.severity ?? "info") as TimelineEvent["severity"],
      subjectObjectId: (d.subjectObjectId ?? undefined) as string | undefined,
      description: String(d.description ?? ""),
      frameRef: (d.frameRef ?? undefined) as string | undefined,
      location: (d.location ?? null) as TimelineEvent["location"],
    })) as TimelineEvent[];

    restored = { objects: objects.length, events: restoredEvents.length };
    return { objects, events: restoredEvents };
  } catch (err) {
    note("events", err);
    return null;
  }
}


// ==========================================
// Transcripts - everything said and everything asked
// ==========================================

export type TranscriptDirection = "spoken" | "asked" | "heard";

/**
 * Record a line of dialogue. "spoken" is SIGHTLINE talking (the ElevenLabs
 * output), "asked" is a recall question typed into Mission Control, and
 * "heard" is the wearer's own speech transcribed by Scribe. Fire-and-forget
 * like the rest - a transcript write must never delay speech or an answer.
 */
export function mirrorTranscript(entry: {
  direction: TranscriptDirection;
  text: string;
  ok?: boolean;
  hadAudio?: boolean;
  model?: string;
  latencyMs?: number;
  audioBytes?: number;
  sessionId?: string | null;
  context?: string;
  error?: string | null;
  source?: string;
  durationMs?: number;
}): void {
  if (!db) return;
  const now = Date.now();
  void db
    .collection<TranscriptDoc>("transcripts")
    .insertOne({
      direction: entry.direction,
      text: entry.text,
      ok: entry.ok ?? true,
      hadAudio: Boolean(entry.hadAudio),
      model: entry.model ?? null,
      latencyMs: entry.latencyMs ?? null,
      audioBytes: entry.audioBytes ?? 0,
      sessionId: entry.sessionId ?? null,
      context: entry.context ?? null,
      error: entry.error ?? null,
      source: entry.source ?? null,
      durationMs: entry.durationMs ?? null,
      timestampMs: now,
      timestampIso: new Date(now).toISOString(),
    })
    .then(() => {
      counts.transcripts += 1;
    })
    .catch((err) => note("transcripts", err));
}

/** Newest first, which is how the dashboard wants to render them. */
export async function recentTranscripts(
  limit = 50,
  direction?: TranscriptDirection,
): Promise<unknown[]> {
  if (!db) return [];
  try {
    return await db
      .collection("transcripts")
      .find(direction ? { direction } : {})
      .sort({ timestampMs: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    note("transcripts", err);
    return [];
  }
}

// ==========================================
// Recall, served by Atlas
// ==========================================

const RECALL_STOPWORDS = new Set([
  "where","is","my","the","a","an","did","i","leave","find","last","seen","at",
  "of","to","me","was","are","what","which","please","show","recall","locate",
  "for","and","or","in","on","with","you","see","do","have","put","it",
  "who","whos","whose","whats","tell","about","say","said","again","that","this",
]);

function escapeRegex(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recallTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[?.,!'"]/g, " ")
    .split(/\s+/)
    .map((t) => (t === "iphone" || t === "smartphone" ? "phone" : t))
    .map((t) => (t === "macbook" || t === "notebook" ? "laptop" : t))
    .map((t) => (t === "gray" ? "grey" : t))
    .filter((t) => t.length > 1 && !RECALL_STOPWORDS.has(t));
}

export interface AtlasRecallHit {
  id: string;
  matchedTokens: number;
  lastSeenAtMs: number;
}

/**
 * Run the recall search inside Atlas rather than over the in-memory map.
 *
 * Returns ids only, ranked: objects matching more of the query's words first,
 * then most-recently-seen first. The caller resolves each id against the live
 * store so thumbnails (which we deliberately never upload) still appear.
 *
 * Returns null when Atlas is unavailable, which tells the caller to fall back
 * to the local search rather than show the judge an error.
 */
export async function searchObjectsInAtlas(query: string): Promise<AtlasRecallHit[] | null> {
  if (!db) return null;
  const tokens = recallTokens(query);
  try {
    const coll = db.collection("objects");

    // No usable words ("where is it?") -> just the timeline, newest first.
    if (tokens.length === 0) {
      const all = await coll.find({}).sort({ lastSeenAtMs: -1 }).limit(50).toArray();
      return all.map((d) => ({
        id: String(d._id),
        matchedTokens: 0,
        lastSeenAtMs: Number(d.lastSeenAtMs ?? 0),
      }));
    }

    const ors = tokens.flatMap((t) => {
      const rx = { $regex: `\\b${escapeRegex(t)}`, $options: "i" };
      return [
        { displayName: rx },
        { canonicalLabel: rx },
        { descriptors: rx },
      ];
    });

    const docs = await coll
      .find({ $or: ors })
      .sort({ lastSeenAtMs: -1 })
      .limit(60)
      .toArray();

    const hits = docs.map((d) => {
      const hay = [
        String(d.displayName ?? ""),
        String(d.canonicalLabel ?? ""),
        ...(Array.isArray(d.descriptors) ? (d.descriptors as string[]) : []),
      ]
        .join(" ")
        .toLowerCase();
      return {
        id: String(d._id),
        matchedTokens: tokens.filter((t) => new RegExp(`\\b${escapeRegex(t)}`, "i").test(hay))
          .length,
        lastSeenAtMs: Number(d.lastSeenAtMs ?? 0),
      };
    });

    // Prefer cards matching every word; among equals, most recent first.
    const complete = hits.filter((h) => h.matchedTokens === tokens.length);
    const pool = complete.length > 0 ? complete : hits;
    pool.sort((a, b) => b.matchedTokens - a.matchedTokens || b.lastSeenAtMs - a.lastSeenAtMs);
    return pool;
  } catch (err) {
    note("events", err);
    return null;
  }
}

export interface TranscriptHit {
  id: string;
  text: string;
  timestampMs: number;
  source: string | null;
  direction: string;
  matchedTokens: number;
}

/**
 * Search what the wearer actually SAID.
 *
 * Object recall only covers things the camera saw. A spoken fact - "my name is
 * Bob" - lives in the transcripts collection and was previously unreachable
 * from recall, so asking "who is Bob?" found nothing. This closes that gap.
 */
export async function searchTranscriptsInAtlas(
  query: string,
  limit = 12,
): Promise<TranscriptHit[] | null> {
  if (!db) return null;
  const tokens = recallTokens(query);
  // Conversational / people queries: pull recent heard lines for Gemini / broad match.
  const peopleQuery = isPeopleTranscriptQuery(query);
  try {
    let docs: Array<Record<string, unknown>> = [];
    if (peopleQuery || tokens.length === 0) {
      docs = await db
        .collection("transcripts")
        .find({ direction: "heard" })
        .sort({ timestampMs: -1 })
        .limit(80)
        .toArray();
    } else {
      const ors = tokens.map((t) => ({
        text: { $regex: `\\b${escapeRegex(t)}`, $options: "i" },
      }));
      docs = await db
        .collection("transcripts")
        .find({ direction: "heard", $or: ors })
        .sort({ timestampMs: -1 })
        .limit(40)
        .toArray();
    }

    const hits = docs.map((d) => {
      const text = String(d.text ?? "");
      return {
        id: String(d._id),
        text,
        timestampMs: Number(d.timestampMs ?? 0),
        source: (d.source as string) ?? null,
        direction: String(d.direction ?? "heard"),
        matchedTokens:
          tokens.length === 0
            ? 1
            : tokens.filter((t) => new RegExp(`\\b${escapeRegex(t)}`, "i").test(text)).length,
      };
    });
    if (!peopleQuery) {
      hits.sort((a, b) => b.matchedTokens - a.matchedTokens || b.timestampMs - a.timestampMs);
      return hits.filter((h) => h.matchedTokens > 0).slice(0, limit);
    }
    return hits.slice(0, limit);
  } catch (err) {
    note("transcripts", err);
    return [];
  }
}

/** Recent heard lines for "who did I meet?" style Gemini extraction. */
export async function recentHeardTranscripts(limit = 60): Promise<TranscriptHit[]> {
  if (!db) return [];
  try {
    const docs = await db
      .collection("transcripts")
      .find({ direction: "heard" })
      .sort({ timestampMs: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({
      id: String(d._id),
      text: String(d.text ?? ""),
      timestampMs: Number(d.timestampMs ?? 0),
      source: (d.source as string) ?? null,
      direction: String(d.direction ?? "heard"),
      matchedTokens: 1,
    }));
  } catch (err) {
    note("transcripts", err);
    return [];
  }
}

export function isPeopleTranscriptQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\bwho\b/.test(q) ||
    /\b(met|meet|meeting|introduce|introduced|name is|named|called)\b/.test(q) ||
    /\b(conversation|said|talked|spoke)\b/.test(q)
  );
}

/** Live status for /api/health, so the dashboard can show the store is real. */
export function mongoStatus() {
  return {
    enabled: Boolean(config.mongoUri),
    connected: db !== null,
    database: db ? DB_NAME : null,
    cluster: config.mongoUri ? redactUri(config.mongoUri) : null,
    connectedAt,
    written: { ...counts },
    restored: { ...restored },
    lastError,
  };
}

/** Read the timeline back out of Atlas (proves the round-trip, not just the write). */
export async function recentPersistedEvents(limit = 25): Promise<unknown[]> {
  const coll = events();
  if (!coll) return [];
  try {
    return await coll.find({}).sort({ timestampMs: -1 }).limit(limit).toArray();
  } catch (err) {
    note("events", err);
    return [];
  }
}

export async function closeDatabases(): Promise<void> {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  client = null;
  db = null;
}