import { useEffect, useRef, useState } from "react";

type Detection = {
  trackId: string;
  displayName: string;
  label?: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
};

type Letterbox = { left: number; top: number; width: number; height: number };

function base64ToObjectUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

function computeLetterbox(
  wrapW: number,
  wrapH: number,
  natW: number,
  natH: number,
): Letterbox {
  if (wrapW <= 0 || wrapH <= 0 || natW <= 0 || natH <= 0) {
    return { left: 0, top: 0, width: wrapW || 1, height: wrapH || 1 };
  }
  const scale = Math.min(wrapW / natW, wrapH / natH);
  const width = natW * scale;
  const height = natH * scale;
  return {
    left: (wrapW - width) / 2,
    top: (wrapH - height) / 2,
    width,
    height,
  };
}

export function LivePOV({
  jpegBase64,
  detections,
  source,
  visionStatus,
  variant = "live",
  highlightLabel,
  emptyTitle,
  emptyHint,
  onConnectClick,
  rewinding = false,
  statusLine,
}: {
  jpegBase64: string | null;
  detections: Detection[];
  source?: string;
  visionStatus?: string;
  variant?: "live" | "recall" | "guardian";
  highlightLabel?: string | null;
  emptyTitle?: string;
  emptyHint?: string;
  onConnectClick?: () => void;
  rewinding?: boolean;
  statusLine?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [box, setBox] = useState<Letterbox>({ left: 0, top: 0, width: 1, height: 1 });

  useEffect(() => {
    if (!jpegBase64) {
      setSrc(null);
      return;
    }
    if (
      jpegBase64.startsWith("data:") ||
      jpegBase64.startsWith("blob:") ||
      jpegBase64.startsWith("http")
    ) {
      setSrc(jpegBase64);
      return;
    }
    const url = base64ToObjectUrl(jpegBase64);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [jpegBase64]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const sync = () => {
      const img = imgRef.current;
      if (!img?.naturalWidth) return;
      setBox(
        computeLetterbox(wrap.clientWidth, wrap.clientHeight, img.naturalWidth, img.naturalHeight),
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [src]);

  const showBoxes = variant !== "recall" || Boolean(highlightLabel);
  const filtered =
    variant === "recall" && highlightLabel
      ? detections.filter((d) =>
          `${d.displayName} ${d.label ?? ""}`.toLowerCase().includes(highlightLabel.toLowerCase()),
        )
      : detections;

  const bottom =
    statusLine ??
    (src
      ? filtered.length === 0
        ? variant === "recall"
          ? "Remembered moment"
          : "No objects detected"
        : `${filtered.length} object${filtered.length === 1 ? "" : "s"}`
      : null);

  return (
    <div
      className={`pov-wrap${rewinding ? " pov-wrap--rewind" : ""}${variant === "recall" ? " pov-wrap--recall" : ""}`}
      ref={wrapRef}
    >
      <div className="sightline-scan" aria-hidden="true" />
      {src ? (
        <img
          ref={imgRef}
          src={src}
          alt={variant === "recall" ? "Remembered moment" : "Live camera"}
          decoding="async"
          onLoad={() => {
            const wrap = wrapRef.current;
            const img = imgRef.current;
            if (!wrap || !img) return;
            setBox(
              computeLetterbox(
                wrap.clientWidth,
                wrap.clientHeight,
                img.naturalWidth,
                img.naturalHeight,
              ),
            );
          }}
        />
      ) : (
        <div className="pov-empty">
          <div className="pov-reticle" aria-hidden="true">
            <span />
            <span />
          </div>
          <p className="pov-empty-title">
            {emptyTitle ?? "Connect a camera to begin seeing"}
          </p>
          <p className="pov-empty-hint">
            {emptyHint ?? "Your existing memories remain searchable."}
          </p>
          {onConnectClick && (
            <button type="button" className="btn primary" onClick={onConnectClick}>
              Connect iPhone
            </button>
          )}
        </div>
      )}

      {showBoxes &&
        filtered.map((d, i) => {
          const emphasize =
            !highlightLabel ||
            `${d.displayName} ${d.label ?? ""}`.toLowerCase().includes(highlightLabel.toLowerCase());
          return (
            <div
              key={`${d.trackId}-${i}`}
              className={`overlay-box${emphasize ? " overlay-box--focus" : " overlay-box--dim"}`}
              style={{
                left: box.left + d.bbox.x * box.width,
                top: box.top + d.bbox.y * box.height,
                width: Math.max(2, d.bbox.width * box.width),
                height: Math.max(2, d.bbox.height * box.height),
              }}
            >
              <div className="overlay-label">
                {d.displayName}
                {emphasize ? ` · ${Math.round(d.confidence * 100)}%` : ""}
              </div>
            </div>
          );
        })}

      {bottom && (
        <div className="pov-status" aria-live="polite">
          {bottom}
          {source && variant === "live" ? ` · ${source}` : ""}
          {visionStatus && variant === "live" && visionStatus !== "ready"
            ? ` · ${visionStatus}`
            : ""}
        </div>
      )}
    </div>
  );
}
