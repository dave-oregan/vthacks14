import type { AppMode } from "../lib/format";

export function ModeTabs({
  mode,
  onChange,
}: {
  mode: AppMode;
  onChange: (m: AppMode) => void;
}) {
  const tabs: { id: AppMode; label: string; hint: string }[] = [
    { id: "live", label: "Live", hint: "See through your phone" },
    { id: "recall", label: "Recall", hint: "Search what you saw" },
    { id: "guardian", label: "Guardian", hint: "Safety monitoring" },
  ];

  return (
    <nav className="mode-tabs" role="tablist" aria-label="SIGHTLINE modes">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={mode === t.id}
          className={`mode-tab${mode === t.id ? " mode-tab--active" : ""}`}
          title={t.hint}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
