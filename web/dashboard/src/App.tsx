import { useMemo, useState, useEffect } from "react";
import { useSightline, type RecallMatch } from "./hooks/useSightline";
import { useBrowserVision } from "./hooks/useBrowserVision";
import { LivePOV } from "./components/LivePOV";
import { MemoryPanel } from "./components/MemoryPanel";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";
import { LinkPanel } from "./components/LinkPanel";
import { RecallPicker } from "./components/RecallPicker";
import { EmergencyModal } from "./components/EmergencyModal";
import { GuardianEventStack } from "./components/GuardianEventStack";
import { TranscriptViewer } from "./components/TranscriptViewer";
import { VoiceIndicator } from "./components/VoiceIndicator";
import { unlockAudio } from "./voice/voicePlayer";

export function App() {
  const {
    state,
    connected,
    recall,
    selectRecall,
    verifyAgent,
    simulateUnknown,
    simulateFall,
    simulateCrash,
    dismissEmergency,
    resetDemo,
    setGuardianMode,
    dismissGuardianEvent,
    confirmGuardianEvent,
    queryGuardianMemory,
    injectGuardianDemo,
  } = useSightline();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [theme]);

  const [query, setQuery] = useState("Where is my black laptop?");
  const [guardianQuery, setGuardianQuery] = useState("Where was the last AED?");
  const [busy, setBusy] = useState<string | null>(null);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const [guardianNote, setGuardianNote] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ query: string; matches: RecallMatch[] } | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const guardianMode = Boolean(state?.guardianMode ?? state?.policeMode);
  const gStatus = state?.guardianStatus;

  const { detections: browserDets, ready: visionReady, status: visionStatus } = useBrowserVision(
    state?.latestFrameJpegBase64 ?? null,
    { enabled: true, report: true },
  );

  const overlayDetections = useMemo(() => {
    const server = state?.latestDetections ?? [];

    if (!guardianMode) {
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
    }

    // Guardian POV: people + safety-relevant classes (observations, not judgments).
    const fromBrowser = browserDets.filter((d) =>
      /\b(person|people|crowd)\b/i.test(`${d.label} ${d.displayName ?? ""}`),
    );
    const observeRe =
      /\b(gun|handgun|pistol|rifle|firearm|weapon|knife|blade|machete|fist|fight|punch|license\s*plate|number\s*plate|plate|aed|extinguisher|smoke|fire|exit|stairwell|elevator)\b/i;
    const fromServer = server.filter((d) =>
      observeRe.test(`${d.label} ${d.displayName ?? ""}`),
    );
    const merged = [...fromBrowser];
    for (const s of fromServer) {
      const dup = merged.some(
        (b) =>
          Math.abs(b.bbox.x - s.bbox.x) < 0.12 &&
          Math.abs(b.bbox.y - s.bbox.y) < 0.12 &&
          Math.abs(b.bbox.width - s.bbox.width) < 0.18,
      );
      if (!dup) merged.push(s);
    }
    return merged;
  }, [browserDets, state?.latestDetections, visionReady, guardianMode]);

  const linkStatus = useMemo(() => {
    if (!state?.session?.connected) return { label: "LINK DOWN", tone: "warn" as const };
    return { label: "LINKED", tone: "ok" as const };
  }, [state?.session?.connected]);

  const lasStatus = useMemo(() => {
    const la = state?.locateAnything;
    if (!la?.configured) return { label: "LAs OFF", tone: "" as const, title: "LocateAnything URL not set" };
    if (la.ok) {
      const ms = la.latencyMs != null ? ` · ${la.latencyMs}ms` : "";
      return {
        label: "LAs OK",
        tone: "ok" as const,
        title: `LocateAnything reachable${ms}`,
      };
    }
    return {
      label: "LAs DOWN",
      tone: "warn" as const,
      title: la.detail ? `LocateAnything: ${la.detail}` : "LocateAnything unreachable",
    };
  }, [state?.locateAnything]);

  async function run(name: string, fn: () => Promise<unknown>) {
    // Unlock browser audio inside the click stack so TTS that arrives later can play.
    if (name === "fall" || name === "crash" || name === "recall" || name === "pick" || name === "gquery") {
      unlockAudio();
    }
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

  async function doGuardianQuery() {
    const result = await queryGuardianMemory(guardianQuery);
    setGuardianNote(result.text);
  }

  async function onPickMatch(m: RecallMatch) {
    await selectRecall(m);
    if (m.kind === "transcript") {
      setRecallNote(
        m.transcriptText
          ? `${m.phrase}: “${m.transcriptText}” · ${m.lastSeenLabel}`
          : `${m.phrase} · ${m.lastSeenLabel}`,
      );
      setPicker(null);
      return;
    }
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

  const showBlockingEmergency = Boolean(state?.emergencyAlert?.active);
  const sensors = gStatus?.sensors;

  return (
    <div className={`app ${guardianMode ? "app--guardian" : ""}`}>
      <header className="header">
        <div className="brand">
          <div className="brand-mark">
            <h1>SIGHTLINE</h1>
          </div>
          <span>
            {guardianMode
              ? "Guardian Mode — observations for first responders · humans decide"
              : "Mission Control — link the phone, recall what the world forgot"}
          </span>
        </div>
        <div className="header-meta">
          <div className="status-rail">
            <div className="pill">
              <span className={`dot ${state?.live ? "live" : ""}`} />
              {state?.live ? "LIVE" : "IDLE"}
            </div>
            {guardianMode && (
              <div className="pill pill--guardian">
                <span className="dot ok" />
                GUARDIAN ACTIVE
              </div>
            )}
            <div className="pill">
              <span className={`dot ${linkStatus.tone}`} />
              {linkStatus.label}
            </div>
            <div className="pill" title={lasStatus.title}>
              <span className={`dot ${lasStatus.tone}`} />
              {lasStatus.label}
            </div>
            <div className="pill">{connected ? "WS OK" : "WS…"}</div>
            <div className="pill">{state?.mode ?? "STANDBY"}</div>
            <div className="pill">{state?.objects.length ?? 0} mem</div>
          </div>
          <div className="action-rail">
            <button
              className="btn"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              title="Toggle Dark Mode"
            >
              {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
            </button>
            <button
              className="btn"
              onClick={() => setTranscriptOpen(true)}
              title="Open live transcript history"
            >
              Transcript
            </button>
            <button
              className={`btn ${guardianMode ? "primary" : ""}`}
              onClick={() => run("guardian", () => setGuardianMode(!guardianMode))}
              disabled={!!busy}
              title="Toggle Guardian Mode"
            >
              {guardianMode ? "Guardian ON" : "Guardian"}
            </button>
            <button
              className="btn danger"
              onClick={() => run("fall", simulateFall)}
              disabled={!!busy}
              title={
                guardianMode
                  ? "Demo: possible responder distress signal"
                  : "Demo only — does not call 911"
              }
            >
              {guardianMode ? "Simulate Distress" : "Simulate Fall"}
            </button>
            <button
              className="btn danger"
              onClick={() => run("crash", simulateCrash)}
              disabled={!!busy}
              title="Demo: high speed then rapid deceleration — does not call 911"
            >
              Simulate Crash
            </button>
            <button className="btn" onClick={() => run("reset", resetDemo)} disabled={!!busy}>
              Reset
            </button>
          </div>
        </div>
      </header>

      <div className="main">
        <section className="panel pov-panel">
          <div className="panel-title">
            {guardianMode ? "Field POV · Guardian observations" : "Field POV · live detections"}
          </div>
          <LivePOV
            jpegBase64={state?.latestFrameJpegBase64 ?? null}
            detections={overlayDetections}
            source={state?.session?.videoStats?.lastVideoSource}
            visionStatus={visionStatus}
          />

          {guardianMode ? (
            <div className="guardian-bar">
              <div className="guardian-status">
                <div className="guardian-status-head">
                  <span className="guardian-status-label">Active observations</span>
                  <strong>
                    {(gStatus?.highPriority ?? 0) > 0
                      ? `${gStatus?.highPriority} high priority`
                      : "Clear"}
                    {" · "}
                    {gStatus?.informational ?? 0} informational
                  </strong>
                </div>
                <div className="guardian-sensors">
                  <span className={sensors?.camera ? "on" : ""}>● Camera</span>
                  <span className={sensors?.location ? "on" : ""}>● Location</span>
                  <span className={sensors?.motion ? "on" : ""}>● Motion</span>
                  <span className={sensors?.audio ? "on" : ""}>● Audio</span>
                  <span>
                    {gStatus?.groupCount ?? 0} people
                    {gStatus?.largeGroup ? " (crowd)" : ""}
                  </span>
                </div>
              </div>
              <div className="guardian-demo-actions">
                <span className="guardian-demo-label">Demo inject</span>
                {(
                  [
                    ["plate", "Plate"],
                    ["aed", "AED"],
                    ["extinguisher", "Extinguisher"],
                    ["firearm", "Firearm*"],
                    ["distress", "Distress"],
                    ["address", "Address"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className="btn"
                    disabled={!!busy}
                    title={id === "firearm" ? "Uses simulated training imagery — no real weapons" : undefined}
                    onClick={() => run(`demo-${id}`, () => injectGuardianDemo(id))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="actions">
                <input
                  type="text"
                  value={guardianQuery}
                  onChange={(e) => setGuardianQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void run("gquery", doGuardianQuery);
                  }}
                  placeholder="Where was the last AED?"
                  aria-label="Guardian memory query"
                />
                <button
                  className="btn primary"
                  onClick={() => run("gquery", doGuardianQuery)}
                  disabled={!!busy}
                >
                  Ask memory
                </button>
              </div>
              {guardianNote && (
                <div className="stack" style={{ paddingTop: 4, borderTop: "1px solid var(--line)" }}>
                  <div className="row">
                    <span className="k">Guardian memory</span>
                    <span className="v" style={{ textAlign: "left", whiteSpace: "pre-wrap" }}>
                      {guardianNote}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="actions">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void run("recall", doRecall);
                  }}
                  placeholder="Where is my laptop? / Who did I meet?"
                  aria-label="Recall query"
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
                <div className="stack" style={{ paddingTop: 4, borderTop: "1px solid var(--line)" }}>
                  <div className="row">
                    <span className="k">Last recall</span>
                    <span className="v" style={{ textAlign: "left", whiteSpace: "normal" }}>
                      {recallNote}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <aside className="side">
          <LinkPanel linked={Boolean(state?.session?.connected)} />

          {guardianMode && (
            <details className="panel" open>
              <summary className="panel-title">Live memory</summary>
              <div className="scroll">
                {(state?.guardianEvents ?? []).length === 0 && (
                  <div className="det-item">No Guardian observations yet — use Demo inject or live vision.</div>
                )}
                {(state?.guardianEvents ?? []).map((e) => (
                  <div className="det-item" key={e.id}>
                    <div className="row">
                      <span className="k">{new Date(e.timestamp).toLocaleTimeString()}</span>
                      <span className="v">{e.severity}</span>
                    </div>
                    <div className="row">
                      <span className="k">{e.title}</span>
                      <span className="v">
                        {typeof e.confidence === "number"
                          ? `${Math.round(e.confidence * 100)}%`
                          : e.category}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <details className="panel" open>
            <summary className="panel-title">Vision</summary>
            <div className="scroll">
              {overlayDetections.length === 0 && (
                <div className="det-item">
                  {guardianMode
                    ? "Safety-relevant observations only — clutter ignored"
                    : "Waiting for objects — phone, laptop, backpack…"}
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
          </details>

          <MemoryPanel objects={state?.objects ?? []} />

          <details className="panel" open>
            <summary className="panel-title">Context</summary>
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
                <span className="k">Video</span>
                <span className="v">
                  {state?.session?.activeSources?.video ??
                    state?.session?.videoStats?.lastVideoSource ??
                    "—"}
                </span>
              </div>
              <div className="row">
                <span className="k">Frames</span>
                <span className="v">
                  {state?.session?.videoStats?.framesReceived ?? 0} /{" "}
                  {state?.session?.videoStats?.framesVisioned ?? 0}
                </span>
              </div>
              <div className="row">
                <span className="k">Transcript</span>
                <span className="v">{state?.transcriptSnippet || "—"}</span>
              </div>
              <div style={{ padding: "8px 12px 12px" }}>
                <button
                  type="button"
                  className="btn"
                  style={{ width: "100%" }}
                  onClick={() => setTranscriptOpen(true)}
                >
                  Open full transcript
                </button>
              </div>
            </div>
          </details>

          <AgentPanel
            agents={state?.agents ?? []}
            lastRequest={state?.lastAccessRequest ?? null}
            onVerify={(ans) => run("ans", () => verifyAgent(ans, ["location", "memory.read"]))}
            onBlockUnknown={() => run("rogue", simulateUnknown)}
          />
        </aside>
      </div>

      <Timeline events={state?.events ?? []} />

      <GuardianEventStack
        events={state?.guardianEvents ?? []}
        onDismiss={(id) => void dismissGuardianEvent(id)}
        onConfirm={(id) => void confirmGuardianEvent(id)}
      />

      <VoiceIndicator />

      {picker && (
        <RecallPicker
          query={picker.query}
          matches={picker.matches}
          onPick={(m) => void run("pick", () => onPickMatch(m))}
          onClose={() => setPicker(null)}
        />
      )}

      <TranscriptViewer
        open={transcriptOpen}
        liveLines={(state?.recentTranscripts ?? []).map((t) => ({
          id: t.id,
          direction: t.direction,
          text: t.text,
          timestampMs: t.timestampMs,
          source: t.source,
        }))}
        onClose={() => setTranscriptOpen(false)}
      />

      {showBlockingEmergency && state?.emergencyAlert && (
        <EmergencyModal
          key={state.emergencyAlert.triggeredAtMs}
          alert={state.emergencyAlert}
          onDismiss={() => void run("dismiss", dismissEmergency)}
        />
      )}
    </div>
  );
}
