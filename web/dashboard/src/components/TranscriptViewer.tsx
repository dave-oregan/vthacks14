import { useEffect, useState } from "react";

export type TranscriptLine = {
  _id?: string;
  id?: string;
  direction: string;
  text: string;
  timestampMs: number;
  source?: string | null;
  context?: string | null;
};

export function TranscriptViewer({
  open,
  liveLines,
  onClose,
}: {
  open: boolean;
  /** In-session lines from dashboard state (newest first preferred). */
  liveLines?: TranscriptLine[];
  onClose: () => void;
}) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "heard" | "asked" | "spoken">("all");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const q =
          filter === "all" ? "" : `?direction=${encodeURIComponent(filter)}&limit=200`;
        const res = await fetch(`/api/mongo/transcripts${q || "?limit=200"}`);
        const data = (await res.json()) as { transcripts?: TranscriptLine[] };
        if (!cancelled) setLines(data.transcripts ?? []);
      } catch {
        if (!cancelled) setLines([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, filter]);

  if (!open) return null;

  // Merge live + mongo (live first for freshness), de-dupe by text+time.
  const merged = mergeLines(liveLines ?? [], lines);
  const shown =
    filter === "all" ? merged : merged.filter((l) => l.direction === filter);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal transcript-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="panel-title" style={{ border: 0, padding: 0 }}>
              Live transcript
            </div>
            <div className="modal-sub">
              Overheard speech, recall questions, and spoken replies — scrolling history
            </div>
          </div>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="transcript-filters">
          {(["all", "heard", "asked", "spoken"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn ${filter === f ? "primary" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="modal-list transcript-list">
          {loading && shown.length === 0 && <div className="det-item">Loading…</div>}
          {!loading && shown.length === 0 && (
            <div className="det-item">No transcript lines yet — speak near the linked phone mic.</div>
          )}
          {shown.map((l, i) => (
            <article
              key={String(l._id ?? l.id ?? `${l.timestampMs}-${i}`)}
              className={`transcript-line transcript-line--${l.direction}`}
            >
              <div className="transcript-line-meta">
                <span className="transcript-dir">{l.direction}</span>
                <span>{new Date(l.timestampMs).toLocaleString()}</span>
                {l.source ? <span>{l.source}</span> : null}
              </div>
              <p>{l.text}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function mergeLines(live: TranscriptLine[], mongo: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const seen = new Set<string>();
  for (const l of [...live, ...mongo]) {
    const key = `${l.direction}|${l.timestampMs}|${(l.text || "").slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  out.sort((a, b) => b.timestampMs - a.timestampMs);
  return out;
}
