/**
 * ANS DNS publication records (ANS-3).
 *
 * Two TXT records are published per registered agent:
 *
 *   _ans.<agentHost>        "v=ans1; version=v1.0.14; p=a2a; mode=direct; url=https://agent.example.com"
 *   _ans-badge.<agentHost>  "v=ans-badge1; version=v1.0.14; url=https://transparency.ans.godaddy.com/v1/agents/<uuid>"
 *
 * Both are required; a registration without a resolvable badge is not active.
 * Spec: github.com/agentnameservice/ans-registry spec/ans-3-dns-publication.md
 */
import dns from "node:dns/promises";
import { Resolver } from "node:dns/promises";

/**
 * Some networks — hotel, conference and captive-portal DNS especially — drop or
 * rewrite queries for underscore-prefixed labels like _ans and _acme-challenge.
 * That silently turns a registered agent into an unregistered one, which is the
 * worst possible failure for a trust demo. So every lookup that comes back
 * empty on the system resolver is retried against public resolvers, and the
 * first real answer wins.
 */
const publicResolver = new Resolver();
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);

async function txtAnywhere(name: string): Promise<{ records: string[]; exists: boolean; via: string }> {
  const attempts: Array<[string, (n: string) => Promise<string[][]>]> = [
    ["system", (n) => dns.resolveTxt(n)],
    ["public", (n) => publicResolver.resolveTxt(n)],
  ];
  let sawNoData = false;
  for (const [via, fn] of attempts) {
    try {
      const chunks = await fn(name);
      const records = chunks.map((c) => c.join(""));
      if (records.length) return { records, exists: true, via };
      sawNoData = true;
    } catch (err: any) {
      if (err?.code === "ENODATA") sawNoData = true;
    }
  }
  return { records: [], exists: sawNoData, via: "none" };
}

export interface AnsEndpointRecord {
  raw: string;
  v: string;
  version: string;
  protocol?: string;
  mode?: string;
  url?: string;
}

export interface AnsBadgeRecord {
  raw: string;
  v: string;
  version: string;
  url: string;
}

export interface AnsDnsLookup {
  /** The FQDN the _ans records were actually found at. */
  host: string;
  /** The name we were asked about, before any version-label stripping. */
  queried: string;
  endpoints: AnsEndpointRecord[];
  badge: AnsBadgeRecord | null;
  /** True when at least one well-formed _ans record resolved. */
  registered: boolean;
  /** Distinguishes "name does not exist" from "name exists, no ANS records". */
  hostExists: boolean;
  error?: string;
}

/** Parse "k=v; k=v" into a map, tolerating extra whitespace and stray quotes. */
function parsePairs(txt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of txt.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    // Values may themselves contain "=" (URLs with query strings).
    out[key] = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

/**
 * Strip the ans:// scheme and return candidate hostnames to resolve.
 *
 * The spec puts the version in a record FIELD, not a DNS label, so the
 * canonical host for ans://v1.0.0.guardian.example.com is guardian.example.com.
 * We try the literal name first in case it was registered that way, then the
 * version-stripped form, and report which one actually answered.
 */
export function ansNameCandidates(ansName: string): string[] {
  let name = ansName.trim().replace(/^ans:\/\//i, "").replace(/\/+$/, "");
  const candidates = [name];
  const stripped = name.replace(/^v\d+\.\d+\.\d+\./i, "");
  if (stripped !== name) candidates.push(stripped);
  return candidates;
}

export function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}

async function txtAt(name: string): Promise<{ records: string[]; exists: boolean }> {
  const r = await txtAnywhere(name);
  if (r.records.length && r.via === "public") {
    console.warn(`[ANS] ${name} resolved only via public DNS — the local resolver is dropping underscore labels`);
  }
  return { records: r.records, exists: r.exists };
}

async function lookupHost(host: string): Promise<AnsDnsLookup> {
  const [ansTxt, badgeTxt] = await Promise.all([
    txtAt(`_ans.${host}`),
    txtAt(`_ans-badge.${host}`),
  ]);

  const endpoints: AnsEndpointRecord[] = [];
  for (const raw of ansTxt.records) {
    const p = parsePairs(raw);
    if (p.v !== "ans1" || !p.version) continue;
    endpoints.push({
      raw,
      v: p.v,
      version: p.version,
      protocol: p.p,
      mode: p.mode,
      url: p.url,
    });
  }

  let badge: AnsBadgeRecord | null = null;
  for (const raw of badgeTxt.records) {
    const p = parsePairs(raw);
    if (p.v !== "ans-badge1" || !p.url) continue;
    badge = { raw, v: p.v, version: p.version ?? "", url: p.url };
    break;
  }

  // If the apex itself resolves, the name exists even when ANS labels do not.
  let hostExists = ansTxt.exists || badgeTxt.exists || endpoints.length > 0;
  if (!hostExists) {
    for (const probe of [() => dns.lookup(host), () => publicResolver.resolve4(host)]) {
      try { await probe(); hostExists = true; break; } catch { /* try the next */ }
    }
  }

  return {
    host,
    queried: host,
    endpoints,
    badge,
    registered: endpoints.length > 0,
    hostExists,
  };
}

const cache = new Map<string, { at: number; value: AnsDnsLookup }>();
/** ANS status tokens live ~1h; 5 minutes keeps revocation meaningful. */
const TTL_MS = 5 * 60 * 1000;
/**
 * Failures expire fast. A transient resolver hiccup or a negative answer cached
 * upstream must not pin an agent to "unregistered" for five minutes — that is
 * the difference between a blip and a dead demo.
 */
const NEGATIVE_TTL_MS = 20 * 1000;

function ttlFor(value: AnsDnsLookup): number {
  return value.registered ? TTL_MS : NEGATIVE_TTL_MS;
}

/**
 * Resolve an ans:// name to its published DNS records.
 * Only the DNS lookup is cached — never an access decision, which depends on
 * the scopes being requested and must be recomputed on every call.
 */
export async function resolveAnsName(ansName: string): Promise<AnsDnsLookup> {
  const key = ansName.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlFor(hit.value)) return hit.value;

  const candidates = ansNameCandidates(ansName);
  let last: AnsDnsLookup | null = null;

  for (const host of candidates) {
    const found = await lookupHost(host);
    found.queried = candidates[0];
    if (found.registered) {
      cache.set(key, { at: Date.now(), value: found });
      return found;
    }
    // Prefer to report the candidate that at least exists in DNS.
    if (!last || (found.hostExists && !last.hostExists)) last = found;
  }

  const result = last ?? {
    host: candidates[0],
    queried: candidates[0],
    endpoints: [],
    badge: null,
    registered: false,
    hostExists: false,
  };
  cache.set(key, { at: Date.now(), value: result });
  return result;
}

export function clearAnsDnsCache(): void {
  cache.clear();
}
