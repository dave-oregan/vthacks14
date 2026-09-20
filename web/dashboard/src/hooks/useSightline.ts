import { useEffect, useRef, useState } from "react";

export type DashState = {
  live: boolean;
  mode: string;
  transcriptSnippet: string;
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
    policeBackup?: boolean;
  } | null;
  locateAnything?: {
    configured: boolean;
    ok: boolean;
    checkedAtMs: number;
    latencyMs: number | null;
    detail?: string;
  };
  policeMode?: boolean;
  cocoFallback?: boolean;
  sideAlerts?: SideAlert[];
  policeStatus?: {
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
  };
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

export type SideAlert = {
  id: string;
  kind: "danger_weapon" | "plate_capture" | "backup_recommend" | "officer_down" | "info";
  severity: "info" | "warn" | "critical";
  title: string;
  message: string;
  timestampMs: number;
  ttlMs: number | null;
  thumbBase64?: string | null;
  label?: string;
  location?: { latitude: number; longitude: number } | null;
};

export type RecallMatch = {
  id: string;
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
};

export type RecallResult = {
  text: string;
  query: string;
  needsChoice: boolean;
  objectId?: string;
  matches: RecallMatch[];
  voice?: unknown;
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

  async function selectRecall(objectId: string) {
    const res = await fetch("/api/recall/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectId }),
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

  async function setPoliceMode(enabled: boolean) {
    setState((prev) => (prev ? { ...prev, policeMode: enabled, sideAlerts: enabled ? prev.sideAlerts ?? [] : [] } : prev));
    const res = await fetch("/api/mode/police", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = (await res.json()) as { policeMode?: boolean };
    setState((prev) =>
      prev ? { ...prev, policeMode: Boolean(data.policeMode ?? enabled) } : prev,
    );
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

  async function setBackupThreshold(threshold: number) {
    setState((prev) =>
      prev?.policeStatus
        ? {
            ...prev,
            policeStatus: { ...prev.policeStatus, backupThreshold: threshold },
          }
        : prev,
    );
    const res = await fetch("/api/mode/backup-threshold", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold }),
    });
    const data = (await res.json()) as {
      backupThreshold?: number;
      policeStatus?: DashState["policeStatus"];
    };
    setState((prev) =>
      prev
        ? {
            ...prev,
            policeStatus: data.policeStatus ?? {
              dangerLevel: prev.policeStatus?.dangerLevel ?? 0,
              dangerLabel: prev.policeStatus?.dangerLabel ?? "Clear",
              topThreat: prev.policeStatus?.topThreat ?? null,
              topConfidence: prev.policeStatus?.topConfidence ?? 0,
              backupThreshold: data.backupThreshold ?? threshold,
              backupArmed: prev.policeStatus?.backupArmed ?? false,
            },
          }
        : prev,
    );
  }

  async function dismissSideAlert(id: string) {
    let wasDown = false;
    setState((prev) => {
      if (!prev) return prev;
      wasDown = (prev.sideAlerts ?? []).some((a) => a.id === id && a.kind === "officer_down");
      return {
        ...prev,
        sideAlerts: (prev.sideAlerts ?? []).filter((a) => a.id !== id),
        ...(wasDown
          ? {
              emergencyAlert: null,
              mode: prev.mode === "EMERGENCY" ? "LIVE" : prev.mode,
            }
          : {}),
      };
    });
    await fetch("/api/alerts/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (wasDown) {
      await fetch("/api/emergency/dismiss", { method: "POST" });
    }
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
    setPoliceMode,
    setCocoFallback,
    setBackupThreshold,
    dismissSideAlert,
  };
}
