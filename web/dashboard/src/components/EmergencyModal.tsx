export type EmergencyAlert = {
  active: boolean;
  demo: true;
  kind?: "fall" | "crash";
  triggeredAtMs: number;
  peakImpactG: number;
  freefallMs: number;
  peakSpeedMph?: number;
  decelerationMphPerSec?: number;
  reason: string;
  message: string;
  location?: { latitude: number; longitude: number } | null;
  guardianDistress?: boolean;
  policeBackup?: boolean;
};

export function EmergencyModal({
  alert,
  onDismiss,
}: {
  alert: EmergencyAlert;
  onDismiss: () => void;
}) {
  if (!alert.active) return null;
  const guardian = Boolean(alert.guardianDistress ?? alert.policeBackup);
  const isCrash = alert.kind === "crash";
  const hasLoc =
    alert.location != null &&
    Number.isFinite(alert.location.latitude) &&
    Number.isFinite(alert.location.longitude);
  const loc = hasLoc
    ? `${alert.location!.latitude.toFixed(5)}, ${alert.location!.longitude.toFixed(5)}`
    : "waiting for phone GPS…";

  const title = guardian
    ? isCrash
      ? "Possible vehicle crash (responder)"
      : "Possible responder distress"
    : isCrash
      ? "Possible crash detected"
      : "Possible fall detected";

  const subtitle = guardian
    ? "SIGHTLINE surfaces the observation — humans decide next steps"
    : isCrash
      ? "High speed then rapid deceleration — SIGHTLINE would contact 911"
      : "SIGHTLINE would contact 911 with last-known phone location";

  const impactLine = isCrash
    ? `${alert.peakSpeedMph ?? "—"} mph` +
      (alert.decelerationMphPerSec
        ? ` · −${alert.decelerationMphPerSec} mph/s`
        : "") +
      (alert.peakImpactG > 0 ? ` · ${alert.peakImpactG}g` : "")
    : `${alert.peakImpactG}g · freefall ${alert.freefallMs}ms`;

  return (
    <div className="modal-backdrop emergency-backdrop" role="alertdialog" aria-modal="true">
      <div className="modal emergency-modal">
        <div className="emergency-banner">
          {guardian
            ? "DEMO ONLY — NO REAL DISPATCH"
            : "DEMO ONLY — NO REAL 911 CALL"}
        </div>
        <div className="modal-header">
          <div>
            <div className="emergency-title">{title}</div>
            <div className="modal-sub">{subtitle}</div>
          </div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            <span className="k">Status</span>
            <span className="v status-blocked">
              {guardian ? "ESCALATION PREVIEW… (simulated)" : "CONTACTING 911… (simulated)"}
            </span>
          </div>
          <div className="row">
            <span className="k">{isCrash ? "Kinematics" : "Impact"}</span>
            <span className="v">{impactLine}</span>
          </div>
          <div className="row">
            <span className="k">{guardian ? "Responder location" : "Phone location"}</span>
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
