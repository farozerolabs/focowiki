import { createHash } from "node:crypto";

import {
  createPostgresQueryShape
} from "./comprehensive-persistence-inventory.mjs";

export function buildPostgresQueryPathLedger({
  phase,
  inventory,
  observedStatements,
  planEvidence,
  runtime
}) {
  if (!String(phase ?? "").trim()) {
    throw new Error("PostgreSQL query-path phase is required");
  }
  const expected = (inventory ?? [])
    .filter((item) => item?.kind === "critical-query-path")
    .sort((left, right) => left.id.localeCompare(right.id));
  validateExpected(expected);
  const observed = normalizeObservedStatements(observedStatements ?? []);
  const anchoredAssignments = buildAnchoredAssignments(expected, observed);
  const plans = new Map((planEvidence ?? []).map((item) => [String(item.queryId), item.plan]));
  const rows = expected.map((item) => buildRow(
    item,
    observed,
    plans,
    anchoredAssignments.get(item.id) ?? []
  ));
  const counts = {
    expected: rows.length,
    observed: rows.filter((row) => row.runtime !== null).length,
    planned: rows.filter((row) => row.plan !== null).length,
    missingRuntime: rows.filter((row) => row.runtime === null).length,
    missingPlan: rows.filter((row) => row.plan === null).length
  };
  const runtimeState = validateRuntime(runtime);
  const failures = [
    ...(counts.missingRuntime > 0 ? [`missing-runtime:${counts.missingRuntime}`] : []),
    ...(counts.missingPlan > 0 ? [`missing-plan:${counts.missingPlan}`] : []),
    ...(runtimeState.databaseDeadlocks > 0
      ? [`database-deadlocks:${runtimeState.databaseDeadlocks}`]
      : []),
    ...(runtimeState.blockedSessions > 0
      ? [`blocked-sessions:${runtimeState.blockedSessions}`]
      : [])
  ];

  return {
    kind: "focowiki-comprehensive-postgres-query-path-ledger",
    version: 1,
    generatedAt: new Date().toISOString(),
    phase,
    ok: failures.length === 0,
    counts,
    runtime: runtimeState,
    failures,
    rows
  };
}

export function assertPostgresQueryPathLedger(report) {
  if (
    report?.kind !== "focowiki-comprehensive-postgres-query-path-ledger"
    || report.version !== 1
    || report.ok !== true
    || report.counts?.expected !== report.counts?.observed
    || report.counts?.expected !== report.counts?.planned
    || report.rows?.length !== report.counts?.expected
  ) {
    throw new Error("PostgreSQL query-path ledger is incomplete");
  }
  return report;
}

export function selectPostgresQueryPathRuntimeCandidates({
  inventory,
  observedStatements
}) {
  const expected = (inventory ?? []).filter((item) =>
    item?.kind === "critical-query-path");
  validateExpected(expected);
  const observed = normalizeObservedStatements(observedStatements ?? []);
  const selectedIds = new Set(observed
    .filter((statement) => expected.some((item) =>
      item.queryFingerprint === statement.fingerprint))
    .map((statement) => statement.queryId));
  for (const statements of buildAnchoredAssignments(expected, observed).values()) {
    for (const statement of statements) selectedIds.add(statement.queryId);
  }
  return (observedStatements ?? []).filter((statement) =>
    selectedIds.has(String(statement?.queryId ?? "")));
}

function validateExpected(expected) {
  if (expected.length === 0) {
    throw new Error("PostgreSQL query-path inventory is empty");
  }
  const ids = new Set();
  for (const item of expected) {
    if (
      !item.id
      || ids.has(item.id)
      || !/^[a-f0-9]{64}$/u.test(item.queryFingerprint ?? "")
      || !/^[a-f0-9]{64}$/u.test(item.queryAnchorFingerprint ?? "")
      || !Array.isArray(item.queryAnchorTokenHashes)
      || item.queryAnchorTokenHashes.length === 0
      || item.queryAnchorTokenHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))
    ) {
      throw new Error(`Invalid PostgreSQL query-path inventory item: ${item.id ?? "unknown"}`);
    }
    ids.add(item.id);
  }
}

function normalizeObservedStatements(statements) {
  return statements.map((statement) => {
    const queryId = String(statement?.queryId ?? "");
    const shape = createPostgresQueryShape(statement?.query ?? "");
    if (!queryId || !shape.normalized) {
      throw new Error("Invalid observed PostgreSQL statement");
    }
    return {
      queryId,
      fingerprint: shape.fingerprint,
      anchorTokenHashes: shape.anchorTokenHashes,
      calls: nonnegative(statement.calls, "calls"),
      plans: nonnegative(statement.plans, "plans"),
      rows: nonnegative(statement.rows, "rows"),
      totalPlanTimeMs: nonnegative(statement.totalPlanTimeMs, "totalPlanTimeMs"),
      totalExecTimeMs: nonnegative(statement.totalExecTimeMs, "totalExecTimeMs"),
      maximumExecTimeMs: nonnegative(statement.maximumExecTimeMs, "maximumExecTimeMs"),
      sharedBlocksHit: nonnegative(statement.sharedBlocksHit, "sharedBlocksHit"),
      sharedBlocksRead: nonnegative(statement.sharedBlocksRead, "sharedBlocksRead"),
      tempBlocksWritten: nonnegative(statement.tempBlocksWritten, "tempBlocksWritten"),
      walRecords: nonnegative(statement.walRecords, "walRecords"),
      walBytes: nonnegative(statement.walBytes, "walBytes")
    };
  });
}

