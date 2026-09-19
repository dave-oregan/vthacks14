import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import type { AgentAccessRequest } from "../shared/types.js";
import type { MemoryStore } from "../memory/store.js";

const VERIFIED = new Set([
  `ans://v1.0.0.observer.${config.ansTeamDomain}`,
  `ans://v1.0.0.memory.${config.ansTeamDomain}`,
  `ans://v1.0.0.guardian.${config.ansTeamDomain}`,
  `ans://v1.0.0.action.${config.ansTeamDomain}`,
  `ans://v1.0.0.reasoner.${config.ansTeamDomain}`,
]);

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

export function verifyAgentAccess(
  store: MemoryStore,
  agentAnsName: string,
  requestedScopes: string[],
  missionId?: string,
): AgentAccessRequest {
  const allowed = VERIFIED.has(agentAnsName);
  const req: AgentAccessRequest = {
    id: uuid(),
    agentAnsName,
    requestedScopes,
    missionId,
    verificationStatus: allowed ? "verified" : "blocked",
    decision: allowed ? "allow" : "deny",
    timestampMs: Date.now(),
  };
  store.saveAgentRequest(req);
  store.addEvent({
    type: allowed ? "agent_verified" : "agent_blocked",
    timestampMs: req.timestampMs,
    missionId,
    severity: allowed ? "info" : "warn",
    description: allowed
      ? `ANS verified ${agentAnsName} for scopes [${requestedScopes.join(", ")}]`
      : `ANS blocked unknown agent ${agentAnsName}`,
  });
  return req;
}
