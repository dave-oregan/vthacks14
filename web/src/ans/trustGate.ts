import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import type { AgentAccessRequest } from "../shared/types.js";
import type { MemoryStore } from "../memory/store.js";
import { verifyAnsIdentity } from "./godaddy.js";

export function listDemoAgents() {
  return [
    {
      id: "observer",
      name: "Observer",
      ans: `ans://v1.0.0.observer.${config.ansTeamDomain}`,
      state: "IDENTITY VERIFIED" as const,
    },
    {
      id: "memory",
      name: "Memory",
      ans: `ans://v1.0.0.memory.${config.ansTeamDomain}`,
      state: "IDENTITY VERIFIED" as const,
    },
    {
      id: "reasoner",
      name: "Reasoner",
      ans: `ans://v1.0.0.reasoner.${config.ansTeamDomain}`,
      state: "STANDBY" as const,
    },
    {
      id: "guardian",
      name: "Guardian",
      ans: `ans://v1.0.0.guardian.${config.ansTeamDomain}`,
      state: "STANDBY" as const,
    },
    {
      id: "action",
      name: "Action",
      ans: `ans://v1.0.0.action.${config.ansTeamDomain}`,
      state: "STANDBY" as const,
    },
  ];
}

export async function verifyAgentAccess(
  store: MemoryStore,
  agentAnsName: string,
  requestedScopes: string[],
  missionId?: string,
): Promise<AgentAccessRequest> {
  const result = await verifyAnsIdentity(agentAnsName, requestedScopes);
  const req: AgentAccessRequest = {
    id: uuid(),
    agentAnsName,
    requestedScopes,
    missionId,
    verificationStatus: result.status,
    decision: result.isFullyVerified ? "allow" : "deny",
    checks: result.checks,
    assuranceTier: result.assuranceTier,
    timestampMs: Date.now(),
  };
  store.saveAgentRequest(req);
  store.addEvent({
    type: result.isFullyVerified ? "agent_verified" : "agent_blocked",
    timestampMs: req.timestampMs,
    missionId,
    severity: result.isFullyVerified ? "info" : "warn",
    description: result.isFullyVerified
      ? `ANS verified ${agentAnsName} for scopes [${requestedScopes.join(", ")}]`
      : `ANS blocked agent ${agentAnsName}: ${result.status}`,
  });
  return req;
}
