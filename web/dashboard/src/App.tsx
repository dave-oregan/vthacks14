import { useMemo, useState } from "react";
import { useSightline } from "./hooks/useSightline";
import { LivePOV } from "./components/LivePOV";
import { MemoryPanel } from "./components/MemoryPanel";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";
import { LinkPanel } from "./components/LinkPanel";

export function App() {
  const { state, connected, track, recall, verifyAgent, simulateUnknown, resetDemo } =
    useSightline();
  const [query, setQuery] = useState("Where is my phone?");
  const [trackTarget, setTrackTarget] = useState("phone");
  const [busy, setBusy] = useState<string | null>(null);

  const linkStatus = useMemo(() => {
    if (!state?.session?.connected) return { label: "LINK DOWN", tone: "warn" as const };
    return { label: "LINKED", tone: "ok" as const };
  }, [state?.session?.connected]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>SIGHTLINE</h1>
          <span>Mission Control · scan QR to link iPhone</span>
        </div>
        <div className="header-meta">
          <div className="pill">
            <span className={`dot ${state?.live ? "live" : ""}`} />
            {state?.live ? "LIVE" : "IDLE"}
          </div>
          <div className="pill">
            <span className={`dot ${linkStatus.tone}`} />
            {linkStatus.label}
          </div>
          <div className="pill">UI {connected ? "WS OK" : "WS…"}</div>
          <div className="pill">{state?.mode ?? "STANDBY"}</div>
          <div className="pill">
            Missions {state?.missions.filter((m) => m.status === "active").length ?? 0}
          </div>
          <button className="btn danger" onClick={() => run("reset", resetDemo)} disabled={!!busy}>
            Demo Reset
          </button>
        </div>
      </header>

      <div className="main">
        <section className="panel pov-panel">
          <div className="panel-title">Live POV · detections</div>
          <LivePOV
            jpegBase64={state?.latestFrameJpegBase64 ?? null}
            detections={state?.latestDetections ?? []}
            source={state?.session?.videoStats?.lastVideoSource}
          />
          <div className="actions">
            <input
              type="text"
              value={trackTarget}
              onChange={(e) => setTrackTarget(e.target.value)}
              placeholder="track target (phone, backpack…)"
            />
            <button
              className="btn primary"
              onClick={() => run("track", () => track(trackTarget))}
              disabled={!!busy}
            >
              Start Track Mission
            </button>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Where did I leave my black case phone?"
            />
            <button className="btn" onClick={() => run("recall", () => recall(query))} disabled={!!busy}>
              Recall
            </button>
          </div>
        </section>

        <aside className="side">
          <LinkPanel linked={Boolean(state?.session?.connected)} />

          <section className="panel">
            <div className="panel-title">Vision</div>
            <div className="scroll">
              {(state?.latestDetections ?? []).length === 0 && (
                <div className="det-item">
                  No detections yet — point camera at a phone, laptop, backpack…
                </div>
              )}
              {(state?.latestDetections ?? []).map((d) => (
                <div className="det-item" key={d.trackId}>
                  <div className="row">
                    <span className="k">{d.displayName}</span>
                    <span className="v">{Math.round(d.confidence * 100)}%</span>
                  </div>
                  <div className="row">
                    <span className="k">descriptors</span>
                    <span className="v">{d.descriptors.join(", ")}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <MemoryPanel objects={state?.objects ?? []} />

          <section className="panel">
            <div className="panel-title">Context</div>
            <div className="stack">
              <div className="row">
                <span className="k">Location</span>
                <span className="v">
                  {state?.session?.lastLocation
                    ? `${state.session.lastLocation.latitude.toFixed(5)}, ${state.session.lastLocation.longitude.toFixed(5)}`
                    : "—"}
                </span>
              </div>
              <div className="row">
                <span className="k">Video source</span>
                <span className="v">
                  {state?.session?.activeSources?.video ??
                    state?.session?.videoStats?.lastVideoSource ??
                    "—"}
                </span>
              </div>
              <div className="row">
                <span className="k">Frames / vision</span>
                <span className="v">
                  {state?.session?.videoStats?.framesReceived ?? 0} /{" "}
                  {state?.session?.videoStats?.framesVisioned ?? 0}
                </span>
              </div>
              <div className="row">
                <span className="k">Transcript</span>
                <span className="v">{state?.transcriptSnippet || "—"}</span>
              </div>
            </div>
          </section>

          <AgentPanel
            agents={state?.agents ?? []}
            lastRequest={state?.lastAccessRequest ?? null}
            onVerify={(ans) => run("ans", () => verifyAgent(ans, ["location", "memory.read"]))}
            onBlockUnknown={() => run("rogue", simulateUnknown)}
          />
        </aside>
      </div>

      <Timeline events={state?.events ?? []} />
    </div>
  );
}
