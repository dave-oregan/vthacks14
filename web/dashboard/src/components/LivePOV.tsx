type Detection = {
  trackId: string;
  displayName: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
};

export function LivePOV({
  jpegBase64,
  detections,
  source,
}: {
  jpegBase64: string | null;
  detections: Detection[];
  source?: string;
}) {
  return (
    <div className="pov-wrap">
      {jpegBase64 ? (
        <img src={`data:image/jpeg;base64,${jpegBase64}`} alt="Live POV" />
      ) : (
        <div className="pov-empty">
          Waiting for iOS Link video…
          <br />
          Connect Sightline Link → ws://&lt;this-mac-ip&gt;:8000/ws/relay
        </div>
      )}
      {detections.map((d) => (
        <div
          key={d.trackId}
          className="overlay-box"
          style={{
            left: `${d.bbox.x * 100}%`,
            top: `${d.bbox.y * 100}%`,
            width: `${d.bbox.width * 100}%`,
            height: `${d.bbox.height * 100}%`,
          }}
        >
          <div className="overlay-label">
            {d.displayName} {Math.round(d.confidence * 100)}%
          </div>
        </div>
      ))}
      {source && (
        <div
          className="pill"
          style={{ position: "absolute", left: 10, bottom: 10, opacity: 0.92 }}
        >
          SRC {source}
        </div>
      )}
    </div>
  );
}
