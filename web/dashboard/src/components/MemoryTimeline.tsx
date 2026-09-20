import { relativeTime } from "../lib/format";

export type MemoryReelItem = {
  id: string;
  kind: "object" | "safety" | "system";
  label: string;
  timestampMs: number;
  thumbBase64?: string | null;
  selected?: boolean;
};

export function MemoryTimeline({
  items,
  selectedId,
  onSelect,
  scrubbing,
}: {
  items: MemoryReelItem[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  scrubbing?: boolean;
}) {
  const visible = items.filter((i) => i.kind !== "system").slice(0, 40);

  return (
    <section className={`memory-reel${scrubbing ? " memory-reel--scrub" : ""}`} aria-label="Visual memory timeline">
      <div className="memory-reel-head">
        <span className="memory-reel-title">Memory</span>
        <span className="memory-reel-sub">Filmstrip of what SIGHTLINE has seen</span>
      </div>
      <div className="memory-reel-track">
        {visible.length === 0 && (
          <div className="memory-reel-empty">Memories appear here as objects are seen</div>
        )}
        {visible.map((item) => {
          const active = item.id === selectedId || item.selected;
          return (
            <button
              key={item.id}
              type="button"
              className={`memory-frame${active ? " memory-frame--active" : ""}${item.kind === "safety" ? " memory-frame--safety" : ""}`}
              onClick={() => onSelect?.(item.id)}
            >
              {item.thumbBase64 ? (
                <img src={`data:image/jpeg;base64,${item.thumbBase64}`} alt="" />
              ) : (
                <div className="memory-frame-fallback" aria-hidden="true" />
              )}
              <span className="memory-frame-label">{item.label}</span>
              <span className="memory-frame-time">{relativeTime(item.timestampMs)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
