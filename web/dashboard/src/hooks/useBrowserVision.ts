import { useEffect, useRef, useState } from "react";
import { detectInBrowser, type BrowserDetection } from "../vision/cocoBrowser";

/**
 * Run COCO-SSD in the browser on each live JPEG (meow-style webcam loop).
 * Never stacks detects; reports to the laptop for memory.
 */
export function useBrowserVision(
  jpegBase64: string | null,
  opts?: { enabled?: boolean; report?: boolean },
) {
  const enabled = opts?.enabled !== false;
  const report = opts?.report !== false;
  const [detections, setDetections] = useState<BrowserDetection[]>([]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("idle");
  const genRef = useRef(0);
  const lastReportRef = useRef(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const readyRef = useRef(false);

  useEffect(() => {
    if (!enabled || !jpegBase64) return;
    const gen = ++genRef.current;

    (async () => {
      try {
        setStatus(readyRef.current ? "detecting" : "loading model…");
        if (!imgRef.current) imgRef.current = new Image();
        const img = imgRef.current;
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("frame decode failed"));
          img.src = `data:image/jpeg;base64,${jpegBase64}`;
        });
        if (gen !== genRef.current) return;
        const dets = await detectInBrowser(img);
        if (gen !== genRef.current) return;
        setDetections(dets);
        readyRef.current = true;
        setReady(true);
        setStatus(`${dets.length} obj`);

        const now = Date.now();
        if (report && now - lastReportRef.current > 700) {
          lastReportRef.current = now;
          void fetch("/api/vision/report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ detections: dets, timestampMs: now }),
          }).catch(() => undefined);
        }
      } catch (err) {
        if (gen === genRef.current) {
          setStatus(err instanceof Error ? err.message : "vision error");
        }
      }
    })();
  }, [jpegBase64, enabled, report]);

  return { detections, ready, status };
}
