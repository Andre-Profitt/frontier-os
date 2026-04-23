import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { explainRoute, type RouteExplanation } from "../router/explain.ts";
import type { ApprovalClass } from "../policy/evaluator.ts";
import type {
  ProjectCommandSpec,
  ProjectManifest,
  ProjectPriority,
  ProjectService,
} from "../schemas.ts";
import {
  findProjectManifest,
  loadProjectManifests,
  projectStatus,
  type ProjectCommandStatus,
  type ProjectServiceStatus,
  type ProjectStatus,
} from "./registry.ts";

export type ProjectPlanMode = "next" | "repair";
export type ProjectPlanPriority = "critical" | "high" | "medium" | "low";

export interface ProjectPlanAction {
  actionId: string;
  projectId: string;
  title: string;
  verb: string;
  lane: RouteExplanation["lane"];
  fallbackLane: RouteExplanation["fallbackLane"];
  approvalClass: ApprovalClass;
  decision: RouteExplanation["policy"]["decision"]["status"];
  reason: string;
  priority: ProjectPlanPriority;
  recommended: boolean;
  blocked: boolean;
  blockedReason: string | null;
  autonomousEligible: boolean;
  arguments: Record<string, unknown>;
  command: {
    kind: "verify" | "smoke" | "dev";
    summary: string | null;
    argv: string[];
    cwd: string;
    timeoutSeconds: number | null;
  } | null;
  service: {
    id: string;
    label: string;
    kind: string;
    required: boolean;
    status: string;
    launchAgentLabel: string | null;
    port: number | null;
  } | null;
  evidence: string[];
}

export interface ProjectPlanResult {
  generatedAt: string;
  mode: ProjectPlanMode;
  dryRun: true;
  project: {
    id: string;
    name: string;
    root: string;
    priority: ProjectPriority;
    health: ProjectStatus["health"];
    rootExists: boolean;
    gitDirty: boolean;
    requiredServiceIssues: number;
  };
  status: ProjectStatus;
  summary: {
    actionCount: number;
    recommendedCount: number;
    blockedCount: number;
    autonomousEligibleCount: number;
    attentionReasons: string[];
    recommendedActionIds: string[];
  };
  actions: ProjectPlanAction[];
}

export async function projectNext(projectId: string): Promise<ProjectPlanResult> {
  const manifest = findProjectManifest(projectId);
  const status = await singleProjectStatus(projectId);
  const plan = buildProjectPlan(manifest, status, "next");
  appendProjectPlanEvent(plan);
  return plan;
}

export async function projectRepairPlan(
  projectId: string,
): Promise<ProjectPlanResult> {
  const manifest = findProjectManifest(projectId);
  const status = await singleProjectStatus(projectId);
  const plan = buildProjectPlan(manifest, status, "repair");
  appendProjectPlanEvent(plan);
  return plan;
}

export async function allProjectPlans(
  mode: ProjectPlanMode = "next",
): Promise<ProjectPlanResult[]> {
  const manifests = loadProjectManifests();
  const statusesRaw = await projectStatus();
  const statuses = Array.isArray(statusesRaw) ? statusesRaw : [statusesRaw];
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return manifests.map((manifest) => {
    const status = statusById.get(manifest.id);
    if (!status) throw new Error(`project status missing for ${manifest.id}`);
    return buildProjectPlan(manifest, status, mode);
  });
}

