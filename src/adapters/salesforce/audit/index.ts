// Audit orchestrator: runs every rule in ALL_RULES against a DashboardModel
// and aggregates findings into a grade that matches the user's existing
// "BLOCKING / WRONG-DATA / ORPHAN / OK" grading vocabulary.

import type { DashboardModel } from "../lightning.ts";
import { ALL_RULES, type Finding, type FindingSeverity } from "./rules.ts";

export interface AuditGrade {
  blocking: number;
  wrongData: number;
  warning: number;
  orphan: number;
  info: number;
  total: number;
  /** True when no blocking and no wrong-data findings exist. */
  ok: boolean;
}

export interface AuditResult {
  grade: AuditGrade;
  findings: Finding[];
  /** Top findings bubbled up for quick CLI output. */
  topFindings: Finding[];
}

const SEVERITY_ORDER: FindingSeverity[] = [
  "blocking",
  "wrong-data",
  "warning",
  "orphan",
  "info",
];

function severityRank(s: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export function runAudit(model: DashboardModel): AuditResult {
  const findings: Finding[] = [];
  for (const rule of ALL_RULES) {
    try {
      const out = rule(model);
      if (out.length) findings.push(...out);
    } catch (err) {
      findings.push({
        ruleId: "rule-error",
        severity: "info",
        category: "metadata",
        title: "an audit rule threw an exception",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Stable sort by severity (blocking first), then by ruleId for repeatability.
  findings.sort((a, b) => {
    const rs = severityRank(a.severity) - severityRank(b.severity);
    if (rs !== 0) return rs;
    return a.ruleId.localeCompare(b.ruleId);
  });

  const grade: AuditGrade = {
    blocking: 0,
    wrongData: 0,
    warning: 0,
    orphan: 0,
    info: 0,
    total: findings.length,
    ok: true,
  };
  for (const f of findings) {
    switch (f.severity) {
      case "blocking":
        grade.blocking++;
        break;
      case "wrong-data":
        grade.wrongData++;
        break;
      case "warning":
        grade.warning++;
        break;
      case "orphan":
        grade.orphan++;
        break;
      case "info":
        grade.info++;
        break;
    }
  }
  grade.ok = grade.blocking === 0 && grade.wrongData === 0;

  return {
    grade,
    findings,
    topFindings: findings.slice(0, 5),
  };
}

export function gradeLine(grade: AuditGrade): string {
  // Mirrors the user's memory format: "12 BLOCKING / 10 WRONG-DATA / 1 ORPHAN / 2 OK"
  return (
    `${grade.blocking} BLOCKING / ` +
    `${grade.wrongData} WRONG-DATA / ` +
    `${grade.warning} WARNING / ` +
    `${grade.orphan} ORPHAN / ` +
    `${grade.info} INFO — ` +
    (grade.ok ? "OK" : "NOT OK")
  );
}
