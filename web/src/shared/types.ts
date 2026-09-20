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

export interface EmergencyAlert {
  active: boolean;
  demo: true;
  triggeredAtMs: number;
  peakImpactG: number;
  freefallMs: number;
  reason: string;
  message: string;
  location?: GeoPoint | null;
  /** When true, fall is treated as possible responder distress (Guardian Mode). */
  guardianDistress?: boolean;
  /** @deprecated Use guardianDistress */
  policeBackup?: boolean;
}

export type GuardianEventCategory =
  | "safety_resource"
  | "hazard"
  | "medical"
  | "potential_threat"
  | "vehicle"
  | "location"
  | "distress"
  | "environment"
  | "system";

export type GuardianEventSeverity = "info" | "low" | "medium" | "high" | "critical";

export type GuardianEventSource =
  | "vision"
  | "audio"
  | "motion"
  | "location"
  | "multimodal"
  | "manual";

export type GuardianEventStatus = "new" | "confirmed" | "dismissed" | "resolved";

/** Structured observation for Guardian Mode — never encodes person guilt/intent. */
export interface GuardianEvent {
  id: string;
  timestamp: number;
  category: GuardianEventCategory;
  type: string;
  title: string;
  description: string;
  confidence?: number;
  severity: GuardianEventSeverity;
  source: GuardianEventSource;
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    humanReadable?: string;
  };
  videoTimestamp?: number;
  frameReference?: string;
  clipReference?: string;
  metadata?: Record<string, unknown>;
  status: GuardianEventStatus;
  requiresReview?: boolean;
}

export interface GuardianStatus {
  highPriority: number;
  informational: number;
  groupCount: number;
  largeGroup: boolean;
  eventCount: number;
  sensors: {
    camera: boolean;
    location: boolean;
    motion: boolean;
    audio: boolean;
  };
}

/** @deprecated Compatibility alias — prefer GuardianEvent */
export type SideAlertKind =
  | "danger_weapon"
  | "plate_capture"
  | "backup_recommend"
  | "officer_down"
  | "info";

/** @deprecated Prefer GuardianEvent cards in the UI */
export interface SideAlert {
  id: string;
  kind: SideAlertKind;
  severity: "info" | "warn" | "critical";
  title: string;
  message: string;
  timestampMs: number;
  ttlMs: number | null;
  thumbBase64?: string | null;
  label?: string;
  location?: GeoPoint | null;
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
  emergencyAlert: EmergencyAlert | null;
  locateAnything: {
    configured: boolean;
    ok: boolean;
    checkedAtMs: number;
    latencyMs: number | null;
    detail?: string;
  };
  guardianMode: boolean;
  /** @deprecated Alias of guardianMode for older clients */
  policeMode: boolean;
  cocoFallback: boolean;
  guardianEvents: GuardianEvent[];
  guardianStatus: GuardianStatus;
  /** @deprecated Prefer guardianEvents */
  sideAlerts: SideAlert[];
  /** @deprecated Prefer guardianStatus — no danger/hostility meters */
  policeStatus: {
    dangerLevel: number;
    dangerLabel: string;
    topThreat: string | null;
    topConfidence: number;
    backupThreshold: number;
    backupArmed: boolean;
    groupCount: number;
    largeGroup: boolean;
    hostility: number;
    hostilityLabel: string;
    dangerTicks: number;
  };
}
