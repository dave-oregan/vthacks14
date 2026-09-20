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

export function PhoneConnectionCard({
  linked,
  compact,
  focusConnect,
}: {
  linked: boolean;
  compact?: boolean;
  focusConnect?: boolean;
}) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [trouble, setTrouble] = useState(false);
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

  useEffect(() => {
    if (focusConnect && !linked) setTrouble(false);
  }, [focusConnect, linked]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  }

  if (linked && compact) {
    return (
      <div className="phone-card phone-card--linked">
        <div className="phone-card-head">
          <span className="conn-dot conn-dot--ok" aria-hidden="true" />
          <div>
            <strong>Phone connected</strong>
            <p>iPhone · Camera streaming</p>
          </div>
        </div>
      </div>
    );
  }

  if (linked) {
    return (
      <div className="phone-card phone-card--linked">
        <div className="phone-card-head">
          <span className="conn-dot conn-dot--ok" aria-hidden="true" />
          <div>
            <strong>Phone connected</strong>
            <p>Live vision and memory are running on this laptop.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`phone-card${focusConnect ? " phone-card--focus" : ""}`}>
      <div className="phone-card-head">
        <strong>Connect your camera</strong>
        <p>Three steps to start seeing the physical world.</p>
      </div>

      <ol className="phone-steps">
        <li>Open SIGHTLINE Link on your iPhone</li>
        <li>Scan this QR code</li>
        <li>You’re connected</li>
      </ol>

      {info?.qrDataUrl ? (
        <img className="phone-qr" src={info.qrDataUrl} alt="Pairing QR code" width={168} height={168} />
      ) : (
        <div className="phone-qr phone-qr--loading">Loading QR…</div>
      )}

      <button
        type="button"
        className="btn btn--ghost phone-trouble-toggle"
        aria-expanded={trouble}
        onClick={() => setTrouble((v) => !v)}
      >
        {trouble ? "Hide troubleshooting" : "Having trouble connecting?"}
      </button>

      {trouble && (
        <div className="phone-trouble">
          {info?.cgnatWarning && (
            <p className="phone-warn">
              This Mac IP looks like CGNAT ({info.preferredHost}). Venue Wi‑Fi often blocks
              phone↔laptop — try joining the Mac to your iPhone Personal Hotspot, restart the
              server, then rescan.
            </p>
          )}
          <div className="phone-trouble-row">
            <span>Mac IP</span>
            <code>{info?.preferredHost ?? "—"}</code>
          </div>
          <div className="phone-trouble-row">
            <span>Relay</span>
            <code>{info?.preferredRelayUrl ?? "—"}</code>
          </div>
          <div className="phone-trouble-actions">
            {info?.preferredHost && (
              <button type="button" className="btn" onClick={() => copy(info.preferredHost!, "ip")}>
                {copied === "ip" ? "Copied" : "Copy IP"}
              </button>
            )}
            {info?.preferredDeepLink && (
              <button
                type="button"
                className="btn"
                onClick={() => copy(info.preferredDeepLink!, "link")}
              >
                {copied === "link" ? "Copied" : "Copy deep link"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** @deprecated Prefer PhoneConnectionCard — kept for import compatibility */
export { PhoneConnectionCard as LinkPanel };
