import { useMemo, useState } from "react";
import { useSightline, type RecallMatch } from "./hooks/useSightline";
import { useBrowserVision } from "./hooks/useBrowserVision";
import { LivePOV } from "./components/LivePOV";
import { MemoryPanel } from "./components/MemoryPanel";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";
import { LinkPanel } from "./components/LinkPanel";
import { RecallPicker } from "./components/RecallPicker";

export function App() {
  const { state, connected, recall, selectRecall, verifyAgent, simulateUnknown, resetDemo } =
    useSightline();
  const [query, setQuery] = useState("Where is my black laptop?");
  const [busy, setBusy] = useState<string | null>(null);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ query: string; matches: RecallMatch[] } | null>(null);

  const { detections: browserDets, ready: visionReady, status: visionStatus } = useBrowserVision(
    state?.latestFrameJpegBase64 ?? null,
    { enabled: true, report: true },
  );

  const overlayDetections = (() => {
    const server = state?.latestDetections ?? [];
    if (!visionReady) return server;
    return browserDets.map((d) => {
      const match = server.find(
        (s) =>
          s.label === d.label &&
          Math.abs(s.bbox.x - d.bbox.x) < 0.12 &&
          Math.abs(s.bbox.y - d.bbox.y) < 0.12,
      );
      return match && match.displayName && match.displayName !== match.label
        ? { ...d, displayName: match.displayName, descriptors: match.descriptors }
        : d;
    });
  })();

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

  async function doRecall() {
    const result = await recall(query);
    if (result.needsChoice && result.matches.length > 1) {
      setPicker({ query: result.query || query, matches: result.matches });
      setRecallNote(result.text);
      return;
    }
    if (result.matches[0]?.mapsUrl) {
      window.open(result.matches[0].mapsUrl, "_blank", "noopener,noreferrer");
    }
    setRecallNote(result.text);
    setPicker(null);
  }

  async function onPickMatch(m: RecallMatch) {
    await selectRecall(m.id);
    if (m.mapsUrl) {
      window.open(m.mapsUrl, "_blank", "noopener,noreferrer");
    }
    setRecallNote(
      m.latitude != null && m.longitude != null
        ? `${m.phrase} → ${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`
        : `${m.phrase} (no GPS yet)`,
    );
    setPicker(null);
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
          <div className="pill">Memory {state?.objects.length ?? 0}</div>
          <button className="btn danger" onClick={() => run("reset", resetDemo)} disabled={!!busy}>
            Demo Reset
          </button>
        </div>
      </header>

      <div className="main">
        <section className="panel pov-panel">
          <div className="panel-title">Live POV · browser COCO-SSD</div>
          <LivePOV
            jpegBase64={state?.latestFrameJpegBase64 ?? null}
            detections={overlayDetections}
            source={state?.session?.videoStats?.lastVideoSource}
            visionStatus={visionStatus}
          />
          <div className="actions">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run("recall", doRecall);
              }}
              placeholder="Where is my black laptop? / recall laptop"
            />
            <button
              className="btn primary"
              onClick={() => run("recall", doRecall)}
              disabled={!!busy}
            >
              Recall
            </button>
          </div>
          {recallNote && (
            <div className="stack" style={{ paddingTop: 0, borderTop: "1px solid var(--line)" }}>
              <div className="row">
                <span className="k">Recall</span>
                <span className="v" style={{ textAlign: "left", whiteSpace: "normal" }}>
                  {recallNote}
                </span>
              </div>
            </div>
          )}
        </section>

        <aside className="side">
          <LinkPanel linked={Boolean(state?.session?.connected)} />

          <section className="panel">
            <div className="panel-title">Vision</div>
            <div className="scroll">
              {overlayDetections.length === 0 && (
                <div className="det-item">
                  No detections yet — point camera at a phone, laptop, backpack…
                </div>
              )}
              {overlayDetections.map((d) => (
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

      {picker && (
        <RecallPicker
          query={picker.query}
          matches={picker.matches}
          onPick={(m) => void run("pick", () => onPickMatch(m))}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
