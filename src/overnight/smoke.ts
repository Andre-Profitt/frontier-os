import { requestDaemon } from "../daemon/server.ts";
import { helperSelfTest } from "../helper/simulator.ts";
import { getLedger, closeLedger } from "../ledger/index.ts";
import { smokeMcpBridge } from "../mcp/bridge.ts";
import {
  buildActionEnvelope,
  evaluatePolicyAction,
} from "../policy/evaluator.ts";

export async function overnightSmoke() {
  const startedAt = Date.now();
  const daemon = await requestDaemon("/health", { timeoutMs: 1500 });
  const mcp = await smokeMcpBridge({ readOnly: true });
  const helper = await helperSelfTest();
  const denied = evaluatePolicyAction(
    buildActionEnvelope({
      actor: "overnight",
      source: "overnight",
      projectId: "frontier-os",
      verb: "service.restart",
      arguments: {},
    }),
  );
  const status =
    daemon.reachable &&
    daemon.statusCode === 200 &&
    mcp.status === "ok" &&
    helper.status === "ok" &&
    denied.decision.status === "deny"
      ? "ok"
      : "failed";
  const result = {
    status,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    daemon: {
      reachable: daemon.reachable,
      statusCode: daemon.statusCode,
      error: daemon.error,
    },
    mcp: {
      status: mcp.status,
      passed: mcp.passed,
      failed: mcp.failed,
    },
    helper: {
      status: helper.status,
      passed: helper.passed,
      failed: helper.failed,
    },
    policy: {
      serviceRestartDecision: denied.decision.status,
      reason: denied.decision.reason,
    },
  };
  const ledger = getLedger();
  ledger.ensureSession({
    sessionId: "overnight-orchestrator",
    label: "overnight-orchestrator",
    tags: ["overnight", "orchestrator"],
  });
  ledger.appendEvent({
    sessionId: "overnight-orchestrator",
    kind: "overnight.smoke",
    actor: "overnight",
    payload: result,
  });
  closeLedger();
  return result;
}
