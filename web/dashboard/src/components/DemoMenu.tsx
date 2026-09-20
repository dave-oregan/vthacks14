import { useEffect, useId, useRef, useState } from "react";

export function DemoMenu({
  busy,
  onFall,
  onCrash,
  onReset,
  onInject,
  showGuardianInject,
}: {
  busy: boolean;
  onFall: () => void;
  onCrash: () => void;
  onReset: () => void;
  onInject: (scenario: string) => void;
  showGuardianInject: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="demo-menu" ref={rootRef}>
      <button
        type="button"
        className="btn btn--ghost"
        aria-expanded={open}
        aria-controls={id}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        Demo
      </button>
      {open && (
        <div className="demo-popover" id={id} role="menu" aria-label="Demo controls">
          <div className="demo-popover-head">
            <strong>Demo controls</strong>
            <span className="demo-badge">DEMO</span>
          </div>
          <p className="demo-popover-note">No real emergency call will be placed.</p>
          <button type="button" role="menuitem" className="demo-item" disabled={busy} onClick={() => { onFall(); setOpen(false); }}>
            Simulate fall
          </button>
          <button type="button" role="menuitem" className="demo-item" disabled={busy} onClick={() => { onCrash(); setOpen(false); }}>
            Simulate crash
          </button>
          {showGuardianInject && (
            <>
              <div className="demo-divider" />
              {(
                [
                  ["plate", "Inject plate"],
                  ["aed", "Inject AED"],
                  ["extinguisher", "Inject extinguisher"],
                  ["firearm", "Inject firearm (training)"],
                  ["distress", "Inject distress"],
                  ["address", "Inject address"],
                ] as const
              ).map(([sid, label]) => (
                <button
                  key={sid}
                  type="button"
                  role="menuitem"
                  className="demo-item"
                  disabled={busy}
                  onClick={() => {
                    onInject(sid);
                    setOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </>
          )}
          <div className="demo-divider" />
          <button type="button" role="menuitem" className="demo-item" disabled={busy} onClick={() => { onReset(); setOpen(false); }}>
            Reset demo
          </button>
        </div>
      )}
    </div>
  );
}
