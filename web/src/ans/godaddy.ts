/**
 * ANS identity verification.
 *
 * Four checks, four independent sources of evidence. Nothing here flips more
 * than one check, which is the whole point: an agent can fail verification in
 * four distinct ways and the modal shows which one.
 *
 *   Identity      _ans.<host> TXT resolves and parses      (ANS-3, DNS)
 *   Standing      transparency-log receipt says ACTIVE     (ANS-3, HTTPS)
 *   Possession    endpoint presents a valid cert for its name (ANS-6 bronze)
 *   Authorization requested scopes are within our policy    (ours to define)
 *
 * Spec: github.com/agentnameservice/ans-registry
 */
import { config } from "../config.js";
import type { AnsCheck } from "../shared/types.js";
import { resolveAnsName, registrableDomain } from "./dns.js";
import { fetchBadge } from "./badge.js";
import { checkTls, hostFromUrl } from "./tls.js";
import { lookupTlsa, tlsaMatches } from "./tlsa.js";
import { authorize } from "./scopes.js";

export interface AnsVerificationResult {
  isFullyVerified: boolean;
  status: "verified" | "blocked" | "PENDING VALIDATION";
  checks: AnsCheck[];
  /** Highest PKI assurance tier evidenced for the endpoint (ANS-6). */
  assuranceTier: "silver" | "bronze" | "none";
  host: string;
}

function baseChecks(): AnsCheck[] {
  return [
    {
      name: "Identity",
      question: "Is this name genuinely registered?",
      mechanism: "_ans TXT record published in DNS",
      passed: false,
    },
    {
      name: "Standing",
      question: "Is it still in good standing?",
      mechanism: "Signed transparency-log receipt, re-checked every 5 min",
      passed: false,
    },
    {
      name: "Possession",
      question: "Does the endpoint hold the key for this name?",
      mechanism: "TLS chain + hostname, checked against the published TLSA binding (ANS-6)",
      passed: false,
    },
    {
      name: "Authorization",
      question: "May it have this data?",
      mechanism: "SIGHTLINE scope policy",
      passed: false,
    },
  ];
}