export function buildProjectPlan(
  manifest: ProjectManifest,
  status: ProjectStatus,
  mode: ProjectPlanMode,
): ProjectPlanResult {
  const actions: ProjectPlanAction[] = [];
  const attentionReasons = attentionReasonsFor(manifest, status);

  if (!status.rootExists) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: "root.inspect",
        title: "Inspect missing project root",
        verb: "project.inspect",
        priority: priorityForProject(manifest.priority, "missing"),
        recommended: true,
        approvalClass: 0,
        arguments: { root: manifest.root },
        evidence: [`Project root is missing: ${manifest.root}`],
      }),
    );
  }

  if (status.git.available && status.git.dirty) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: "git.review",
        title: "Review dirty worktree before autonomous work",
        verb: "project.status",
        priority: priorityForProject(manifest.priority, status.health),
        recommended: true,
        approvalClass: 0,
        arguments: {
          changedFiles: status.git.changedFiles,
          untrackedFiles: status.git.untrackedFiles,
        },
        evidence: status.git.statusSample.length
          ? status.git.statusSample
          : ["Git worktree is dirty."],
      }),
    );
  }

  if (!status.git.available && status.rootExists) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: "git.inspect",
        title: "Inspect non-git project root",
        verb: "project.inspect",
        priority: "medium",
        recommended: true,
        approvalClass: 0,
        arguments: { root: manifest.root },
        evidence: [status.git.error ?? "Project root is not a git worktree."],
      }),
    );
  }

  const verifyAction = commandAction(manifest, status, "verify");
  if (verifyAction) actions.push(verifyAction);
  const smokeAction = commandAction(manifest, status, "smoke");
  if (smokeAction) actions.push(smokeAction);

  if (!verifyAction && !smokeAction && status.rootExists) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: "gate.discover",
        title: "Discover and declare a safe verification gate",
        verb: "project.inspect",
        priority: manifest.priority === "dormant" ? "low" : "medium",
        recommended: manifest.priority !== "dormant",
        approvalClass: 0,
        arguments: { root: manifest.root },
        evidence: ["No verify or smoke command is declared in the manifest."],
      }),
    );
  }

  for (const serviceStatus of status.services) {
    const serviceManifest = manifest.services.find(
      (service) => service.id === serviceStatus.id,
    );
    if (!serviceManifest) continue;
    actions.push(...serviceActions(manifest, status, serviceManifest, serviceStatus));
  }

  const orderedActions = actions.sort(compareActions);
  const recommended = orderedActions.filter((action) => action.recommended);
  const blocked = orderedActions.filter((action) => action.blocked);
  const autonomous = orderedActions.filter((action) => action.autonomousEligible);
  return {
    generatedAt: new Date().toISOString(),
    mode,
    dryRun: true,
    project: {
      id: status.id,
      name: status.name,
      root: status.root,
      priority: manifest.priority,
      health: status.health,
      rootExists: status.rootExists,
      gitDirty: status.git.dirty,
      requiredServiceIssues: requiredServiceIssues(status).length,
    },
    status,
    summary: {
      actionCount: orderedActions.length,
      recommendedCount: recommended.length,
      blockedCount: blocked.length,
      autonomousEligibleCount: autonomous.length,
      attentionReasons,
      recommendedActionIds: recommended.map((action) => action.actionId),
    },
    actions: orderedActions,
  };
}

async function singleProjectStatus(projectId: string): Promise<ProjectStatus> {
  const status = await projectStatus(projectId);
  if (Array.isArray(status)) {
    throw new Error(`expected one project status for ${projectId}`);
  }
  return status;
}

function commandAction(
  manifest: ProjectManifest,
  status: ProjectStatus,
  kind: "verify" | "smoke",
): ProjectPlanAction | null {
  const commandStatus = status.commands[kind];
  const commandSpec = manifest.commands[kind];
  if (!commandStatus.declared || !commandSpec) return null;
  const priority =
    kind === "verify"
      ? priorityForProject(manifest.priority, status.health)
      : status.health === "ok"
        ? "medium"
        : "high";
  return makeAction({
    manifest,
    status,
    actionId: `command.${kind}`,
    title: `Run ${kind} gate`,
    verb: `project.${kind}`,
    priority,
    recommended: status.rootExists,
    approvalClass: commandSpec.approvalClass,
    arguments: {
      argv: commandSpec.argv,
      cwd: commandSpec.cwd ?? manifest.root,
    },
    command: commandDetails(kind, manifest, commandStatus, commandSpec),
    evidence: [commandSpec.summary],
  });
}

