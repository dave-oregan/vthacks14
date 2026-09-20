/**
 * PKI / TLS validation — the evidence behind the Possession check.
 *
 * ANS-6 defines verification tiers:
 *   Bronze — standard PKI: the endpoint presents a certificate that chains to a
 *            trusted root AND matches the hostname in the _ans record.
 *   Silver — DANE: the cert fingerprint matches a TLSA record, under DNSSEC.
 *   Gold   — transparency-log inclusion proof.
 *
 * This performs Bronze. An impostor cannot present a valid certificate for a
 * hostname it does not control, so a passing check is real evidence of key
 * possession for that name. It is NOT proof that the *caller* holds the key —
 * that needs mTLS or a DPoP proof, and we say so rather than implying otherwise.
 */
import tls from "node:tls";

/** Certificate fields can come back as string | string[]. */
function one(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export interface TlsResult {
  ok: boolean;
  tier: "bronze" | "none";
  subject?: string;
  issuer?: string;
  validTo?: string;
  /** SHA-256 of the presented certificate, hex, no separators. */
  fingerprint256?: string;
  error?: string;
}

const TIMEOUT_MS = 4000;

export function checkTls(host: string, port = 443): Promise<TlsResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: TlsResult) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(r);
    };

    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: true, timeout: TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        done({
          ok: socket.authorized,
          tier: socket.authorized ? "bronze" : "none",
          subject: one(cert?.subject?.CN),
          issuer: one(cert?.issuer?.O) ?? one(cert?.issuer?.CN),
          validTo: cert?.valid_to,
          fingerprint256: cert?.fingerprint256?.replace(/:/g, "").toLowerCase(),
          error: socket.authorized ? undefined : (socket.authorizationError as unknown as string),
        });
      },
    );

    socket.on("timeout", () => done({ ok: false, tier: "none", error: "TLS handshake timed out" }));
    socket.on("error", (err) =>
      done({ ok: false, tier: "none", error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

/** Extract a hostname from an endpoint URL, falling back to the agent host. */
export function hostFromUrl(url: string | undefined, fallback: string): { host: string; port: number } {
  if (!url) return { host: fallback, port: 443 };
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port ? Number(u.port) : 443 };
  } catch {
    return { host: fallback, port: 443 };
  }
}
