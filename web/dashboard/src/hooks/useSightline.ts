import { useEffect, useRef, useState } from "react";
import { playVoice, type VoicePayload } from "../voice/voicePlayer";

export type DashState = {
  live: boolean;
  mode: string;
  transcriptSnippet: string;
  recentTranscripts?: Array<{
    id: string;
    direction: "heard" | "asked" | "spoken";
    text: string;
    timestampMs: number;
    source?: string | null;
  }>;
  latestFrameJpegBase64: string | null;
  latestDetections: Array<{
    trackId: string;
    label: string;
    displayName: string;
    descriptors: string[];
    confidence: number;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
  objects: Array<{
    id: string;
    canonicalLabel: string;
    displayName?: string;
    descriptors: string[];
    lastSeenAtMs: number;
    lastLocation?: { latitude: number; longitude: number } | null;
    lastConfidence: number;
    sightingCount: number;
    status: string;
    thumbBase64?: string | null;
  }>;
  events: Array<{
    id: string;
    type: string;
    timestampMs: number;
    description: string;
  }>;
  missions: Array<{ id: string; status: string; targetLabel?: string }>;
  agents: Array<{ id: string; name: string; ans: string; state: string }>;
  lastAccessRequest: {
    agentAnsName: string;
    verificationStatus: string;
    decision: string;
    requestedScopes: string[];
  } | null;
  emergencyAlert?: {
    active: boolean;
    demo: true;
    triggeredAtMs: number;
    peakImpactG: number;
    freefallMs: number;
    reason: string;
    message: string;
    location?: { latitude: number; longitude: number } | null;
    guardianDistress?: boolean;
    policeBackup?: boolean;
  } | null;
  locateAnything?: {
    configured: boolean;
    ok: boolean;
    checkedAtMs: number;
    latencyMs: number | null;
    detail?: string;
  };
  guardianMode?: boolean;
  /** @deprecated */
  policeMode?: boolean;
  cocoFallback?: boolean;
  guardianEvents?: GuardianEvent[];
  guardianStatus?: GuardianStatus;
  session: {
    connected: boolean;
    sessionId: string;
    activeSources?: Record<string, string>;
    lastLocation?: { latitude: number; longitude: number } | null;
    videoStats?: {
      framesReceived: number;
      framesVisioned: number;
      lastVideoSource?: string;
    };
  } | null;
};

export type GuardianEvent = {
  id: string;
  timestamp: number;
  category:
    | "safety_resource"
    | "hazard"
    | "medical"
    | "potential_threat"
    | "vehicle"
    | "location"
    | "distress"
    | "environment"
    | "system";
  type: string;
  title: string;
  description: string;
  confidence?: number;
  severity: "info" | "low" | "medium" | "high" | "critical";
  source: string;
  location?: { latitude: number; longitude: number; accuracy?: number | null };
  frameReference?: string;
  metadata?: Record<string, unknown>;
  status: "new" | "confirmed" | "dismissed" | "resolved";
  requiresReview?: boolean;
};

export type GuardianStatus = {
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
};

export type RecallMatch = {
  id: string;
  kind?: "object" | "transcript";
  phrase: string;
  label: string;
  descriptors: string[];
  lastSeenAtMs: number;
  lastSeenLabel: string;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  thumbBase64: string | null;
  sightingCount: number;
  status: string;
  transcriptText?: string;
  transcriptSource?: string | null;
};

export type RecallResult = {
  text: string;
  query: string;
  needsChoice: boolean;
  objectId?: string;
  matches: RecallMatch[];
  voice?: VoicePayload;
};

export function useSightline() {
  const [state, setState] = useState<DashState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; payload: unknown };
        if (msg.type === "voice") {
          // The backend generates this with ElevenLabs. Until now nothing
          // caught it here, so SIGHTLINE never actually made a sound.
          playVoice(msg.payload as VoicePayload);
          return;
        }
        if (msg.type === "state" || msg.type === "frame" || msg.type === "emergency") {
          if (msg.type === "state") setState(msg.payload as DashState);
          if (msg.type === "emergency") {
            const alert = msg.payload as DashState["emergencyAlert"] | null;
            setState((prev) =>
              prev
                ? {
                    ...prev,
                    emergencyAlert: alert,
                    mode: alert?.active ? "EMERGENCY" : prev.mode === "EMERGENCY" ? "LIVE" : prev.mode,
                  }
                : prev,
            );
          }
          if (msg.type === "frame") {
            const frame = msg.payload as {
              jpegBase64: string | null;
              detections: DashState["latestDetections"];
              session: DashState["session"];
            };
            setState((prev) =>
              prev
                ? {
                    ...prev,
                    latestFrameJpegBase64: frame.jpegBase64,
                    latestDetections: frame.detections ?? prev.latestDetections,
                    session: frame.session ?? prev.session,
                    live: Boolean(frame.session?.connected ?? prev.live),
                  }
                : {
                    live: Boolean(frame.session?.connected),
                    mode: "LIVE",
                    transcriptSnippet: "",
                    latestFrameJpegBase64: frame.jpegBase64,
                    latestDetections: frame.detections ?? [],
                    objects: [],
                    events: [],
                    missions: [],
                    agents: [],
                    lastAccessRequest: null,
                    session: frame.session,
                  },
            );
          }
        }
      } catch {
        /* ignore */
      }
    };

    fetch("/api/state")
      .then((r) => r.json())
      .then((s) => setState(s))
      .catch(() => undefined);

    return () => ws.close();
  }, []);

  async function recall(query: string): Promise<RecallResult> {
    const res = await fetch("/api/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    return (await res.json()) as RecallResult;
  }

  async function selectRecall(match: RecallMatch | string) {
    const m = typeof match === "string" ? { id: match, kind: "object" as const } : match;
    const res = await fetch("/api/recall/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectId: m.id,
        kind: m.kind ?? "object",
        transcriptText: "transcriptText" in m ? m.transcriptText : undefined,
      }),
    });
    return res.json() as Promise<{
      ok: boolean;
      text?: string;
      match?: RecallMatch;
    }>;
  }

  async function verifyAgent(agentAnsName: string, scopes: string[]) {
    await fetch("/api/ans/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentAnsName, scopes }),
    });
  }

  async function simulateUnknown() {
    await fetch("/api/ans/simulate-unknown", { method: "POST" });
  }

  async function simulateFall() {
    const res = await fetch("/api/demo/fall", { method: "POST" });
    const data = (await res.json()) as { alert?: DashState["emergencyAlert"] };
    if (data.alert) {
      setState((prev) => {
        if (!prev) return prev;
        const loc =
          data.alert?.location ??
          prev.session?.lastLocation ??
          null;
        const alert = data.alert
          ? {
              ...data.alert,
              location: loc,
            }
          : null;
        return { ...prev, emergencyAlert: alert, mode: "EMERGENCY" };
      });
    }
  }

  async function dismissEmergency() {
    await fetch("/api/emergency/dismiss", { method: "POST" });
    setState((prev) =>
      prev
        ? {
            ...prev,
            emergencyAlert: null,
            mode: prev.mode === "EMERGENCY" ? "LIVE" : prev.mode,
          }
        : prev,
    );
  }

  async function resetDemo() {
    await fetch("/api/demo/reset", { method: "POST" });
  }

  async function setGuardianMode(enabled: boolean) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            guardianMode: enabled,
            policeMode: enabled,
            guardianEvents: enabled ? prev.guardianEvents ?? [] : [],
          }
        : prev,
    );
    const res = await fetch("/api/mode/guardian", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = (await res.json()) as { guardianMode?: boolean; policeMode?: boolean };
    const on = Boolean(data.guardianMode ?? data.policeMode ?? enabled);
    setState((prev) => (prev ? { ...prev, guardianMode: on, policeMode: on } : prev));
  }

  async function setCocoFallback(enabled: boolean) {
    setState((prev) => (prev ? { ...prev, cocoFallback: enabled } : prev));
    const res = await fetch("/api/mode/coco-fallback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = (await res.json()) as { cocoFallback?: boolean };
    setState((prev) =>
      prev ? { ...prev, cocoFallback: Boolean(data.cocoFallback ?? enabled) } : prev,
    );
  }

  async function dismissGuardianEvent(id: string) {
    let wasDistress = false;
    setState((prev) => {
      if (!prev) return prev;
      wasDistress = (prev.guardianEvents ?? []).some(
        (e) => e.id === id && e.category === "distress",
      );
      return {
        ...prev,
        guardianEvents: (prev.guardianEvents ?? []).filter((e) => e.id !== id),
        ...(wasDistress
          ? {
              emergencyAlert: null,
              mode: prev.mode === "EMERGENCY" ? "LIVE" : prev.mode,
            }
          : {}),
      };
    });
    await fetch("/api/guardian/events/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (wasDistress) {
      await fetch("/api/emergency/dismiss", { method: "POST" });
    }
  }

  async function confirmGuardianEvent(id: string) {
    await fetch("/api/guardian/events/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  async function queryGuardianMemory(query: string) {
    const res = await fetch("/api/guardian/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    return (await res.json()) as { text: string; matches: GuardianEvent[] };
  }

  async function injectGuardianDemo(scenario: string) {
    const res = await fetch(`/api/guardian/demo/${encodeURIComponent(scenario)}`, {
      method: "POST",
    });
    const data = (await res.json()) as {
      ok?: boolean;
      guardianEvents?: GuardianEvent[];
      event?: GuardianEvent;
    };
    if (data.guardianEvents) {
      setState((prev) =>
        prev
          ? {
              ...prev,
              guardianMode: true,
              policeMode: true,
              guardianEvents: data.guardianEvents,
            }
          : prev,
      );
    }
    return data;
  }

  return {
    state,
    connected,
    recall,
    selectRecall,
    verifyAgent,
    simulateUnknown,
    simulateFall,
    dismissEmergency,
    resetDemo,
    setGuardianMode,
    setCocoFallback,
    dismissGuardianEvent,
    confirmGuardianEvent,
    queryGuardianMemory,
    injectGuardianDemo,
  };
}
