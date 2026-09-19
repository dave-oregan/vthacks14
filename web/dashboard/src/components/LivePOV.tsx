import { useEffect, useState } from "react";

type Detection = {
  trackId: string;
  displayName: string;
  label?: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
};

const BOX_COLORS = ["#d6ff4b", "#5ec8ff", "#ffb86b", "#c4a7ff", "#3ddc97", "#ff6b9d"];

function base64ToObjectUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

export function LivePOV({
  jpegBase64,
  detections,
  source,
  visionStatus,
}: {
  jpegBase64: string | null;
  detections: Detection[];
  source?: string;
  visionStatus?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!jpegBase64) {
      setSrc(null);
      return;
    }
    const url = base64ToObjectUrl(jpegBase64);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [jpegBase64]);

  return (
    <div className="pov-wrap">
      {src ? (
        <img src={src} alt="Live POV" decoding="async" />
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
        {visionStatus ? ` · ${visionStatus}` : ""}
      </div>
    </div>
  );
}
