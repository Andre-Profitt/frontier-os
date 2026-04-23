import { approvalQueue } from "../approvals/queue.ts";
import { helperStatus } from "../helper/simulator.ts";
import { opsStatus } from "../ops/status.ts";
import { projectStatus } from "../projects/registry.ts";

export async function clientStatus() {
  const [ops, projectsRaw] = await Promise.all([opsStatus(), projectStatus()]);
  const projects = Array.isArray(projectsRaw) ? projectsRaw : [projectsRaw];
  const frontierd = ops.launchAgents.find(
    (agent) => agent.label === "com.frontier-os.frontierd",
  );
  const approvals = approvalQueue({ limit: 5 });
  return {
    generatedAt: new Date().toISOString(),
    service: "frontier-os",
    summary: {
      projectCount: projects.length,
      attentionProjects: projects
        .filter((project) => project.health !== "ok")
        .map((project) => ({ id: project.id, health: project.health })),
      frontierd: {
        installed: frontierd?.installed ?? false,
        loaded: frontierd?.loaded ?? false,
        pid: frontierd?.pid ?? null,
      },
      ghostShift: ops.ghostShift.counts,
      watchers: ops.watchers.map((watcher) => ({
        watcherId: watcher.watcherId,
        nextRunAt: watcher.nextRunAt,
        launchAgentLoaded: watcher.launchAgentLoaded,
        killSwitchActive: watcher.killSwitchActive,
      })),
      approvals: {
        pendingCount: approvals.pendingCount,
        approvedCount: approvals.approvedCount,
        pending: approvals.pending.map((request) => ({
          traceId: request.traceId,
          verb: request.verb,
          summary: request.summary,
          requestedAt: request.requestedAt,
          approve: request.approve,
        })),
        approved: approvals.approved.map((request) => ({
          traceId: request.traceId,
          verb: request.verb,
          summary: request.summary,
          requestedAt: request.requestedAt,
          activeGrant: request.activeGrant,
          consume: request.consume,
        })),
      },
      helper: helperStatus(),
    },
  };
}
