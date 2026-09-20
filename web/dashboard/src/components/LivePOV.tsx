import { useEffect, useRef, useState } from "react";

type Detection = {
  trackId: string;
  displayName: string;
  label?: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
};

const BOX_COLORS = ["#5eead4", "#38bdf8", "#fb7185", "#a3e635", "#fbbf24", "#c4b5fd"];

type Letterbox = { left: number; top: number; width: number; height: number };

function base64ToObjectUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

/** Map normalized bboxes onto the letterboxed image inside object-fit:contain. */
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
}: {
  jpegBase64: string | null;
  detections: Detection[];
  source?: string;
  visionStatus?: string;
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

  return (
    <div className="pov-wrap" ref={wrapRef}>
      {src ? (
        <img
          ref={imgRef}
          src={src}
          alt="Live POV"
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
              left: box.left + d.bbox.x * box.width,
              top: box.top + d.bbox.y * box.height,
              width: Math.max(2, d.bbox.width * box.width),
              height: Math.max(2, d.bbox.height * box.height),
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
