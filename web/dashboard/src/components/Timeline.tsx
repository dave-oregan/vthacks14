type Ev = { id: string; type: string; timestampMs: number; description: string };

export function Timeline({ events }: { events: Ev[] }) {
  return (
    <section className="timeline">
      <div className="timeline-title">Timeline</div>
      <div className="chips">
        {events.length === 0 && <div className="event-chip">No events yet</div>}
        {events.map((e) => (
          <div className="event-chip" key={e.id}>
            <div className="t">{e.type.replaceAll("_", " ")}</div>
            <div>{e.description}</div>
            <div style={{ color: "var(--muted)", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "0.65rem" }}>
              {new Date(e.timestampMs).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
