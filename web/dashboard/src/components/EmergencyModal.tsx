export type EmergencyAlert = {
  active: boolean;
  demo: true;
  triggeredAtMs: number;
  peakImpactG: number;
  freefallMs: number;
  reason: string;
  message: string;
  location?: { latitude: number; longitude: number } | null;
};

export function EmergencyModal({
  alert,
  onDismiss,
}: {
  alert: EmergencyAlert;
  onDismiss: () => void;
}) {
  if (!alert.active) return null;
  const hasLoc =
    alert.location != null &&
    Number.isFinite(alert.location.latitude) &&
    Number.isFinite(alert.location.longitude);
  const loc = hasLoc
    ? `${alert.location!.latitude.toFixed(5)}, ${alert.location!.longitude.toFixed(5)}`
    : "waiting for phone GPS…";

  return (
    <div className="modal-backdrop emergency-backdrop" role="alertdialog" aria-modal="true">
      <div className="modal emergency-modal">
        <div className="emergency-banner">DEMO ONLY — NO REAL 911 CALL</div>
        <div className="modal-header" style={{ borderBottom: "1px solid #5a2218" }}>
          <div>
            <div className="emergency-title">Possible fall detected</div>
            <div className="modal-sub" style={{ color: "#ffc9bc" }}>
              SIGHTLINE would contact 911 with last-known phone location
            </div>
          </div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            <span className="k">Status</span>
            <span className="v status-blocked">CONTACTING 911… (simulated)</span>
          </div>
          <div className="row">
            <span className="k">Impact</span>
            <span className="v">{alert.peakImpactG}g · freefall {alert.freefallMs}ms</span>
          </div>
          <div className="row">
            <span className="k">Phone location</span>
            <span className="v" style={{ color: hasLoc ? "var(--accent)" : undefined }}>
              {loc}
            </span>
          </div>
          <div className="row">
            <span className="k">Signal</span>
            <span className="v" style={{ textAlign: "left", whiteSpace: "normal" }}>
              {alert.reason}
            </span>
          </div>
          <p className="emergency-copy">{alert.message}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn danger" type="button" onClick={onDismiss}>
              Cancel demo alert
            </button>
            {hasLoc && (
              <a
                className="btn"
                href={`https://www.google.com/maps?q=${alert.location!.latitude},${alert.location!.longitude}`}
                target="_blank"
                rel="noreferrer"
              >
                Open last location
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
