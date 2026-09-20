import { useMemo, useState } from "react";
import { useSightline, type RecallMatch } from "./hooks/useSightline";
import { useBrowserVision } from "./hooks/useBrowserVision";
import { LivePOV } from "./components/LivePOV";
import { MemoryPanel } from "./components/MemoryPanel";
import { AgentPanel } from "./components/AgentPanel";
import { Timeline } from "./components/Timeline";
import { LinkPanel } from "./components/LinkPanel";
import { RecallPicker } from "./components/RecallPicker";
import { EmergencyModal } from "./components/EmergencyModal";
import { SideAlertStack } from "./components/SideAlertStack";

export function App() {
  const {
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
    setBackupThreshold,
    dismissSideAlert,
  } = useSightline();
  const [query, setQuery] = useState("Where is my black laptop?");
  const [busy, setBusy] = useState<string | null>(null);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ query: string; matches: RecallMatch[] } | null>(null);

  const policeMode = Boolean(state?.policeMode);
  const police = state?.policeStatus;

  // Browser COCO: always for snappy POV; in police mode still report people for crowd meter.
  const { detections: browserDets, ready: visionReady, status: visionStatus } = useBrowserVision(
    state?.latestFrameJpegBase64 ?? null,
    { enabled: true, report: true },
  );

  const overlayDetections = useMemo(() => {
    const server = state?.latestDetections ?? [];
    const POLICE_KEEP =
      /\b(gun|handgun|pistol|rifle|firearm|weapon|knife|blade|machete|person|people|crowd|fist|fight|punch|hostile|license\s*plate|number\s*plate|plate)\b/i;

    if (!policeMode) {
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

    // Police POV: ignore non-weapons / clutter — people, weapons, hostility cues, plates only.
    const fromBrowser = browserDets.filter((d) =>
      POLICE_KEEP.test(`${d.label} ${d.displayName ?? ""}`),
    );
    const fromServer = server.filter((d) =>
      POLICE_KEEP.test(`${d.label} ${d.displayName ?? ""}`),
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
  }, [browserDets, state?.latestDetections, visionReady, policeMode]);

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

  const showBlockingEmergency =
    Boolean(state?.emergencyAlert?.active) && !state?.emergencyAlert?.policeBackup;

  const danger = police?.dangerLevel ?? 0;
  const backupPct = Math.round((police?.backupThreshold ?? 0.55) * 100);

  return (
    <div className={`app ${policeMode ? "app--police" : ""}`}>
      <header className="header">
        <div className="brand">
          <h1>SIGHTLINE</h1>
          <span>
            {policeMode
              ? "Police suite — weapons, plates, officer safety & backup"
              : "Mission Control — link the phone, recall what the world forgot"}
          </span>
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
          <div className="pill" title={lasStatus.title}>
            <span className={`dot ${lasStatus.tone}`} />
            {lasStatus.label}
          </div>
          <div className="pill">{connected ? "WS OK" : "WS…"}</div>
          <div className="pill">{state?.mode ?? "STANDBY"}</div>
          <div className="pill">{state?.objects.length ?? 0} mem</div>
          <button
            className={`btn ${policeMode ? "primary" : ""}`}
            onClick={() => run("police", () => setPoliceMode(!policeMode))}
            disabled={!!busy}
            title="Toggle police safety suite"
          >
            {policeMode ? "Police ON" : "Police"}
          </button>
          <button
            className="btn danger"
            onClick={() => run("fall", simulateFall)}
            disabled={!!busy}
            title={
              policeMode
                ? "Demo: officer down → request backup"
                : "Demo only — does not call 911"
            }
          >
            {policeMode ? "Simulate Down" : "Simulate Fall"}
          </button>
          <button className="btn" onClick={() => run("reset", resetDemo)} disabled={!!busy}>
            Reset
          </button>
        </div>
      </header>

      <div className="main">
        <section className="panel pov-panel">
          <div className="panel-title">
            {policeMode ? "Live POV · officer safety" : "Live POV · detections"}
          </div>
          <LivePOV
            jpegBase64={state?.latestFrameJpegBase64 ?? null}
            detections={overlayDetections}
            source={state?.session?.videoStats?.lastVideoSource}
            visionStatus={visionStatus}
          />

          {policeMode ? (
            <div className="police-bar">
              <div className="danger-meter">
                <div className="danger-meter-head">
                  <span className="danger-meter-label">Danger</span>
                  <strong className={`danger-meter-value danger-meter-value--${(police?.dangerLabel ?? "Clear").toLowerCase()}`}>
                    {police?.dangerLabel ?? "Clear"} · {danger}
                  </strong>
                </div>
                <div className="danger-meter-track" aria-hidden>
                  <div
                    className="danger-meter-fill"
                    style={{ width: `${danger}%` }}
                  />
                  <div
                    className="danger-meter-mark"
                    style={{ left: `${backupPct}%` }}
                    title={`Backup threshold ${backupPct}%`}
                  />
                </div>
                <div className="danger-meter-meta">
                  <span>
                    {police?.topThreat
                      ? `${police.topThreat} · ${Math.round((police.topConfidence ?? 0) * 100)}%`
                      : "No weapons in last scan"}
                    {" · "}
                    {police?.groupCount ?? 0} people
                    {police?.largeGroup ? " (large group)" : ""}
                    {" · "}
                    Hostility {police?.hostilityLabel ?? "Calm"}
                    {typeof police?.hostility === "number" ? ` ${police.hostility}` : ""}
                  </span>
                  {police?.backupArmed && (
                    <span className="danger-meter-armed">BACKUP ARMED</span>
                  )}
                </div>
              </div>
              <label className="backup-threshold">
                <span className="backup-threshold-label">
                  Call backup at ≥ <strong>{backupPct}%</strong> confidence
                </span>
                <input
                  type="range"
                  min={20}
                  max={95}
                  step={5}
                  value={backupPct}
                  onChange={(e) => {
                    const next = Number(e.target.value) / 100;
                    void setBackupThreshold(next);
                  }}
                  aria-label="Backup confidence threshold"
                />
              </label>
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
                  placeholder="Where is my black laptop?"
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

          <section className="panel">
            <div className="panel-title">Vision</div>
            <div className="scroll">
              {overlayDetections.length === 0 && (
                <div className="det-item">
                  {policeMode
                    ? "Weapons, people & hostility only — clutter ignored"
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

      <SideAlertStack
        alerts={state?.sideAlerts ?? []}
        onDismiss={(id) => void dismissSideAlert(id)}
      />

      {picker && (
        <RecallPicker
          query={picker.query}
          matches={picker.matches}
          onPick={(m) => void run("pick", () => onPickMatch(m))}
          onClose={() => setPicker(null)}
        />
      )}

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