function serviceActions(
  manifest: ProjectManifest,
  status: ProjectStatus,
  serviceManifest: ProjectService,
  serviceStatus: ProjectServiceStatus,
): ProjectPlanAction[] {
  const unhealthy =
    serviceStatus.status === "missing" || serviceStatus.status === "stopped";
  if (!unhealthy) return [];

  const priority = serviceStatus.required
    ? priorityForProject(manifest.priority, "attention")
    : "low";
  const baseEvidence = [
    `${serviceStatus.label} is ${serviceStatus.status}.`,
    serviceStatus.required ? "Service is required by manifest." : "Service is optional.",
  ];
  const actions: ProjectPlanAction[] = [];

  if (serviceManifest.launchAgentLabel) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: `service.${serviceStatus.id}.launchd-status`,
        title: `Inspect ${serviceStatus.label} LaunchAgent`,
        verb: "launchd.status",
        priority,
        recommended: unhealthy,
        approvalClass: 0,
        arguments: { label: serviceManifest.launchAgentLabel },
        service: serviceDetails(serviceManifest, serviceStatus),
        evidence: baseEvidence,
      }),
    );
  }

  for (const path of serviceManifest.logPaths ?? []) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: `service.${serviceStatus.id}.logs.${hashId(path)}`,
        title: `Read ${serviceStatus.label} logs`,
        verb: "logs.read",
        priority,
        recommended: unhealthy,
        arguments: { path, tailBytes: 8192 },
        service: serviceDetails(serviceManifest, serviceStatus),
        evidence: baseEvidence,
      }),
    );
  }

  if (unhealthy && serviceStatus.required) {
    actions.push(
      makeAction({
        manifest,
        status,
        actionId: `service.${serviceStatus.id}.repair-launchagent`,
        title: `Repair ${serviceStatus.label} LaunchAgent`,
        verb: "ops.repair_launchagent",
        priority,
        recommended: false,
        approvalClass: 2,
        arguments: {
          serviceId: serviceStatus.id,
          label: serviceManifest.launchAgentLabel ?? serviceStatus.label,
        },
        service: serviceDetails(serviceManifest, serviceStatus),
        evidence: [
          ...baseEvidence,
          "Repair requires a one-shot class-2 approval token before launchctl mutation.",
        ],
      }),
    );
  }

  return actions;
}

function makeAction(input: {
  manifest: ProjectManifest;
  status: ProjectStatus;
  actionId: string;
  title: string;
  verb: string;
  priority: ProjectPlanPriority;
  recommended: boolean;
  approvalClass?: ApprovalClass;
  arguments?: Record<string, unknown>;
  command?: ProjectPlanAction["command"];
  service?: ProjectPlanAction["service"];
  evidence?: string[];
}): ProjectPlanAction {
  const route = explainRoute({
    verb: input.verb,
    projectId: input.manifest.id,
    approvalClass: input.approvalClass ?? null,
  });
  const blocked =
    route.lane === "blocked" || route.policy.decision.status !== "allow";
  return {
    actionId: `${input.manifest.id}.${input.actionId}`,
    projectId: input.manifest.id,
    title: input.title,
    verb: input.verb,
    lane: route.lane,
    fallbackLane: route.fallbackLane,
    approvalClass: route.policy.action.approvalClass,
    decision: route.policy.decision.status,
    reason: route.reason,
    priority: input.priority,
    recommended: input.recommended && !blocked,
    blocked,
    blockedReason: blocked ? route.policy.decision.reason : null,
    autonomousEligible:
      !blocked &&
      route.policy.action.approvalClass <= 1 &&
      route.policy.decision.status === "allow",
    arguments: input.arguments ?? {},
    command: input.command ?? null,
    service: input.service ?? null,
    evidence: input.evidence ?? [],
  };
}

