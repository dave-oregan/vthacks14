type Obj = {
  id: string;
  canonicalLabel: string;
  descriptors: string[];
  lastSeenAtMs: number;
  lastLocation?: { latitude: number; longitude: number } | null;
  sightingCount: number;
  status: string;
  thumbBase64?: string | null;
};

export function MemoryPanel({ objects }: { objects: Obj[] }) {
  return (
    <section className="panel">
      <div className="panel-title">Memory · last seen</div>
      <div className="scroll">
        {objects.length === 0 && (
          <div className="obj-item">
            <div />
            <div className="obj-meta">
              <strong>No objects stored yet</strong>
              <span>Detections with location become memory cards</span>
            </div>
          </div>
        )}
        {objects.map((o) => {
          const phrase = [...o.descriptors.filter((d) => d !== o.canonicalLabel).slice(0, 3), o.canonicalLabel]
            .filter(Boolean)
            .join(" ");
          return (
            <div className="obj-item" key={o.id}>
              {o.thumbBase64 ? (
                <img src={`data:image/jpeg;base64,${o.thumbBase64}`} alt={phrase} />
              ) : (
                <div style={{ width: 56, height: 56, background: "#000" }} />
              )}
              <div className="obj-meta">
                <strong>{phrase}</strong>
                <span>
                  {o.status} · ×{o.sightingCount} · {new Date(o.lastSeenAtMs).toLocaleString()}
                </span>
                <span>
                  {o.lastLocation
                    ? `${o.lastLocation.latitude.toFixed(5)}, ${o.lastLocation.longitude.toFixed(5)}`
                    : "no geo yet"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
