import type { RecallMatch } from "../hooks/useSightline";
import { relativeTime } from "../lib/format";

export function RecallResultPanel({
  match,
  narrative,
  onViewMaps,
  onClear,
}: {
  match: RecallMatch | null;
  narrative: string | null;
  onViewMaps: () => void;
  onClear: () => void;
}) {
  if (!match) {
    return (
      <div className="recall-result recall-result--empty">
        <p className="recall-result-kicker">Visual memory</p>
        <h2>Ask where something was</h2>
        <p className="recall-result-body">
          The answer is a moment in time — not a chat reply. Search, then watch SIGHTLINE rewind to
          the frame.
        </p>
      </div>
    );
  }

  const isTx = match.kind === "transcript";
  const title = match.phrase || match.label;
  const spatial =
    (narrative && narrative.length < 220 ? narrative.trim() : null) ||
    match.transcriptText ||
    (match.latitude != null && match.longitude != null
      ? `Last GPS fix ${match.latitude.toFixed(5)}, ${match.longitude.toFixed(5)}`
      : null);

  return (
    <div className="recall-result">
      <p className="recall-result-kicker">{isTx ? "Conversation memory" : "Found in memory"}</p>
      <h2>{title}</h2>
      <div className="recall-result-meta">
        <span>Last seen {relativeTime(match.lastSeenAtMs)}</span>
        {!isTx && match.sightingCount > 0 && (
          <span>×{match.sightingCount} sightings</span>
        )}
      </div>
      {match.lastSeenLabel && (
        <p className="recall-result-place">{match.lastSeenLabel}</p>
      )}
      {spatial && <blockquote className="recall-result-quote">“{spatial}”</blockquote>}
      <div className="recall-result-actions">
        {match.mapsUrl && (
          <button type="button" className="btn primary" onClick={onViewMaps}>
            Find nearby
          </button>
        )}
        <button type="button" className="btn" onClick={onClear}>
          Clear
        </button>
      </div>
      <dl className="recall-result-details">
        <div>
          <dt>Detected</dt>
          <dd>{new Date(match.lastSeenAtMs).toLocaleString()}</dd>
        </div>
        {!isTx && (
          <div>
            <dt>Sightings</dt>
            <dd>×{match.sightingCount}</dd>
          </div>
        )}
        {match.descriptors?.length > 0 && (
          <div>
            <dt>Descriptors</dt>
            <dd>{match.descriptors.slice(0, 4).join(", ")}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
