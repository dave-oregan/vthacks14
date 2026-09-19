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
        if (msg.type === "state" || msg.type === "frame") {
          if (msg.type === "state") setState(msg.payload as DashState);
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

  async function track(target: string) {
    await fetch("/api/missions/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
  }

  async function recall(query: string) {
    await fetch("/api/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
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

  async function resetDemo() {
    await fetch("/api/demo/reset", { method: "POST" });
  }

  return { state, connected, track, recall, verifyAgent, simulateUnknown, resetDemo };
}
