"use client";

import type { Tone } from "@/lib/types";

export default function ToneToggle({
  tone,
  onChange,
}: {
  tone: Tone;
  onChange: (t: Tone) => void;
}) {
  return (
    <div className="tone-toggle" role="group" aria-label="Diagnosis tone">
      <button
        type="button"
        className={tone === "nice" ? "active" : ""}
        onClick={() => onChange("nice")}
      >
        BE NICE
      </button>
      <button
        type="button"
        className={tone === "roast" ? "active" : ""}
        onClick={() => onChange("roast")}
      >
        ROAST ME
      </button>
    </div>
  );
}
