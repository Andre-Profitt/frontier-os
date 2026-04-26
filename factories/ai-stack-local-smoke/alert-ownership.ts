// alert-ownership — prevents duplicate legacy + factory alerts.
//
// When the factory wraps a legacy lane, both can emit alerts. The
// supervisor reads recent alerts before and after the primary run; the
// difference is the legacy lane's contribution to this run.
//
// Decision matrix:
//   final == "passed"                            → no alert (ownership: none)
//   final ∈ {failed, ambiguous}, legacy emitted  → correlate, no factory alert
//   final ∈ {failed, ambiguous}, no legacy       → emit one factory alert
//
// The factory NEVER emits if the legacy lane already did. That keeps
// the dark factory cleaner than the lane it wraps, not noisier.

export type Ownership =
  | "none"
  | "legacy-alert-correlated"
  | "factory-alert-emitted"
  | "suppressed-shadow-mode";

export interface AlertRecordLike {
  alertId: string;
  source: string;
  summary?: string;
  ts?: string;
}

export interface ReconcileAlertsInput {
  finalClassification: "passed" | "failed" | "ambiguous";
  alertsBefore: AlertRecordLike[];
  alertsAfter: AlertRecordLike[];
  // The factory's own alert source, e.g. "factory.ai-stack-local-smoke".
  // Alerts whose source contains this prefix are excluded from the
  // "new legacy alerts" set — they're our own (or a previous run's)
  // emissions, not legacy-lane emissions.
  factoryAlertSourcePrefix: string;
  // shadow mode: factory never emits; legacy lane is still authoritative.
  // The reconciler still records correlations so the FactoryRun shows
  // ownership accurately.
  mode: "shadow" | "active" | "disabled";
}

export interface ReconcileAlertsResult {
  ownership: Ownership;
  correlatedLegacyAlertIds: string[];
  shouldEmitFactoryAlert: boolean;
  newLegacyAlertCount: number;
  reason: string;
}

export function reconcileAlerts(
  input: ReconcileAlertsInput,
): ReconcileAlertsResult {
  const beforeIds = new Set(input.alertsBefore.map((a) => a.alertId));
  const newAlerts = input.alertsAfter.filter((a) => !beforeIds.has(a.alertId));
  const newLegacy = newAlerts.filter(
    (a) => !a.source.includes(input.factoryAlertSourcePrefix),
  );
  const correlatedLegacyAlertIds = newLegacy.map((a) => a.alertId);

  if (input.finalClassification === "passed") {
    return {
      ownership: "none",
      correlatedLegacyAlertIds,
      shouldEmitFactoryAlert: false,
      newLegacyAlertCount: newLegacy.length,
      reason: "passed final → no alert needed",
    };
  }

  if (input.mode === "shadow") {
    return {
      ownership: "suppressed-shadow-mode",
      correlatedLegacyAlertIds,
      shouldEmitFactoryAlert: false,
      newLegacyAlertCount: newLegacy.length,
      reason:
        newLegacy.length > 0
          ? `shadow mode + ${newLegacy.length} legacy alert(s) — correlate, do not emit`
          : `shadow mode — do not emit even though no legacy alert exists; legacy lane is still authoritative`,
    };
  }

  if (newLegacy.length > 0) {
    return {
      ownership: "legacy-alert-correlated",
      correlatedLegacyAlertIds,
      shouldEmitFactoryAlert: false,
      newLegacyAlertCount: newLegacy.length,
      reason: `final=${input.finalClassification} + ${newLegacy.length} legacy alert(s) → correlate, no factory alert`,
    };
  }

  return {
    ownership: "factory-alert-emitted",
    correlatedLegacyAlertIds: [],
    shouldEmitFactoryAlert: true,
    newLegacyAlertCount: 0,
    reason: `final=${input.finalClassification} + no legacy alert → factory emits one alert`,
  };
}