function buildRow(item, observed, plans, anchoredMatches) {
  const exactMatches = observed.filter((statement) =>
    statement.fingerprint === item.queryFingerprint);
  const matches = exactMatches.length > 0 ? exactMatches : anchoredMatches;
  const runtime = matches.length > 0 ? aggregateRuntime(matches) : null;
  if (runtime) runtime.matchMode = exactMatches.length > 0 ? "exact" : "anchor";
  const planCandidates = matches
    .map((statement) => plans.has(statement.queryId)
      ? summarizePlan(plans.get(statement.queryId))
      : null)
    .filter(Boolean);
  const plan = planCandidates.length > 0 ? mergePlans(planCandidates) : null;
  return {
    sourceId: item.id,
    source: item.source,
    statementLine: item.statementLine,
    tables: [...item.tables],
    operation: item.operation,
    queryClass: item.queryClass,
    queryFingerprint: item.queryFingerprint,
    queryAnchorFingerprint: item.queryAnchorFingerprint,
    parameterCount: item.parameterCount,
    runtime,
    plan,
    concerns: [
      ...(runtime?.tempBlocksWritten > 0 ? ["temp-spill"] : []),
      ...(plan?.seqScanRelations.length > 0 ? ["sequential-scan-reviewed"] : [])
    ]
  };
}

function buildAnchoredAssignments(expected, observed) {
  const assignments = new Map();
  for (const statement of observed) {
    if (expected.some((item) => item.queryFingerprint === statement.fingerprint)) continue;
    const candidates = expected.filter((item) => isSubsequence(
      item.queryAnchorTokenHashes,
      statement.anchorTokenHashes
    ));
    if (candidates.length !== 1) continue;
    const id = candidates[0].id;
    assignments.set(id, [...(assignments.get(id) ?? []), statement]);
  }
  return assignments;
}

function isSubsequence(expected, observed) {
  let index = 0;
  for (const token of observed) {
    if (token === expected[index]) index += 1;
    if (index === expected.length) return true;
  }
  return expected.length === 0;
}

function aggregateRuntime(matches) {
  const calls = sum(matches, "calls");
  const rows = sum(matches, "rows");
  const totalExecTimeMs = sum(matches, "totalExecTimeMs");
  return {
    queryIdHashes: matches.map((item) => sha256(item.queryId)).sort(),
    calls,
    plans: sum(matches, "plans"),
    rows,
    rowsPerCall: ratio(rows, calls),
    totalPlanTimeMs: round(sum(matches, "totalPlanTimeMs")),
    totalExecTimeMs: round(totalExecTimeMs),
    meanExecTimeMs: ratio(totalExecTimeMs, calls),
    maximumExecTimeMs: round(Math.max(...matches.map((item) => item.maximumExecTimeMs))),
    sharedBlocksHit: sum(matches, "sharedBlocksHit"),
    sharedBlocksRead: sum(matches, "sharedBlocksRead"),
    tempBlocksWritten: sum(matches, "tempBlocksWritten"),
    walRecords: sum(matches, "walRecords"),
    walBytes: sum(matches, "walBytes")
  };
}

function summarizePlan(value) {
  const root = Array.isArray(value) ? value[0]?.Plan : value?.Plan ?? value;
  if (!root || typeof root !== "object") {
    throw new Error("Invalid PostgreSQL generic plan evidence");
  }
  const nodes = [];
  visitPlan(root, nodes);
  return {
    nodeCount: nodes.length,
    nodeTypes: uniqueSorted(nodes.map((node) => node["Node Type"]).filter(Boolean)),
    relationNames: uniqueSorted(nodes.map((node) => node["Relation Name"]).filter(Boolean)),
    indexNames: uniqueSorted(nodes.map((node) => node["Index Name"]).filter(Boolean)),
    seqScanRelations: uniqueSorted(nodes
      .filter((node) => node["Node Type"] === "Seq Scan")
      .map((node) => node["Relation Name"])
      .filter(Boolean)),
    planRows: nonnegative(root["Plan Rows"] ?? 0, "planRows"),
    totalCost: nonnegative(root["Total Cost"] ?? 0, "totalCost")
  };
}

function visitPlan(node, target) {
  target.push(node);
  for (const child of node.Plans ?? []) visitPlan(child, target);
}

function mergePlans(plans) {
  return {
    planVariants: plans.length,
    nodeCount: Math.max(...plans.map((plan) => plan.nodeCount)),
    nodeTypes: uniqueSorted(plans.flatMap((plan) => plan.nodeTypes)),
    relationNames: uniqueSorted(plans.flatMap((plan) => plan.relationNames)),
    indexNames: uniqueSorted(plans.flatMap((plan) => plan.indexNames)),
    seqScanRelations: uniqueSorted(plans.flatMap((plan) => plan.seqScanRelations)),
    planRows: Math.max(...plans.map((plan) => plan.planRows)),
    totalCost: round(Math.max(...plans.map((plan) => plan.totalCost)))
  };
}

function validateRuntime(runtime) {
  return {
    databaseDeadlocks: nonnegative(runtime?.databaseDeadlocks, "databaseDeadlocks"),
    blockedSessions: nonnegative(runtime?.blockedSessions, "blockedSessions"),
    longestTransactionMs: nonnegative(runtime?.longestTransactionMs, "longestTransactionMs")
  };
}

function nonnegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid PostgreSQL query-path ${label}`);
  }
  return number;
}

function sum(items, field) {
  return items.reduce((total, item) => total + item[field], 0);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function round(value) {
  return Number(value.toFixed(3));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
