"use client";

import { useEffect, useState } from "react";

const LINES: Array<[string, string, boolean?]> = [
  ["MEMORY PATTERNS", "FOUND"],
  ["RISK TOLERANCE", "QUESTIONABLE", true],
  ["OBJECT PERMANENCE", "INCONCLUSIVE"],
  ["CHAOS LEVEL", "CALCULATING", true],
  ["SOCIAL BATTERY", "DEGRADED"],
  ["SELECTING SIDEKICK", "…"],
];

export default function Analyzing() {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= LINES.length) return;
    const t = setTimeout(() => setShown((s) => s + 1), 420);
    return () => clearTimeout(t);
  }, [shown]);

  // Once all lines are shown, keep cycling dots on the last line while we wait.
  const [dots, setDots] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d + 1) % 4), 380);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="analyzing">
      <div className="scan-frame">
        <div className="scanline" />
        <div className="analyzing-title">
          ANALYZING HUMAN{".".repeat(dots)}
        </div>
      </div>
      <div className="status-lines">
        {LINES.slice(0, shown).map(([label, val, warn], i) => (
          <div className="status-line" key={label}>
            <span>
              {label}
              {" "}
              <span style={{ color: "var(--muted)" }}>
                {".".repeat(Math.max(2, 30 - label.length))}
              </span>
            </span>
            <span className={`val ${warn ? "warn" : ""}`}>
              {i === LINES.length - 1 ? `PENDING${".".repeat(dots)}` : val}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
