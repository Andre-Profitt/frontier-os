import { requestDaemon } from "../daemon/server.ts";
import { requestProductionHelper } from "../helper/install.ts";
import { getLedger } from "../ledger/index.ts";
import { newSessionId } from "../ledger/events.ts";
import { allProjectPlans, type ProjectPlanAction } from "../projects/planner.ts";

export interface OvernightPlanOptions {
  hours?: number;
}

export interface OvernightPlannedAction {
  sequence: number;
  scheduled: boolean;
  scheduledStartMinute: number | null;
  estimatedMinutes: number;
  projectId: string;
  action: ProjectPlanAction;
}

export interface OvernightPlanResult {
  status: "ready" | "attention" | "blocked";
  generatedAt: string;
  hours: number;
  capacityMinutes: number;
  usedMinutes: number;
  projectCount: number;
  attentionCount: number;
  actionCount: number;
  scheduledCount: number;
  blockedCount: number;
  helper: {
    reachable: boolean;
    statusCode: number | null;
    error: string | null;
    euid: number | null;
  };
  daemon: {
    reachable: boolean;
    statusCode: number | null;
    error: string | null;
  };
  projects: Array<{
    id: string;
    name: string;
    priority: string;
    health: string;
    recommendedCount: number;
    blockedCount: number;
    attentionReasons: string[];
  }>;
  actions: OvernightPlannedAction[];
  blockedActions: ProjectPlanAction[];
  nextActions: Array<{
    projectId: string;
    actionId: string;
    title: string;
    verb: string;
    lane: string;
    estimatedMinutes: number;
  }>;
}

export async function overnightPlan(
  options: OvernightPlanOptions = {},
): Promise<OvernightPlanResult> {
  const hours = boundedHours(options.hours ?? 8);
  const capacityMinutes = hours * 60;
  const [plans, helper, daemon] = await Promise.all([
    allProjectPlans("next"),
    requestProductionHelper("/health", 1500),
    requestDaemon("/health", { timeoutMs: 1500 }),
  ]);
  const attentionPlans = plans.filter(
    (plan) => plan.project.health !== "ok" || plan.summary.attentionReasons.length > 0,
  );
  const flattened = plans
    .flatMap((plan) =>
      plan.actions
        .filter((action) => action.autonomousEligible && action.recommended)
        .map((action) => ({ plan, action })),
    )
    .sort((a, b) => comparePlanned(a.action, b.action));

  let usedMinutes = 0;
  const actions: OvernightPlannedAction[] = [];
  let sequence = 1;
  for (const item of flattened) {
    const estimatedMinutes = estimateMinutes(item.action);
    const scheduled = usedMinutes + estimatedMinutes <= capacityMinutes;
    actions.push({
      sequence: sequence++,
      scheduled,
      scheduledStartMinute: scheduled ? usedMinutes : null,
      estimatedMinutes,
      projectId: item.plan.project.id,
      action: item.action,
    });
    if (scheduled) usedMinutes += estimatedMinutes;
  }

  const blockedActions = plans.flatMap((plan) =>
    plan.actions.filter((action) => action.blocked),
  );
  const result: OvernightPlanResult = {
    status:
      blockedActions.length > 0
        ? "blocked"
        : attentionPlans.length > 0 || !helper.reachable || !daemon.reachable
          ? "attention"
          : "ready",
    generatedAt: new Date().toISOString(),
    hours,
    capacityMinutes,
    usedMinutes,
    projectCount: plans.length,
    attentionCount: attentionPlans.length,
    actionCount: plans.reduce((sum, plan) => sum + plan.actions.length, 0),
    scheduledCount: actions.filter((action) => action.scheduled).length,
    blockedCount: blockedActions.length,
    helper: {
      reachable: helper.reachable,
      statusCode: helper.statusCode,
      error: helper.error,
      euid: helperEuid(helper.body),
    },
    daemon: {
      reachable: daemon.reachable,
      statusCode: daemon.statusCode,
      error: daemon.error,
    },
    projects: plans.map((plan) => ({
      id: plan.project.id,
      name: plan.project.name,
      priority: plan.project.priority,
      health: plan.project.health,
      recommendedCount: plan.summary.recommendedCount,
      blockedCount: plan.summary.blockedCount,
      attentionReasons: plan.summary.attentionReasons,
    })),
    actions,
    blockedActions,
    nextActions: actions
      .filter((action) => action.scheduled)
      .slice(0, 20)
      .map((action) => ({
        projectId: action.projectId,
        actionId: action.action.actionId,
        title: action.action.title,
        verb: action.action.verb,
        lane: action.action.lane,
        estimatedMinutes: action.estimatedMinutes,
      })),
  };
  appendOvernightPlanEvent(result);
  return result;
}

function boundedHours(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 8;
  return Math.min(Math.max(Math.round(value), 1), 24);
}

function comparePlanned(a: ProjectPlanAction, b: ProjectPlanAction): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  const byActionKind = actionKindRank(a) - actionKindRank(b);
  if (byActionKind !== 0) return byActionKind;
  return a.actionId.localeCompare(b.actionId);
}

function priorityRank(priority: ProjectPlanAction["priority"]): number {
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

function estimateMinutes(action: ProjectPlanAction): number {
  if (action.command?.timeoutSeconds) {
    return Math.min(Math.max(Math.ceil(action.command.timeoutSeconds / 10), 5), 60);
  }
  switch (action.verb) {
    case "project.verify":
      return 30;
    case "project.smoke":
      return 15;
    case "logs.read":
    case "launchd.status":
    case "project.status":
      return 5;
    case "project.inspect":
      return 10;
    default:
      return 15;
  }
}

function helperEuid(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const euid = record.euid;
  return typeof euid === "number" ? euid : null;
}

function appendOvernightPlanEvent(plan: OvernightPlanResult): void {
  const ledger = getLedger();
  const sessionId = newSessionId("overnight-plan");
  ledger.ensureSession({
    sessionId,
    label: "overnight-plan",
    tags: ["overnight", "orchestrator"],
  });
  ledger.appendEvent({
    sessionId,
    kind: "overnight.plan",
    actor: "overnight",
    payload: {
      generatedAt: plan.generatedAt,
      hours: plan.hours,
      status: plan.status,
      projectCount: plan.projectCount,
      attentionCount: plan.attentionCount,
      actionCount: plan.actionCount,
      scheduledCount: plan.scheduledCount,
      blockedCount: plan.blockedCount,
      helper: plan.helper,
      daemon: plan.daemon,
      nextActions: plan.nextActions,
    },
  });
}
