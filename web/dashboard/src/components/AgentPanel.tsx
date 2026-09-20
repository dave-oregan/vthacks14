import { Fragment } from "react";
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
                    <th style={{ paddingBottom: 4, width: "1%" }}></th>
                    <th style={{ paddingBottom: 4 }}>CHECK</th>
                    <th style={{ paddingBottom: 4 }}>MECHANISM</th>
                  </tr>
                </thead>
                <tbody>
                  {lastRequest.checks.map(c => (
                    <Fragment key={c.name}>
                      <tr style={{ borderTop: "1px dashed var(--line-dim)" }}>
                        <td style={{ padding: "5px 6px 0 0", verticalAlign: "top", color: c.passed ? "var(--ok)" : "var(--warn)" }}>
                          {c.passed ? "\u2713" : "\u2717"}
                        </td>
                        <td style={{ padding: "5px 6px 0 0", fontWeight: "bold", verticalAlign: "top" }}>{c.name}</td>
                        <td style={{ padding: "5px 0 0 0", color: "var(--fg-dim)", verticalAlign: "top" }}>{c.mechanism}</td>
                      </tr>
                      {c.detail && (
                        <tr>
                          <td />
                          <td colSpan={2} style={{ padding: "1px 0 5px 0", color: "var(--fg-dim)", fontSize: "0.92em", opacity: 0.85, wordBreak: "break-word" }}>
                            {c.detail}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {lastRequest.assuranceTier && (
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="k">Assurance</span>
                  <span className="v">
                    {lastRequest.assuranceTier === "silver"
                      ? "silver \u00b7 DANE / TLSA verified"
                      : lastRequest.assuranceTier === "bronze"
                        ? "bronze \u00b7 PKI verified"
                        : "none \u00b7 no completed handshake"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
