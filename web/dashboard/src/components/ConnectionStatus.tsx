import { useEffect, useId, useRef, useState } from "react";

export function ConnectionStatus({
  phoneConnected,
  wsConnected,
  live,
  memoryCount,
  locateAnything,
}: {
  phoneConnected: boolean;
  wsConnected: boolean;
  live: boolean;
  memoryCount: number;
  locateAnything?: {
    configured: boolean;
    ok: boolean;
    latencyMs: number | null;
    detail?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const healthy = phoneConnected && wsConnected;
  const tone = healthy ? "ok" : phoneConnected || wsConnected ? "warn" : "idle";

  return (
    <div className="conn-status" ref={rootRef}>
      <button
        type="button"
        className={`conn-pill conn-pill--${tone}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`conn-dot conn-dot--${tone}`} aria-hidden="true" />
        <span className="conn-pill-copy">
          <strong>{healthy ? "Connected" : phoneConnected ? "Phone linked" : "Waiting"}</strong>
          <span>
            {live ? "Vision active" : healthy ? "Standby" : "Connect a camera"}
            {" · "}
            {memoryCount} {memoryCount === 1 ? "memory" : "memories"}
          </span>
        </span>
      </button>

      {open && (
        <div className="conn-popover" id={panelId} role="dialog" aria-label="Connection details">
          <div className="conn-popover-row">
            <span>Phone</span>
            <strong className={phoneConnected ? "ok" : "warn"}>
              {phoneConnected ? "Linked" : "Not connected"}
            </strong>
          </div>
          <div className="conn-popover-row">
            <span>Mission Control</span>
            <strong className={wsConnected ? "ok" : "warn"}>
              {wsConnected ? "Online" : "Reconnecting…"}
            </strong>
          </div>
          <div className="conn-popover-row">
            <span>Vision</span>
            <strong>{live ? "Streaming" : "Idle"}</strong>
          </div>
          <div className="conn-popover-row">
            <span>Memories</span>
            <strong>{memoryCount}</strong>
          </div>
          {locateAnything?.configured && (
            <div className="conn-popover-row">
              <span>LocateAnything</span>
              <strong className={locateAnything.ok ? "ok" : "warn"}>
                {locateAnything.ok
                  ? `Ready${locateAnything.latencyMs != null ? ` · ${locateAnything.latencyMs}ms` : ""}`
                  : locateAnything.detail || "Unavailable"}
              </strong>
            </div>
          )}
          <p className="conn-popover-hint">Diagnostics stay here so the main workspace stays calm.</p>
        </div>
      )}
    </div>
  );
}
