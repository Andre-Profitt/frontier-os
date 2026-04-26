// alert-ownership tests — pure decision logic; no IO.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileAlerts, type AlertRecordLike } from "../alert-ownership.ts";

const FACTORY_PREFIX = "factory.ai-stack-local-smoke";

const a = (alertId: string, source: string): AlertRecordLike => ({
  alertId,
  source,
  summary: "x",
});

test("passed → ownership=none, no emit, regardless of legacy alerts", () => {
  const r = reconcileAlerts({
    finalClassification: "passed",
    alertsBefore: [],
    alertsAfter: [a("legacy-1", "ai-stack.local-smoke-nightly")],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.equal(r.ownership, "none");
  assert.equal(r.shouldEmitFactoryAlert, false);
});

test("active + failed + new legacy alert → legacy-alert-correlated", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [],
    alertsAfter: [a("legacy-1", "ai-stack.local-smoke-nightly")],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.equal(r.ownership, "legacy-alert-correlated");
  assert.deepEqual(r.correlatedLegacyAlertIds, ["legacy-1"]);
  assert.equal(r.shouldEmitFactoryAlert, false);
});

test("active + ambiguous + new legacy alert → legacy-alert-correlated", () => {
  const r = reconcileAlerts({
    finalClassification: "ambiguous",
    alertsBefore: [],
    alertsAfter: [a("legacy-1", "ai-stack.local-smoke-nightly")],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.equal(r.ownership, "legacy-alert-correlated");
});

test("active + failed + no new legacy alert → factory-alert-emitted", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [],
    alertsAfter: [],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.equal(r.ownership, "factory-alert-emitted");
  assert.equal(r.shouldEmitFactoryAlert, true);
  assert.deepEqual(r.correlatedLegacyAlertIds, []);
});

test("alertsBefore are subtracted — pre-existing legacy alerts do NOT count", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [a("legacy-old", "ai-stack.local-smoke-nightly")],
    alertsAfter: [a("legacy-old", "ai-stack.local-smoke-nightly")],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.equal(r.ownership, "factory-alert-emitted");
  assert.equal(r.shouldEmitFactoryAlert, true);
  assert.equal(r.newLegacyAlertCount, 0);
});

test("alerts emitted by the factory itself are excluded from legacy set", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [],
    alertsAfter: [a("factory-x", `${FACTORY_PREFIX}-prev-run`)],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.equal(r.ownership, "factory-alert-emitted");
  assert.equal(r.shouldEmitFactoryAlert, true);
  assert.equal(r.newLegacyAlertCount, 0);
});

test("shadow mode + failed + legacy alert → suppressed-shadow-mode, no emit, but correlation recorded", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [],
    alertsAfter: [a("legacy-1", "ai-stack.local-smoke-nightly")],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "shadow",
  });
  assert.equal(r.ownership, "suppressed-shadow-mode");
  assert.equal(r.shouldEmitFactoryAlert, false);
  assert.deepEqual(r.correlatedLegacyAlertIds, ["legacy-1"]);
});

test("shadow mode + failed + no legacy alert → suppressed-shadow-mode, still no emit", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [],
    alertsAfter: [],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "shadow",
  });
  assert.equal(r.ownership, "suppressed-shadow-mode");
  assert.equal(r.shouldEmitFactoryAlert, false);
});

test("shadow mode + passed → ownership=none (passed always wins)", () => {
  const r = reconcileAlerts({
    finalClassification: "passed",
    alertsBefore: [],
    alertsAfter: [a("legacy-1", "ai-stack.local-smoke-nightly")],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "shadow",
  });
  assert.equal(r.ownership, "none");
  assert.equal(r.shouldEmitFactoryAlert, false);
});

test("multiple legacy alerts surface in correlatedLegacyAlertIds", () => {
  const r = reconcileAlerts({
    finalClassification: "failed",
    alertsBefore: [],
    alertsAfter: [
      a("legacy-1", "ai-stack.local-smoke-nightly"),
      a("legacy-2", "ai-stack.local-smoke-nightly"),
    ],
    factoryAlertSourcePrefix: FACTORY_PREFIX,
    mode: "active",
  });
  assert.deepEqual(r.correlatedLegacyAlertIds.sort(), ["legacy-1", "legacy-2"]);
  assert.equal(r.shouldEmitFactoryAlert, false);
});
