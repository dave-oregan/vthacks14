import type { GuardianEvent, GuardianStatus } from "../hooks/useSightline";
import { relativeTime } from "../lib/format";

export function GuardianPanel({
  enabled,
  status,
  events,
  busy,
  onToggle,
  onDismiss,
  onConfirm,
  query,
  onQueryChange,
  onAsk,
  note,
}: {
  enabled: boolean;
  status?: GuardianStatus;
  events: GuardianEvent[];
  busy: boolean;
  onToggle: () => void;
  onDismiss: (id: string) => void;
  onConfirm: (id: string) => void;
  query: string;
  onQueryChange: (v: string) => void;
  onAsk: () => void;
  note: string | null;
}) {
  const sensors = status?.sensors;
  const active = events.filter((e) => e.status === "new" || e.status === "confirmed");

  return (
    <div className="guardian-panel">
      <div className="guardian-hero">
        <div>
          <p className="guardian-kicker">Safety monitoring</p>
          <h2>{enabled ? "Guardian active" : "Guardian standby"}</h2>
          <p className="guardian-lede">
            Watching for falls, vehicle crashes, and distress signals — observations only; humans
            decide.
          </p>
        </div>
        <button
          type="button"
          className={`btn ${enabled ? "primary" : ""}`}
          disabled={busy}
          onClick={onToggle}
        >
          {enabled ? "Guardian on" : "Enable Guardian"}
        </button>
      </div>

      <ul className="guardian-watch">
        <li>Falls</li>
        <li>Vehicle crashes</li>
        <li>Responder distress cues</li>
      </ul>

      {enabled && (
        <div className="guardian-sensors" aria-label="Sensors">
          <span className={sensors?.camera ? "on" : ""}>Camera</span>
          <span className={sensors?.location ? "on" : ""}>Location</span>
          <span className={sensors?.motion ? "on" : ""}>Motion</span>
          <span className={sensors?.audio ? "on" : ""}>Audio</span>
          <span>
            {(status?.highPriority ?? 0) > 0
              ? `${status?.highPriority} high priority`
              : "Clear"}
          </span>
        </div>
      )}

      <div className="guardian-ask">
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onAsk();
          }}
          placeholder="Where was the last AED?"
          aria-label="Ask Guardian memory"
        />
        <button type="button" className="btn" disabled={busy} onClick={onAsk}>
          Ask
        </button>
      </div>
      {note && <p className="guardian-note">{note}</p>}

      <div className="guardian-feed">
        <h3>Recent events</h3>
        {active.length === 0 && (
          <p className="guardian-empty">No incidents yet. Demo → Simulate fall to preview.</p>
        )}
        {active.slice(0, 12).map((e) => {
          const demo = Boolean(e.metadata?.simulated);
          return (
            <article
              key={e.id}
              className={`guardian-card guardian-card--${e.severity}${demo ? " guardian-card--demo" : ""}`}
            >
              <header>
                <strong>{e.title}</strong>
                {demo && <span className="demo-badge">DEMO</span>}
              </header>
              <p>{e.description}</p>
              <div className="guardian-card-meta">
                <span>{relativeTime(e.timestamp)}</span>
                {typeof e.confidence === "number" && (
                  <span>{Math.round(e.confidence * 100)}% confidence</span>
                )}
              </div>
              <div className="guardian-card-actions">
                {e.requiresReview && e.status === "new" && (
                  <button type="button" className="btn primary" onClick={() => onConfirm(e.id)}>
                    Check on user
                  </button>
                )}
                <button type="button" className="btn" onClick={() => onDismiss(e.id)}>
                  Dismiss
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