export async function verifyAnsIdentity(
  ansName: string,
  requestedScopes: string[] = [],
): Promise<AnsVerificationResult> {
  const checks = baseChecks();
  const [identity, standing, possession, authorization] = checks;

  // ---- Authorization is independent of DNS and always evaluated. ----------
  const scope = authorize(ansName, requestedScopes);
  authorization.passed = scope.allowed;
  authorization.detail = scope.reason;

  // ---- Identity: does the agent have a published _ans record? -------------
  const lookup = await resolveAnsName(ansName);

  if (!lookup.hostExists) {
    identity.detail = `${lookup.host} does not resolve — no such name`;
    console.log(`[ANS] ${ansName} -> blocked (name does not resolve)`);
    return {
      isFullyVerified: false,
      status: "blocked",
      checks,
      assuranceTier: "none",
      host: lookup.host,
    };
  }

  if (!lookup.registered) {
    identity.detail = `${lookup.host} resolves but publishes no _ans record`;
    standing.detail = "no registration to check";
    possession.detail = "not checked — agent is not registered";
    console.log(`[ANS] ${ansName} -> PENDING VALIDATION (no _ans record)`);
    return {
      isFullyVerified: false,
      status: "PENDING VALIDATION",
      checks,
      assuranceTier: "none",
      host: lookup.host,
    };
  }

  const endpoint = lookup.endpoints[0];
  identity.passed = true;
  identity.detail =
    `_ans.${lookup.host} -> ${endpoint.version}` +
    (endpoint.protocol ? ` (${endpoint.protocol})` : "") +
    (registrableDomain(lookup.host) === config.ansTeamDomain ? " · our namespace" : " · third-party");

  // ---- Standing: the badge must resolve AND the receipt must say ACTIVE ----
  let badgeResult: Awaited<ReturnType<typeof fetchBadge>> | null = null;
  if (!lookup.badge) {
    standing.detail = "no _ans-badge record — registration is not active";
  } else {
    const badge = await fetchBadge(lookup.badge.url);
    badgeResult = badge;
    standing.passed = badge.ok;
    if (badge.error) {
      standing.detail = badge.error;
    } else {
      const proof = badge.hasInclusionProof
        ? `, inclusion proof present${badge.treeSize ? ` (log size ${badge.treeSize})` : ""}`
        : "";
      standing.detail = `transparency log: ${badge.status ?? "unknown"}${proof}`;
      if (badge.hasSignature) {
        standing.detail += " · receipt signature not verified (log public key unavailable)";
      }
    }
  }

  // ---- Possession: PKI against the endpoint, plus the DANE binding --------
  const { host: tlsHost, port } = hostFromUrl(endpoint.url, lookup.host);
  const [tlsResult, tlsaRecords] = await Promise.all([
    checkTls(tlsHost, port),
    lookupTlsa(tlsHost, port),
  ]);

  const daneMatch =
    tlsResult.ok &&
    Boolean(tlsResult.fingerprint256) &&
    tlsaMatches(tlsaRecords, tlsResult.fingerprint256!);

  let tier: "silver" | "bronze" | "none" = "none";

  if (daneMatch) {
    // The live certificate is the exact one the registry bound to this name.
    tier = "silver";
    possession.passed = true;
    possession.detail =
      `valid cert for ${tlsHost}, SHA-256 matches the TLSA binding published by the registry` +
      ` · silver tier (DANE); caller-side proof would still need mTLS or DPoP`;
  } else if (tlsResult.ok) {
    tier = "bronze";
    possession.passed = true;
    possession.detail =
      `valid cert for ${tlsHost}` +
      (tlsResult.issuer ? `, issued by ${tlsResult.issuer}` : "") +
      (tlsaRecords.length ? ", but it does not match the published TLSA binding" : "") +
      ` · bronze tier; caller-side proof would need mTLS or DPoP`;
  } else if (tlsaRecords.length) {
    // No live endpoint. But we have two independent published statements about
    // which certificate belongs to this name: the TLSA record in DNS, and the
    // serverCert attested inside the signed transparency receipt. If those
    // agree, the binding is corroborated across two channels — which is real,
    // checkable evidence. It still is not proof the CALLER holds the key, so
    // the check does not pass and no tier is claimed.
    const r = tlsaRecords[0];
    const attested = badgeResult?.attestedServerCert;
    const corroborated = Boolean(attested && tlsaMatches(tlsaRecords, attested));
    possession.detail = corroborated
      ? `TLSA binding in DNS matches the server certificate attested in the signed ` +
        `transparency receipt (sha256 ${r.data.slice(0, 12)}…)` +
        (badgeResult?.domainValidation ? `, domain validated by ${badgeResult.domainValidation}` : "") +
        ` — but no handshake: endpoint not publicly hosted`
      : `certificate binding published in DNS (TLSA ${r.usage} ${r.selector} ${r.matchingType}, ` +
        `sha256 ${r.data.slice(0, 12)}…) but no handshake: ${tlsResult.error ?? "endpoint unreachable"}`;
  } else {
    possession.detail = `no certificate evidence for ${tlsHost}: ${tlsResult.error ?? "handshake failed"}`;
  }

  /*
   * Gate on Identity, Standing and Authorization.
   *
   * Possession as implemented proves the ENDPOINT controls its name — it does
   * not prove the CALLER holds the key, which needs mTLS or a DPoP proof we do
   * not yet implement. So it raises the assurance tier we report rather than
   * acting as a gate, and we label it that way instead of pretending otherwise.
   */
  const isFullyVerified = identity.passed && standing.passed && authorization.passed;

  console.log(
    `[ANS] ${ansName} -> ${isFullyVerified ? "verified" : "blocked"} ` +
      `[identity=${identity.passed} standing=${standing.passed} ` +
      `possession=${possession.passed} authz=${authorization.passed}]`,
  );

  return {
    isFullyVerified,
    status: isFullyVerified ? "verified" : "blocked",
    checks,
    assuranceTier: tier,
    host: lookup.host,
  };
}
