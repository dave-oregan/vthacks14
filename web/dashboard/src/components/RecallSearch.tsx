import { RECALL_EXAMPLES } from "./recallExamples";

export function RecallSearch({
  query,
  busy,
  onChange,
  onSubmit,
}: {
  query: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="recall-search">
      <label className="recall-search-label" htmlFor="recall-q">
        What are you looking for?
      </label>
      <div className="recall-search-row">
        <input
          id="recall-q"
          type="search"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="Where is my black laptop?"
          autoComplete="off"
        />
        <button type="button" className="btn primary" disabled={busy} onClick={onSubmit}>
          {busy ? "Searching…" : "Recall"}
        </button>
      </div>
      <div className="recall-examples" aria-label="Example queries">
        {RECALL_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className="recall-chip"
            onClick={() => {
              onChange(ex);
            }}
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

export { RECALL_EXAMPLES };
