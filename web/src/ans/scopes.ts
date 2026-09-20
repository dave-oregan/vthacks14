/**
 * Authorization policy — the one ANS check that is ours to define.
 *
 * ANS answers "is this agent who it claims to be, and is it in good standing".
 * It deliberately does NOT answer "may this agent have THIS data". That is a
 * relying-party decision, and this file is SIGHTLINE's answer to it.
 */

/** Scopes each agent role is permitted to request. */
const POLICY: Record<string, string[]> = {
  // Scope names must match what callers actually request — see
  // api/routes.ts (/memory/context, /ans/verify) and app.ts.
  observer: ["memory.read"],
  memory: ["memory.read", "memory.write"],
  reasoner: ["memory.read", "vision.describe"],
  guardian: ["memory.read", "camera.read", "location", "telemetry.fall"],
  action: ["notify.sms"],
};

/** Scopes no agent may hold — refused regardless of identity. */
const NEVER_GRANTED = ["location.precise", "memory.export", "identity.impersonate"];

export interface ScopeDecision {
  allowed: boolean;
  role: string | null;
  granted: string[];
  denied: string[];
  reason: string;
}

/**
 * Extract the agent role from an ANS name.
 * ans://v1.0.0.guardian.example.com -> "guardian"
 * ans://guardian.example.com        -> "guardian"
 */
export function roleFromAnsName(ansName: string): string | null {
  const bare = ansName.trim().replace(/^ans:\/\//i, "").replace(/\/+$/, "");
  const labels = bare.split(".").filter(Boolean);
  // Drop a leading vX.Y.Z version label if present.
  const start = /^v\d+\.\d+\.\d+$/i.test(labels[0] ?? "") ? 1 : 0;
  // Everything before the registrable domain (last two labels) is the agent path.
  const agentLabels = labels.slice(start, Math.max(start, labels.length - 2));
  return agentLabels.length ? agentLabels[agentLabels.length - 1].toLowerCase() : null;
}

export function authorize(ansName: string, requestedScopes: string[]): ScopeDecision {
  const role = roleFromAnsName(ansName);

  if (!role || !(role in POLICY)) {
    return {
      allowed: false,
      role,
      granted: [],
      denied: requestedScopes,
      reason: role ? `no scope policy for role "${role}"` : "could not derive a role from the name",
    };
  }

  if (requestedScopes.length === 0) {
    return { allowed: false, role, granted: [], denied: [], reason: "no scopes requested" };
  }

  const allowlist = POLICY[role];
  const granted: string[] = [];
  const denied: string[] = [];

  for (const scope of requestedScopes) {
    const s = scope.trim();
    if (NEVER_GRANTED.includes(s)) denied.push(s);
    else if (allowlist.includes(s)) granted.push(s);
    else denied.push(s);
  }

  return {
    allowed: denied.length === 0,
    role,
    granted,
    denied,
    reason: denied.length === 0
      ? `all requested scopes within policy for "${role}"`
      : `outside policy for "${role}": ${denied.join(", ")}`,
  };
}

export function policyFor(role: string): string[] {
  return POLICY[role] ?? [];
}
