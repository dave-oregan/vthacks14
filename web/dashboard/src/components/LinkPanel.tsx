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
};

export function LinkPanel({ linked }: { linked: boolean }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [copied, setCopied] = useState(false);

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
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <section className="panel">
      <div className="panel-title">Link iPhone · one step</div>
      <div className="stack">
        <div className="row">
          <span className="k">Status</span>
          <span className={`v ${linked ? "status-verified" : "status-verify"}`}>
            {linked ? "PHONE LINKED" : "WAITING FOR PHONE"}
          </span>
        </div>

        {!linked && (
          <>
            <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
              Same Wi‑Fi. On the phone open <strong>SIGHTLINE Link</strong>, or scan this QR to
              auto-fill the Mac address and start the relay.
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
                    <button className="btn" onClick={() => copy(info.preferredDeepLink!)}>
                      {copied ? "Copied" : "Copy deep link"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!info?.qrDataUrl && (
              <div className="det-item">Loading pairing info…</div>
            )}

            <ol style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: "0.8rem" }}>
              <li>Leave this page open</li>
              <li>Scan QR with Camera → Open in SIGHTLINE Link</li>
              <li>Or tap <em>Find Mission Control</em> on the phone</li>
            </ol>
          </>
        )}

        {linked && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.85rem" }}>
            Live relay connected. Vision + memory are running on this laptop.
          </p>
        )}
      </div>
    </section>
  );
}
