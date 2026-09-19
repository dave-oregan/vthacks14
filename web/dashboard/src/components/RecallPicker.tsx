export type RecallMatch = {
  id: string;
  phrase: string;
  label: string;
  descriptors: string[];
  lastSeenAtMs: number;
  lastSeenLabel: string;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  thumbBase64: string | null;
  sightingCount: number;
  status: string;
};

export function RecallPicker({
  query,
  matches,
  onPick,
  onClose,
}: {
  query: string;
  matches: RecallMatch[];
  onPick: (m: RecallMatch) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="panel-title" style={{ border: 0, padding: 0 }}>
              Recall matches
            </div>
            <div className="modal-sub">
              {matches.length} remembered for “{query.trim()}” — tap one to open last-seen map
            </div>
          </div>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-list">
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              className="recall-card"
              onClick={() => onPick(m)}
            >
              {m.thumbBase64 ? (
                <img src={`data:image/jpeg;base64,${m.thumbBase64}`} alt="" />
              ) : (
                <div className="recall-thumb-empty" />
              )}
              <div className="recall-meta">
                <strong>{m.phrase}</strong>
                <span>
                  {m.status} · ×{m.sightingCount} · {m.lastSeenLabel}
                </span>
                <span className="recall-coords">
                  {m.latitude != null && m.longitude != null
                    ? `${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`
                    : "no GPS yet"}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
