type Detection = {
  trackId: string;
  displayName: string;
  label?: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
};

const BOX_COLORS = ["#d6ff4b", "#5ec8ff", "#ffb86b", "#c4a7ff", "#3ddc97", "#ff6b9d"];

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
          Scan QR or Find Mission Control on the phone
        </div>
      )}
      {detections.map((d, i) => {
        const color = BOX_COLORS[i % BOX_COLORS.length]!;
        return (
          <div
            key={`${d.trackId}-${i}`}
            className="overlay-box"
            style={{
              left: `${d.bbox.x * 100}%`,
              top: `${d.bbox.y * 100}%`,
              width: `${d.bbox.width * 100}%`,
              height: `${d.bbox.height * 100}%`,
              ["--box-color" as string]: color,
            }}
          >
            <div className="overlay-label">
              {d.displayName} {Math.round(d.confidence * 100)}%
            </div>
          </div>
        );
      })}
      <div
        className="pill"
        style={{ position: "absolute", left: 8, bottom: 8, opacity: 0.92 }}
      >
        {detections.length} obj{detections.length === 1 ? "" : "s"}
        {source ? ` · ${source}` : ""}
      </div>
    </div>
  );
}