function commandDetails(
  kind: "verify" | "smoke" | "dev",
  manifest: ProjectManifest,
  commandStatus: ProjectCommandStatus,
  commandSpec: ProjectCommandSpec,
): NonNullable<ProjectPlanAction["command"]> {
  return {
    kind,
    summary: commandStatus.summary ?? null,
    argv: commandSpec.argv,
    cwd: commandSpec.cwd ?? manifest.root,
    timeoutSeconds: commandSpec.timeoutSeconds ?? null,
  };
}

function serviceDetails(
  serviceManifest: ProjectService,
  serviceStatus: ProjectServiceStatus,
): NonNullable<ProjectPlanAction["service"]> {
  return {
    id: serviceStatus.id,
    label: serviceStatus.label,
    kind: serviceStatus.kind,
    required: serviceStatus.required,
    status: serviceStatus.status,
    launchAgentLabel: serviceManifest.launchAgentLabel ?? null,
    port: serviceManifest.port ?? null,
  };
}

function attentionReasonsFor(
  manifest: ProjectManifest,
  status: ProjectStatus,
): string[] {
  const reasons: string[] = [];
  if (!status.rootExists) reasons.push(`missing root: ${status.root}`);
  if (status.git.available && status.git.dirty) {
    reasons.push(
      `dirty git worktree: ${status.git.changedFiles} changed, ${status.git.untrackedFiles} untracked`,
    );
  }
  if (!status.git.available && status.rootExists) {
    reasons.push(status.git.error ?? "git status unavailable");
  }
  for (const service of requiredServiceIssues(status)) {
    reasons.push(`required service ${service.id} is ${service.status}`);
  }
  if (!manifest.commands.verify && !manifest.commands.smoke) {
    reasons.push("no safe verify/smoke gate declared");
  }
  return reasons;
}

function requiredServiceIssues(status: ProjectStatus): ProjectServiceStatus[] {
  return status.services.filter(
    (service) =>
      service.required &&
      (service.status === "missing" || service.status === "stopped"),
  );
}

function priorityForProject(
  priority: ProjectPriority,
  health: ProjectStatus["health"],
): ProjectPlanPriority {
  if (health === "missing") return "critical";
  if (priority === "critical") return health === "ok" ? "high" : "critical";
  if (priority === "high") return health === "ok" ? "medium" : "high";
  if (priority === "medium") return "medium";
  return "low";
}

function compareActions(a: ProjectPlanAction, b: ProjectPlanAction): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
  if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
  const byActionKind = actionKindRank(a) - actionKindRank(b);
  if (byActionKind !== 0) return byActionKind;
  return a.actionId.localeCompare(b.actionId);
}

function priorityRank(priority: ProjectPlanPriority): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function actionKindRank(action: ProjectPlanAction): number {
  if (action.actionId.endsWith(".git.review")) return 0;
  if (action.verb === "project.inspect") return 1;
  if (action.verb === "launchd.status") return 2;
  if (action.verb === "logs.read") return 3;
  if (action.verb === "project.smoke") return 4;
  if (action.verb === "project.verify") return 5;
  return 9;
}

function hashId(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

function appendProjectPlanEvent(plan: ProjectPlanResult): void {
  const ledger = getLedger();
  const sessionId = newSessionId(`project-plan-${plan.project.id}`);
  ledger.ensureSession({
    sessionId,
    label: "project-planner",
    tags: ["project", "planner"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "project.plan",
    actor: "project-planner",
    payload: {
      generatedAt: plan.generatedAt,
      mode: plan.mode,
      project: plan.project,
      summary: plan.summary,
      actions: plan.actions.map((action) => ({
        actionId: action.actionId,
        verb: action.verb,
        priority: action.priority,
        lane: action.lane,
        decision: action.decision,
        recommended: action.recommended,
        blocked: action.blocked,
      })),
    },
  });
}
