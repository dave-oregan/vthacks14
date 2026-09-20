import { useEffect, useState } from "react";

type LinkInfo = {
  preferredHost: string | null;
  preferredRelayUrl: string | null;
  preferredDeepLink: string | null;
  qrDataUrl: string | null;
  hosts: string[];
  relayUrls: string[];
  instructions: string[];
  port: number;
  cgnatWarning?: boolean;
  linkHostOverride?: string | null;
};

export function LinkPanel({ linked }: { linked: boolean }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/link");
        const json = (await res.json()) as LinkInfo;
        if (!cancelled) setInfo(json);
      } catch {
        /* ignore */
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <details className="panel" open={!linked}>
      <summary className="panel-title">Link iPhone · one step</summary>
      <div className="stack">
        <div className="row">
          <span className="k">Status</span>
          <span className={`v ${linked ? "status-verified" : "status-verify"}`}>
            {linked ? "PHONE LINKED" : "WAITING FOR PHONE"}
          </span>
        </div>

        {!linked && (
          <>
            {info?.cgnatWarning && (
              <div className="det-item" style={{ borderColor: "var(--warn)", color: "var(--ink-soft)" }}>
                <strong style={{ color: "var(--warn)" }}>Network tip</strong>
                <div style={{ marginTop: 6, fontSize: "0.8rem", lineHeight: 1.45 }}>
                  Mac IP is <code>{info.preferredHost}</code> (100.64 CGNAT). Venue Wi‑Fi often
                  blocks phone↔laptop. Use <strong>iPhone Personal Hotspot</strong>: join from Mac,
                  restart the server, rescan QR.
                </div>
              </div>
            )}

            <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
              Same network as this Mac. Open <strong>SIGHTLINE Link</strong> and scan the QR to
              auto-fill the address and start the relay.
            </p>

            {info?.qrDataUrl && (
              <div className="link-qr-row">
                <img
                  className="link-qr"
                  src={info.qrDataUrl}
                  alt="Pairing QR"
                  width={148}
                  height={148}
                />
                <div className="link-qr-meta">
                  <div className="row">
                    <span className="k">Mac IP</span>
                    <span className="v">{info.preferredHost ?? "—"}</span>
                  </div>
                  <div className="row">
                    <span className="k">Relay</span>
                    <span className="v" style={{ wordBreak: "break-all" }}>
                      {info.preferredRelayUrl ?? "—"}
                    </span>
                  </div>
                  {info.preferredDeepLink && (
                    <button
                      className="btn"
                      onClick={() => copy(info.preferredDeepLink!, "link")}
                    >
                      {copied === "link" ? "Copied" : "Copy deep link"}
                    </button>
                  )}
                  {info.preferredHost && (
                    <button
                      className="btn"
                      onClick={() => copy(info.preferredHost!, "ip")}
                    >
                      {copied === "ip" ? "Copied" : "Copy IP"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!info?.qrDataUrl && (
              <div className="det-item">Loading pairing info…</div>
            )}

            <ol style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: "0.8rem" }}>
              {(info?.instructions?.length
                ? info.instructions
                : [
                    "Leave this page open",
                    "Scan QR with Camera → Open in SIGHTLINE Link",
                    "Or tap Find Mission Control on the phone",
                  ]
              ).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </>
        )}

        {linked && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
            Live relay connected. Vision + memory are running on this laptop.
          </p>
        )}
      </div>
    </details>
  );
}
