export type RecallMatch = {
  id: string;
  kind?: "object" | "transcript";
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
  transcriptText?: string;
  transcriptSource?: string | null;
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
  const hasTranscripts = matches.some((m) => m.kind === "transcript");
  const hasObjects = matches.some((m) => (m.kind ?? "object") === "object");

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="panel-title" style={{ border: 0, padding: 0 }}>
              Recall matches
            </div>
            <div className="modal-sub">
              {matches.length} remembered for “{query.trim()}”
              {hasObjects && hasTranscripts
                ? " — objects & conversations"
                : hasTranscripts
                  ? " — tap a conversation line"
                  : " — tap one to open last-seen map"}
            </div>
          </div>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-list">
          {matches.map((m) => {
            const isTx = m.kind === "transcript";
            return (
              <button
                key={`${m.kind ?? "object"}:${m.id}`}
                type="button"
                className={`recall-card ${isTx ? "recall-card--transcript" : ""}`}
                onClick={() => onPick(m)}
              >
                {m.thumbBase64 ? (
                  <img src={`data:image/jpeg;base64,${m.thumbBase64}`} alt="" />
                ) : (
                  <div className={`recall-thumb-empty ${isTx ? "recall-thumb-empty--tx" : ""}`}>
                    {isTx ? "TX" : ""}
                  </div>
                )}
                <div className="recall-meta">
                  <strong>{m.phrase}</strong>
                  <span>
                    {isTx ? "conversation" : m.status} · {m.lastSeenLabel}
                    {!isTx ? ` · ×${m.sightingCount}` : ""}
                  </span>
                  <span className="recall-coords">
                    {isTx
                      ? m.transcriptText && m.transcriptText !== m.phrase
                        ? m.transcriptText
                        : m.descriptors.filter(Boolean).slice(0, 2).join(" · ") || "heard"
                      : m.latitude != null && m.longitude != null
                        ? `${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}`
                        : "no GPS yet"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
