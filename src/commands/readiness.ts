import { commandBrief, type CommandBrief } from "./brief.ts";

export interface CommandReadinessOptions {
  hours?: number;
  limit?: number;
  daemon?: {
    reachable: boolean;
    status?: string | null;
    pid?: number | null;
    uptimeSeconds?: number | null;
  };
}

export interface CommandReadinessCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  summary: string;
}

export interface CommandReadiness {
  generatedAt: string;
  status: "ready" | "degraded" | "blocked";
  summary: string[];
  daemon: CommandReadinessOptions["daemon"] | null;
  brief: CommandBrief;
  checks: CommandReadinessCheck[];
}

export function commandReadiness(
  options: CommandReadinessOptions = {},
): CommandReadiness {
  const briefOptions: { hours?: number; limit?: number } = {};
  if (options.hours !== undefined) briefOptions.hours = options.hours;
  if (options.limit !== undefined) briefOptions.limit = options.limit;
  const brief = commandBrief(briefOptions);
  const checks = readinessChecks(brief, options.daemon ?? null);
  const status = readinessStatus(checks);
  return {
    generatedAt: new Date().toISOString(),
    status,
    summary: readinessSummary(status, checks),
    daemon: options.daemon ?? null,
    brief,
    checks,
  };
}

function readinessChecks(
  brief: CommandBrief,
  daemon: CommandReadinessOptions["daemon"] | null,
): CommandReadinessCheck[] {
  const checks: CommandReadinessCheck[] = [];
  if (daemon) {
    checks.push({
      id: "frontierd",
      status: daemon.reachable ? "pass" : "fail",
      summary: daemon.reachable
        ? `frontierd reachable${daemon.pid ? ` pid=${daemon.pid}` : ""}`
        : "frontierd unreachable",
    });
  }
  checks.push({
    id: "queue",
    status: brief.debt.counts.staleActive === 0 ? "pass" : "warn",
    summary:
      `healthyQueued=${brief.debt.counts.healthyQueued} ` +
      `healthyRunning=${brief.debt.counts.healthyRunning} ` +
      `staleQueued=${brief.debt.counts.staleQueued} ` +
      `staleRunning=${brief.debt.counts.staleRunning}`,
  });
  checks.push({
    id: "leases",
    status: brief.worker.runningLeases.some((lease) => lease.expired)
      ? "fail"
      : "pass",
    summary: `expiredLeases=${
      brief.worker.runningLeases.filter((lease) => lease.expired).length
    }`,
  });
  checks.push({
    id: "blockers",
    status: brief.blockers.length === 0 ? "pass" : "fail",
    summary: `${brief.blockers.length} approval/policy blocker${
      brief.blockers.length === 1 ? "" : "s"
    } (stale approval=${brief.debt.counts.staleApproval} stale policy=${brief.debt.counts.stalePolicy})`,
  });
  checks.push({
    id: "failures",
    status: brief.unresolvedFailures.length === 0 ? "pass" : "warn",
    summary: `${brief.unresolvedFailures.length} unresolved recent failure${
      brief.unresolvedFailures.length === 1 ? "" : "s"
    }`,
  });
  const retryBudgetFailures =
    (brief.unresolvedFailureKinds.retry_exhausted ?? 0) +
    (brief.unresolvedFailureKinds.runtime_exceeded ?? 0);
  checks.push({
    id: "retry_budget",
    status: retryBudgetFailures === 0 ? "pass" : "warn",
    summary: `${retryBudgetFailures} retry/budget failure${
      retryBudgetFailures === 1 ? "" : "s"
    }`,
  });
  const verifierFailures = brief.unresolvedFailureKinds.verifier_failed ?? 0;
  checks.push({
    id: "verification",
    status: verifierFailures === 0 ? "pass" : "fail",
    summary: `${verifierFailures} verifier failure${
      verifierFailures === 1 ? "" : "s"
    }`,
  });
  return checks;
}

function readinessStatus(
  checks: CommandReadinessCheck[],
): CommandReadiness["status"] {
  if (checks.some((check) => check.status === "fail")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "degraded";
  return "ready";
}

function readinessSummary(
  status: CommandReadiness["status"],
  checks: CommandReadinessCheck[],
): string[] {
  const failed = checks.filter((check) => check.status === "fail");
  const warned = checks.filter((check) => check.status === "warn");
  if (status === "ready") return ["command system ready"];
  if (status === "blocked") {
    return [`blocked: ${failed.map((check) => check.id).join(", ")}`];
  }
  return [`degraded: ${warned.map((check) => check.id).join(", ")}`];
}
