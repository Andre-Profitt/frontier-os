// Safety checks applied to a work graph BEFORE Ghost Shift executes it.
//
// Ghost Shift is the overnight safe-mode lane: class ≤ 1 work only, and no
// side effects that can't be reversed or reviewed at 07:00 the next day.
// Vision §13.1: never deploy, merge without verifier pass, or message externally.
//
// This module is deliberately conservative — a rejection puts the graph in
// ~/.frontier/ghost-shift/blocked/ with a reason, where a human can inspect it
// in the morning. False positives cost nothing; false negatives could damage
// prod state, so we lean hard toward refusal.

import type { WorkGraph, WorkNode, ApprovalClass } from "../work/graph.ts";

export type RejectCode =
  | "class_too_high"
  | "dangerous_side_effect"
  | "missing_verifier"
  | "unsafe_approval_policy";

export interface Rejection {
  code: RejectCode;
  message: string;
  nodeId?: string;
}

export interface SafetyVerdict {
  safe: boolean;
  rejections: Rejection[];
  warnings: string[];
}

/**
 * Side-effect categories Ghost Shift refuses to touch overnight. A PR open or
 * a repo write is fine (human reviews tomorrow); a deploy, an outbound message,
 * an auth mutation, or a financial action is not. `destructive_action` (e.g.
 * VM deallocate, resource delete) and `billable_action` (e.g. runpod start
 * that costs money until torn down) are also refused — those belong behind a
 * human-in-the-loop class-≥2 gate, not the overnight lane.
 */
const DANGEROUS_SIDE_EFFECTS = new Set<string>([
  "auth_change",
  "billable_action",
  "deploy",
  "destructive_action",
  "external_message",
  "financial_action",
]);

const MAX_GHOST_APPROVAL_CLASS: ApprovalClass = 1;

export function assessGraph(graph: WorkGraph): SafetyVerdict {
  const rejections: Rejection[] = [];
  const warnings: string[] = [];

  // Graph-level approval default: must be ≤ 1.
  if (graph.approvalPolicy.defaultClass > MAX_GHOST_APPROVAL_CLASS) {
    rejections.push({
      code: "unsafe_approval_policy",
      message: `graph defaultClass=${graph.approvalPolicy.defaultClass} > ${MAX_GHOST_APPROVAL_CLASS}; Ghost Shift only autonomous on class ≤ ${MAX_GHOST_APPROVAL_CLASS}`,
    });
  }

  for (const node of graph.nodes) {
    assessNode(node, rejections, warnings);
  }

  return { safe: rejections.length === 0, rejections, warnings };
}

function assessNode(
  node: WorkNode,
  rejections: Rejection[],
  warnings: string[],
): void {
  if (node.approvalClass > MAX_GHOST_APPROVAL_CLASS) {
    rejections.push({
      code: "class_too_high",
      message: `approvalClass=${node.approvalClass} > ${MAX_GHOST_APPROVAL_CLASS}`,
      nodeId: node.nodeId,
    });
  }

  for (const se of node.sideEffects ?? []) {
    if (DANGEROUS_SIDE_EFFECTS.has(se)) {
      rejections.push({
        code: "dangerous_side_effect",
        message: `side effect "${se}" is not permitted in Ghost Shift`,
        nodeId: node.nodeId,
      });
    }
  }

  // Warning-only: repo writes and ticket writes are allowed, but we want the
  // morning review to notice them. A missing verifier on a shared-write node
  // is a soft signal, not a hard reject.
  const sharedWrite = (node.sideEffects ?? []).some(
    (s) => s === "repo_write" || s === "shared_write" || s === "pr_open",
  );
  if (sharedWrite && node.verifierPolicy.mode === "none") {
    warnings.push(
      `node ${node.nodeId}: shared write with verifier=none (soft warning, not rejected)`,
    );
  }
}
