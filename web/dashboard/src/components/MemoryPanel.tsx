import { relativeTime } from "../lib/format";

type Obj = {
  id: string;
  canonicalLabel: string;
  displayName?: string;
  descriptors: string[];
  lastSeenAtMs: number;
  lastLocation?: { latitude: number; longitude: number } | null;
  sightingCount: number;
  status: string;
  thumbBase64?: string | null;
};

export function MemoryPanel({ objects }: { objects: Obj[] }) {
  return (
    <div className="side-section memory-panel">
      <h3 className="side-title">Recent memories</h3>
      <div className="memory-panel-list">
        {objects.length === 0 && (
          <p className="side-muted">Objects you see become searchable memories.</p>
        )}
        {objects.slice(0, 8).map((o) => {
          const phrase =
            o.displayName?.trim() ||
            [...o.descriptors.filter((d) => d !== o.canonicalLabel).slice(0, 3), o.canonicalLabel]
              .filter(Boolean)
              .join(" ");
          return (
            <div className="obj-item" key={o.id}>
              {o.thumbBase64 ? (
                <img src={`data:image/jpeg;base64,${o.thumbBase64}`} alt={phrase} />
              ) : (
                <div className="obj-thumb-empty" aria-hidden="true" />
              )}
              <div className="obj-meta">
                <strong>{phrase}</strong>
                <span>{relativeTime(o.lastSeenAtMs)} · ×{o.sightingCount}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
