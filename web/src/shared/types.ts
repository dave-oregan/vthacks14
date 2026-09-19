export type MediaSource = "rayban" | "iphone" | "rayban_bluetooth" | "system_default" | "none" | string;

export interface GeoPoint {
  latitude: number;
  longitude: number;
  altitudeMeters?: number | null;
  horizontalAccuracyMeters?: number | null;
  timestampMs: number;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Detection {
  trackId: string;
  label: string;
  displayName: string;
  descriptors: string[];
  confidence: number;
  bbox: BBox;
  source: "coco" | "gemini" | "locateanything" | "manual";
}

export interface Observation {
  id: string;
  sessionId: string;
  timestampMs: number;
  frameRef: string;
  source: MediaSource;
  location?: GeoPoint | null;
  detections: Detection[];
}

export interface MemoryObject {
  id: string;
  canonicalLabel: string;
  displayName: string;
  descriptors: string[];
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastLocation?: GeoPoint | null;
  lastFrameThumbJpeg?: Buffer | null;
  lastBBox?: BBox | null;
  lastConfidence: number;
  sightingCount: number;
  sessionId: string;
  status: "observed" | "placed" | "left_behind" | "recalled";
}

export interface TimelineEvent {
  id: string;
  type:
    | "object_seen"
    | "object_last_seen"
    | "left_behind"
    | "recalled"
    | "agent_verified"
    | "agent_blocked"
    | "stream_event"
    | "possible_emergency"
    | "mission_started"
    | "alerted";
  timestampMs: number;
  sessionId?: string;
  missionId?: string;
  severity?: "info" | "warn" | "critical";
  subjectObjectId?: string;
  description: string;
  frameRef?: string;
  location?: GeoPoint | null;
}

export interface Mission {
  id: string;
  type: "track" | "memory" | "guardian_sim";
  status: "active" | "triggered" | "completed" | "cancelled";
  targetObjectId?: string;
  targetLabel?: string;
  targetDescriptors: string[];
  createdAtMs: number;
  triggerConfig: {
    leaveBehindMeters: number;
    absentMs: number;
  };
}

export interface AgentAccessRequest {
  id: string;
  agentAnsName: string;
  requestedScopes: string[];
  missionId?: string;
  verificationStatus: "verifying" | "verified" | "blocked";
  decision: "allow" | "deny" | "pending";
  timestampMs: number;
}

export interface SessionSnapshot {
  sessionId: string;
  connected: boolean;
  protocolVersion: number;
  app?: { name: string; version: string; build: string };
  platform?: { os: string; osVersion: string };
  capabilities?: Record<string, boolean>;
  activeSources?: Record<string, string>;
  lastLocation?: GeoPoint | null;
  lastMotionAtMs?: number;
  videoStats: {
    framesReceived: number;
    framesVisioned: number;
    lastVideoSource?: string;
  };
  audioChunks: number;
  updatedAtMs: number;
}

export interface DashboardState {
  live: boolean;
  session: SessionSnapshot | null;
  latestFrameJpegBase64: string | null;
  latestDetections: Detection[];
  objects: MemoryObject[];
  events: TimelineEvent[];
  missions: Mission[];
  agents: Array<{
    id: string;
    name: string;
    ans: string;
    state: "IDENTITY VERIFIED" | "STANDBY" | "BLOCKED" | "VERIFYING…";
  }>;
  lastAccessRequest: AgentAccessRequest | null;
  mode: string;
  transcriptSnippet: string;
}
