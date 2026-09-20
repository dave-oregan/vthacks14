/**
 * Transparency-log badge fetch — the evidence behind the Standing check.
 *
 * The _ans-badge record points at a signed receipt, e.g.
 *   https://transparency.ans.godaddy.com/v1/agents/<uuid>
 *
 * Shape (schemaVersion "V1"):
 *   { schemaVersion, payload: { logId, producer, status, ... },
 *     merkleProof: { leafHash, leafIndex, path, rootHash, rootSignature, treeSize, treeVersion },
 *     signature }
 *
 * We read payload.status and record whether an inclusion proof is present.
 * We do NOT verify the ES256 signature or walk the Merkle path — that needs the
 * log's public key, which we do not have. That limit is reported, not hidden.
 */

export interface BadgeResult {
  ok: boolean;
  status: string | null;
  /** True when the receipt carries a Merkle inclusion proof. */
  hasInclusionProof: boolean;
  /** True when the receipt carries a detached signature we did not verify. */
  hasSignature: boolean;
  /** SHA-256 of the server certificate the receipt attests, hex, no prefix. */
  attestedServerCert?: string;
  /** How the registry validated domain control, e.g. "ACME-DNS-01". */
  domainValidation?: string;
  treeSize?: number;
  logId?: string;
  error?: string;
}

const TIMEOUT_MS = 4000;

export async function fetchBadge(url: string): Promise<BadgeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        status: null,
        hasInclusionProof: false,
        hasSignature: false,
        error: `transparency log returned ${res.status}`,
      };
    }
    const body: any = await res.json();
    const payload = body?.payload ?? {};
    const proof = body?.merkleProof ?? null;

    // `status` sits at the TOP level of the receipt, beside schemaVersion and
    // signature — not inside `payload`. Accept either, newest schema first.
    const rawStatus = body?.status ?? payload?.status;
    const status = typeof rawStatus === "string" ? rawStatus : null;

    // The receipt also attests which certificate belongs to this agent. That
    // lets us cross-check the TLSA record in DNS against a signed statement
    // from the log — two independent channels that must agree.
    const attest = payload?.producer?.event?.attestations ?? {};
    const certFp: unknown = attest?.serverCert?.fingerprint;
    const attestedServerCert =
      typeof certFp === "string" ? certFp.replace(/^SHA256:/i, "").toLowerCase() : undefined;

    return {
      ok: status === "ACTIVE",
      status,
      hasInclusionProof: Boolean(proof?.leafHash && proof?.rootHash),
      hasSignature: typeof body?.signature === "string" && body.signature.length > 0,
      treeSize: typeof proof?.treeSize === "number" ? proof.treeSize : undefined,
      logId: typeof payload.logId === "string" ? payload.logId : undefined,
      attestedServerCert,
      domainValidation:
        typeof attest?.domainValidation === "string" ? attest.domainValidation : undefined,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: null,
      hasInclusionProof: false,
      hasSignature: false,
      error: err?.name === "AbortError" ? "transparency log timed out" : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}
