import { useMemo, useState, useEffect } from "react";
import { useSightline, type RecallMatch } from "./hooks/useSightline";
import { useBrowserVision } from "./hooks/useBrowserVision";
import { LivePOV } from "./components/LivePOV";
import { MemoryPanel } from "./components/MemoryPanel";
import { AgentPanel } from "./components/AgentPanel";
import { PhoneConnectionCard } from "./components/LinkPanel";
import { RecallPicker } from "./components/RecallPicker";
import { EmergencyModal } from "./components/EmergencyModal";
import { GuardianEventStack } from "./components/GuardianEventStack";
import { TranscriptViewer } from "./components/TranscriptViewer";
import { VoiceIndicator } from "./components/VoiceIndicator";
import { ModeTabs } from "./components/ModeTabs";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { DemoMenu } from "./components/DemoMenu";
import { RecallSearch } from "./components/RecallSearch";
import { RecallResultPanel } from "./components/RecallResultPanel";
import { MemoryTimeline, type MemoryReelItem } from "./components/MemoryTimeline";
import { GuardianPanel } from "./components/GuardianPanel";
import { unlockAudio } from "./voice/voicePlayer";
import type { AppMode } from "./lib/format";

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
  const [mode, setMode] = useState<AppMode>("live");
  const [query, setQuery] = useState("");
  const [guardianQuery, setGuardianQuery] = useState("Where was the last AED?");
  const [busy, setBusy] = useState<string | null>(null);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const [guardianNote, setGuardianNote] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ query: string; matches: RecallMatch[] } | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<RecallMatch | null>(null);
  const [rewinding, setRewinding] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [focusConnect, setFocusConnect] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "1") setMode("live");
      if (e.key === "2") setMode("recall");
      if (e.key === "3") setMode("guardian");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const guardianMode = Boolean(state?.guardianMode ?? state?.policeMode);
  const phoneLinked = Boolean(state?.session?.connected);

  // Align Guardian backend flag with the Guardian tab (once per mode change).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (mode === "guardian" && !guardianMode) {
        if (!cancelled) await setGuardianMode(true);
      } else if (mode !== "guardian" && guardianMode) {
        if (!cancelled) await setGuardianMode(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only when mode changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const { detections: browserDets, ready: visionReady, status: visionStatus } = useBrowserVision(
    state?.latestFrameJpegBase64 ?? null,
    { enabled: true, report: true },
  );

  const overlayDetections = useMemo(() => {
    const server = state?.latestDetections ?? [];
    if (mode !== "guardian") {
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
  }, [browserDets, state?.latestDetections, visionReady, mode]);

  const reelItems: MemoryReelItem[] = useMemo(() => {
    const objs = (state?.objects ?? []).map((o) => {
      const phrase =
        o.displayName?.trim() ||
        [...o.descriptors.filter((d) => d !== o.canonicalLabel).slice(0, 2), o.canonicalLabel]
          .filter(Boolean)
          .join(" ");
      return {
        id: o.id,
        kind: "object" as const,
        label: phrase,
        timestampMs: o.lastSeenAtMs,
        thumbBase64: o.thumbBase64,
      };
    });
    const safety = (state?.guardianEvents ?? [])
      .filter((e) => e.severity === "critical" || e.severity === "high" || e.category === "distress")
      .map((e) => ({
        id: `g-${e.id}`,
        kind: "safety" as const,
        label: e.title,
        timestampMs: e.timestamp,
        thumbBase64: null as string | null,
      }));
    return [...objs, ...safety].sort((a, b) => b.timestampMs - a.timestampMs);
  }, [state?.objects, state?.guardianEvents]);

  async function run(name: string, fn: () => Promise<unknown>) {
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

  function applyMatch(m: RecallMatch, narrative: string | null) {
    setSelectedMatch(m);
    setRecallNote(narrative);
    setRewinding(true);
    window.setTimeout(() => setRewinding(false), 700);
    setMode("recall");
  }

  async function doRecall() {
    const result = await recall(query);
    if (result.needsChoice && result.matches.length > 1) {
      setPicker({ query: result.query || query, matches: result.matches });
      setRecallNote(result.text);
      setMode("recall");
      return;
    }
    const top = result.matches[0];
    if (top) {
      applyMatch(top, result.text);
      if (top.kind !== "transcript") await selectRecall(top);
    } else {
      setSelectedMatch(null);
      setRecallNote(result.text || "Nothing found in memory yet.");
      setMode("recall");
    }
    setPicker(null);
  }

  async function onPickMatch(m: RecallMatch) {
    await selectRecall(m);
    applyMatch(
      m,
      m.kind === "transcript"
        ? m.transcriptText
          ? `${m.phrase}: “${m.transcriptText}” · ${m.lastSeenLabel}`
          : `${m.phrase} · ${m.lastSeenLabel}`
        : m.latitude != null && m.longitude != null
          ? `${m.phrase} · last seen near ${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`
          : `${m.phrase} · ${m.lastSeenLabel}`,
    );
    setPicker(null);
  }

  async function doGuardianQuery() {
    const result = await queryGuardianMemory(guardianQuery);
    setGuardianNote(result.text);
  }

  function onModeChange(next: AppMode) {
    setMode(next);
  }

  const showBlockingEmergency = Boolean(state?.emergencyAlert?.active);

  const recallCanvas =
    selectedMatch?.thumbBase64 != null
      ? selectedMatch.thumbBase64
      : mode === "recall" && selectedMatch
        ? state?.latestFrameJpegBase64
        : state?.latestFrameJpegBase64;

  const recallHighlight =
    selectedMatch && selectedMatch.kind !== "transcript"
      ? selectedMatch.label || selectedMatch.phrase
      : null;

  return (
    <div className={`app app--${mode}${mode === "guardian" ? " app--guardian" : ""}`}>
      <header className="topnav">
        <div className="topnav-left">
          <h1 className="wordmark">SIGHTLINE</h1>
          <ModeTabs mode={mode} onChange={onModeChange} />
        </div>
        <div className="topnav-right">
          <ConnectionStatus
            phoneConnected={phoneLinked}
            wsConnected={connected}
            live={Boolean(state?.live)}
            memoryCount={state?.objects.length ?? 0}
            locateAnything={state?.locateAnything}
          />
          <DemoMenu
            busy={!!busy}
            showGuardianInject={mode === "guardian"}
            onFall={() => void run("fall", simulateFall)}
            onCrash={() => void run("crash", simulateCrash)}
            onReset={() => void run("reset", resetDemo)}
            onInject={(id) => void run(`demo-${id}`, () => injectGuardianDemo(id))}
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setTranscriptOpen(true)}
            title="Transcript"
          >
            Transcript
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
          >
            Settings
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      {settingsOpen && (
        <div className="settings-strip" role="region" aria-label="Settings">
          <AgentPanel
            agents={state?.agents ?? []}
            lastRequest={state?.lastAccessRequest ?? null}
            onVerify={(ans) => run("ans", () => verifyAgent(ans, ["location", "memory.read"]))}
            onBlockUnknown={() => run("rogue", simulateUnknown)}
          />
          <button type="button" className="btn" onClick={() => setSettingsOpen(false)}>
            Close settings
          </button>
        </div>
      )}

      <div className="workspace">
        <section className="canvas-col">
          <LivePOV
            jpegBase64={recallCanvas ?? null}
            detections={mode === "recall" && selectedMatch?.thumbBase64 ? [] : overlayDetections}
            source={state?.session?.videoStats?.lastVideoSource}
            visionStatus={visionStatus}
            variant={mode === "recall" ? "recall" : mode === "guardian" ? "guardian" : "live"}
            highlightLabel={mode === "recall" ? recallHighlight : null}
            rewinding={rewinding}
            onConnectClick={
              !phoneLinked
                ? () => {
                    setFocusConnect(true);
                    setMode("live");
                  }
                : undefined
            }
            emptyTitle={
              mode === "recall"
                ? "Search memory to rewind"
                : "Connect a camera to begin seeing"
            }
            emptyHint={
              mode === "recall"
                ? "Try “Where is my black laptop?”"
                : "Your existing memories remain searchable."
            }
            statusLine={
              mode === "recall" && selectedMatch
                ? `Remembered · ${selectedMatch.phrase}`
                : null
            }
          />

          {mode === "recall" && (
            <RecallSearch
              query={query}
              busy={busy === "recall"}
              onChange={setQuery}
              onSubmit={() => void run("recall", doRecall)}
            />
          )}

          {mode === "live" && (
            <div className="live-quick-recall">
              <button type="button" className="btn primary" onClick={() => setMode("recall")}>
                Search memory
              </button>
              <span>The physical world is searchable.</span>
            </div>
          )}
        </section>

        <aside className="context-col">
          {mode === "live" && (
            <>
              <PhoneConnectionCard linked={phoneLinked} focusConnect={focusConnect} />
              <div className="side-section">
                <h3 className="side-title">Seeing now</h3>
                <div className="seeing-list">
                  {overlayDetections.length === 0 && (
                    <p className="side-muted">Nothing labeled yet — point the camera at an object.</p>
                  )}
                  {overlayDetections.slice(0, 6).map((d) => (
                    <div className="seeing-item" key={d.trackId}>
                      <strong>{d.displayName}</strong>
                      <span>{Math.round(d.confidence * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
              <MemoryPanel objects={state?.objects ?? []} />
            </>
          )}

          {mode === "recall" && (
            <RecallResultPanel
              match={selectedMatch}
              narrative={recallNote}
              onViewMaps={() => {
                if (selectedMatch?.mapsUrl) {
                  window.open(selectedMatch.mapsUrl, "_blank", "noopener,noreferrer");
                }
              }}
              onClear={() => {
                setSelectedMatch(null);
                setRecallNote(null);
              }}
            />
          )}

          {mode === "guardian" && (
            <GuardianPanel
              enabled={guardianMode}
              status={state?.guardianStatus}
              events={state?.guardianEvents ?? []}
              busy={!!busy}
              onToggle={() => void run("guardian", () => setGuardianMode(!guardianMode))}
              onDismiss={(id) => void dismissGuardianEvent(id)}
              onConfirm={(id) => void confirmGuardianEvent(id)}
              query={guardianQuery}
              onQueryChange={setGuardianQuery}
              onAsk={() => void run("gquery", doGuardianQuery)}
              note={guardianNote}
            />
          )}
        </aside>
      </div>

      <MemoryTimeline
        items={reelItems}
        selectedId={selectedMatch?.id}
        scrubbing={rewinding}
        onSelect={(id) => {
          const obj = state?.objects?.find((o) => o.id === id);
          if (!obj) return;
          const phrase =
            obj.displayName?.trim() ||
            [...obj.descriptors.slice(0, 2), obj.canonicalLabel].filter(Boolean).join(" ");
          applyMatch(
            {
              id: obj.id,
              kind: "object",
              phrase,
              label: obj.canonicalLabel,
              descriptors: obj.descriptors,
              lastSeenAtMs: obj.lastSeenAtMs,
              lastSeenLabel: new Date(obj.lastSeenAtMs).toLocaleString(),
              latitude: obj.lastLocation?.latitude ?? null,
              longitude: obj.lastLocation?.longitude ?? null,
              mapsUrl:
                obj.lastLocation != null
                  ? `https://www.google.com/maps?q=${obj.lastLocation.latitude},${obj.lastLocation.longitude}`
                  : null,
              thumbBase64: obj.thumbBase64 ?? null,
              sightingCount: obj.sightingCount,
              status: obj.status,
            },
            null,
          );
        }}
      />

      {mode === "guardian" && (
        <GuardianEventStack
          events={state?.guardianEvents ?? []}
          onDismiss={(id) => void dismissGuardianEvent(id)}
          onConfirm={(id) => void confirmGuardianEvent(id)}
        />
      )}

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
