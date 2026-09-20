import type { SideAlert } from "../hooks/useSightline";

export function SideAlertStack({
  alerts,
  onDismiss,
}: {
  alerts: SideAlert[];
  onDismiss: (id: string) => void;
}) {
  if (!alerts.length) return null;

  return (
    <aside className="side-alerts" aria-live="polite" aria-label="Police safety alerts">
      {alerts.map((a) => (
        <article
          key={a.id}
          className={`side-alert side-alert--${a.severity} side-alert--${a.kind}`}
        >
          <div className="side-alert-top">
            <span className="side-alert-kind">{kindLabel(a.kind)}</span>
            <button
              type="button"
              className="side-alert-x"
              onClick={() => onDismiss(a.id)}
              aria-label="Dismiss alert"
            >
              ×
            </button>
          </div>
          <div className="side-alert-body">
            {a.thumbBase64 && (
              <img
                src={`data:image/jpeg;base64,${a.thumbBase64}`}
                alt=""
                className="side-alert-thumb"
              />
            )}
            <div className="side-alert-copy">
              <strong>{a.title}</strong>
              <p>{a.message}</p>
              {a.location && (
                <a
                  className="side-alert-loc"
                  href={`https://www.google.com/maps?q=${a.location.latitude},${a.location.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.location.latitude.toFixed(5)}, {a.location.longitude.toFixed(5)}
                </a>
              )}
            </div>
          </div>
        </article>
      ))}
    </aside>
  );
}

function kindLabel(kind: SideAlert["kind"]): string {
  switch (kind) {
    case "danger_weapon":
      return "THREAT";
    case "plate_capture":
      return "PLATE";
    case "backup_recommend":
      return "BACKUP";
    case "officer_down":
      return "DOWN";
    default:
      return "INFO";
  }
}
