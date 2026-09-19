type Agent = { id: string; name: string; ans: string; state: string };
type ReqReq = {
  agentAnsName: string;
  verificationStatus: string;
  decision: string;
  requestedScopes: string[];
} | null;

export function AgentPanel({
  agents,
  lastRequest,
  onVerify,
  onBlockUnknown,
}: {
  agents: Agent[];
  lastRequest: AccReq;
  onVerify: (ans: string) => void;
  onBlockUnknown: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-title">Agents · ANS</div>
      <div className="scroll">
        {agents.map((a) => (
          <div className="agent-item" key={a.id}>
            <div className="row">
              <span className="k">{a.name}</span>
              <span
                className={`v ${
                  a.state.includes("BLOCKED")
                    ? "status-blocked"
                    : a.state.includes("VERIFY")
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
        <div className="stack">
          <div className="row">
            <span className="k">Last ANS</span>
            <span className="v">{lastRequest.verificationStatus} / {lastRequest.decision}</span>
          </div>
          <div className="row">
            <span className="k">Agent</span>
            <span className="v">{lastRequest.agentAnsName}</span>
          </div>
        </div>
      )}
    </section>
  );
}
