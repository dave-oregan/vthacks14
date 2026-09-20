import type { AgentAccessRequest } from "../../../src/shared/types";

type Agent = { id: string; name: string; ans: string; state: string };

export function AgentPanel({
  agents,
  lastRequest,
  onVerify,
  onBlockUnknown,
}: {
  agents: Agent[];
  lastRequest: AgentAccessRequest | null;
  onVerify: (ans: string) => void;
  onBlockUnknown: () => void;
}) {
  return (
    <details className="panel" open>
      <summary className="panel-title">Agents · ANS</summary>
      <div className="scroll">
        {agents.map((a) => (
          <div className="agent-item" key={a.id}>
            <div className="row">
              <span className="k">{a.name}</span>
              <span
                className={`v ${
                  a.state.includes("BLOCKED")
                    ? "status-blocked"
                    : a.state.includes("VERIFY") || a.state.includes("PENDING")
                      ? "status-verify"
                      : "status-verified"
                }`}
              >
                {a.state}
              </span>
            </div>
            <div className="row">
              <span className="k">ans</span>
              <span className="v">{a.ans}</span>
            </div>
            <button className="btn" style={{ marginTop: 6 }} onClick={() => onVerify(a.ans)}>
              Verify access
            </button>
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="btn danger" onClick={onBlockUnknown}>
          Simulate unknown agent
        </button>
      </div>
      {lastRequest && (
        <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          <div className="row">
            <span className="k">Last ANS</span>
            <span className={`v ${
              lastRequest.verificationStatus === 'verified' 
                ? 'status-verified' 
                : lastRequest.verificationStatus === 'PENDING VALIDATION'
                  ? 'status-verify'
                  : 'status-blocked'
            }`}>
              {lastRequest.verificationStatus}
            </span>
          </div>
          <div className="row">
            <span className="k">Agent</span>
            <span className="v" style={{ fontSize: "0.8em" }}>{lastRequest.agentAnsName}</span>
          </div>
          
          {lastRequest.checks && (
            <div className="ans-checks" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--fg-dim)", textAlign: "left", borderBottom: "1px solid var(--line)" }}>
                    <th style={{ paddingBottom: 4 }}>CHECK</th>
                    <th style={{ paddingBottom: 4 }}>QUESTION</th>
                    <th style={{ paddingBottom: 4 }}>MECHANISM</th>
                    <th style={{ paddingBottom: 4 }}>PASS</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRequest.checks.map(c => (
                    <tr key={c.name} style={{ borderBottom: "1px dashed var(--line-dim)" }}>
                      <td style={{ padding: "4px 0", fontWeight: "bold" }}>{c.name}</td>
                      <td style={{ padding: "4px 4px", color: "var(--fg-dim)" }}>{c.question}</td>
                      <td style={{ padding: "4px 4px", color: "var(--fg-dim)" }}>{c.mechanism}</td>
                      <td style={{ padding: "4px 0", textAlign: "center", color: c.passed ? "var(--ok)" : "var(--warn)" }}>
                        {c.passed ? "✓" : "✗"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
