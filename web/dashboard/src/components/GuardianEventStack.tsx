import type { GuardianEvent } from "../hooks/useSightline";

export function GuardianEventStack({
  events,
  onDismiss,
  onConfirm,
}: {
  events: GuardianEvent[];
  onDismiss: (id: string) => void;
  onConfirm?: (id: string) => void;
}) {
  if (!events.length) return null;

  return (
    <aside className="side-alerts" aria-live="polite" aria-label="Guardian observations">
      {events.slice(0, 8).map((e) => (
        <article
          key={e.id}
          className={`side-alert side-alert--${severityClass(e.severity)} side-alert--${e.category}`}
        >
          <div className="side-alert-top">
            <span className="side-alert-kind">{categoryLabel(e.category)}</span>
            <button
              type="button"
              className="side-alert-x"
              onClick={() => onDismiss(e.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          <div className="side-alert-body">
            {e.frameReference && (
              <img src={e.frameReference} alt="" className="side-alert-thumb" />
            )}
            <div className="side-alert-copy">
              <strong>{e.title}</strong>
              <p style={{ whiteSpace: "pre-wrap" }}>{e.description}</p>
              <div className="guardian-event-meta">
                {typeof e.confidence === "number" && (
                  <span>Confidence {Math.round(e.confidence * 100)}%</span>
                )}
                <span>{e.severity.toUpperCase()}</span>
                <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
                {e.metadata?.simulated ? <span className="sim-tag">SIM</span> : null}
              </div>
              {e.location && (
                <a
                  className="side-alert-loc"
                  href={`https://www.google.com/maps?q=${e.location.latitude},${e.location.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {e.location.latitude.toFixed(5)}, {e.location.longitude.toFixed(5)}
                </a>
              )}
              {e.requiresReview && (
                <div className="guardian-event-actions">
                  {onConfirm && (
                    <button type="button" className="btn" onClick={() => onConfirm(e.id)}>
                      Mark relevant
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => onDismiss(e.id)}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        </article>
      ))}
    </aside>
  );
}

function categoryLabel(category: GuardianEvent["category"]): string {
  switch (category) {
    case "potential_threat":
      return "OBSERVATION";
    case "vehicle":
      return "VEHICLE";
    case "safety_resource":
      return "RESOURCE";
    case "hazard":
      return "HAZARD";
    case "distress":
      return "DISTRESS";
    case "medical":
      return "MEDICAL";
    case "location":
      return "LOCATION";
    case "environment":
      return "SCENE";
    default:
      return "SYSTEM";
  }
}

function severityClass(severity: GuardianEvent["severity"]): string {
  if (severity === "critical" || severity === "high") return "critical";
  if (severity === "medium") return "warn";
  return "info";
}
