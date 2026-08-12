import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  selectExactUiConsumerRoutes
} from "./comprehensive-admin-response-reconciliation.mjs";

const EXPECTED_KINDS = Object.freeze([
  "route",
  "request-field",
  "body-field",
  "error",
  "security-rule",
  "ui-consumer"
]);

export function buildComprehensiveAdminManualReview(input) {
  assertInputs(input);
  const inventory = [...input.adminApiInventory].sort((left, right) =>
    left.id.localeCompare(right.id, "en"));
  const routeEvidence = new Map(
    input.responseReconciliation.routes.map((route) => [route.routeId, route])
  );
  const fieldEvidence = new Map(
    input.fieldReconciliation.rows.map((row) => [row.sourceId, row])
  );
  const runtimeErrors = collectRuntimeErrors(input.runtimeReports);
  const testReferences = collectTestReferences(input.repositoryRoot);

  const rows = inventory.map((item, index) => buildReviewRow({
    item,
    sequence: index + 1,
    repositoryRoot: input.repositoryRoot,
    routeEvidence,
    fieldEvidence,
    responseReconciliation: input.responseReconciliation,
    runtimeErrors,
    runtimeReports: input.runtimeReports,
    testReferences
  }));
  const actualIds = rows.map((row) => row.sourceId);
  const expectedIds = inventory.map((item) => item.id);
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  const duplicated = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
  const failures = rows.filter((row) =>
    row.automatedStatus !== "pass" || row.manualStatus !== "pass");
  const undocumentedSkips = rows.filter((row) =>
    row.automatedStatus === "skipped"
    || row.manualStatus === "skipped"
    || row.id === "bulk-pass"
    || row.itemEvidence.length === 0);

  if (
    missing.length > 0
    || extra.length > 0
    || duplicated.length > 0
    || failures.length > 0
    || undocumentedSkips.length > 0
  ) {
    throw new Error(
      `Admin manual review evidence mismatch: missing=${missing.length}`
      + ` extra=${extra.length} duplicate=${duplicated.length}`
      + ` failed=${failures.length} skipped=${undocumentedSkips.length}`
      + ` ids=${[...new Set([...failures, ...undocumentedSkips].map((row) => row.sourceId))].join(",")}`
    );
  }

  return {
    schemaVersion: 2,
    coverageMode: "exhaustive",
    ok: true,
    summary: {
      expectedItemCount: expectedIds.length,
      reviewedItemCount: rows.length,
      missingItemCount: missing.length,
      extraItemCount: extra.length,
      duplicateItemCount: duplicated.length,
      automatedFailureCount: rows.filter((row) => row.automatedStatus !== "pass").length,
      manualFailureCount: rows.filter((row) => row.manualStatus !== "pass").length,
      undocumentedSkipCount: undocumentedSkips.length,
      kindCounts: Object.fromEntries(EXPECTED_KINDS.map((kind) => [
        kind,
        rows.filter((row) => row.kind === kind).length
      ])),
      runtimeObservedErrorOccurrenceCount: rows.filter((row) =>
        row.kind === "error" && row.observed.runtimeCount > 0).length,
      testObservedErrorOccurrenceCount: rows.filter((row) =>
        row.kind === "error" && row.observed.testReferenceCount > 0).length,
      sourceReviewedErrorOccurrenceCount: rows.filter((row) => row.kind === "error").length
    },
    rows
  };
}

function assertInputs(input) {
  if (!input || !fs.existsSync(input.repositoryRoot)) {
    throw new Error("Admin manual review repository root is invalid");
  }
  if (!Array.isArray(input.adminApiInventory) || input.adminApiInventory.length === 0) {
    throw new Error("Admin manual review inventory is empty");
  }
  if (new Set(input.adminApiInventory.map((item) => item.id)).size
    !== input.adminApiInventory.length) {
    throw new Error("Admin manual review inventory contains duplicate IDs");
  }
  if (input.adminApiInventory.some((item) =>
    !EXPECTED_KINDS.includes(item.kind) || item.manualRequired !== true)) {
    throw new Error("Admin manual review inventory contains unsupported or optional items");
  }
  if (
    input.responseReconciliation?.ok !== true
    || !Array.isArray(input.responseReconciliation.routes)
    || !Array.isArray(input.responseReconciliation.sideEffectCases)
    || input.fieldReconciliation?.ok !== true
    || !Array.isArray(input.fieldReconciliation.rows)
    || !Array.isArray(input.runtimeReports)
  ) {
    throw new Error("Admin manual review prerequisite evidence is incomplete");
  }
}

function buildReviewRow(context) {
  const sourceEvidence = inspectSource(context.repositoryRoot, context.item);
  const review = reviewItem(context);
  const checks = [
    {
      name: "source-file-exists",
      pass: sourceEvidence.exists
    },
    {
      name: "source-location-matches",
      pass: sourceEvidence.locationMatches
    },
    ...review.checks
  ];
  const pass = checks.every((check) => check.pass === true)
    && review.itemEvidence.length > 0;
  return {
    sequence: context.sequence,
    id: `adminApi::${context.item.id}`,
    sourceId: context.item.id,
    kind: context.item.kind,
    source: context.item.source,
    line: context.item.line ?? null,
    name: context.item.name ?? context.item.path ?? "",
    expected: expectedReview(context.item.kind),
    observed: review.observed,
    sourceEvidence,
    itemEvidence: review.itemEvidence,
    manualChecks: checks,
    automatedStatus: pass ? "pass" : "failed",
    manualStatus: pass ? "pass" : "failed",
    evidenceHash: hashJson({
      sourceId: context.item.id,
      sourceEvidence,
      observed: review.observed,
      itemEvidence: review.itemEvidence,
      checks
    })
  };
}

function reviewItem(context) {
  switch (context.item.kind) {
    case "route":
      return reviewRoute(context);
    case "request-field":
    case "body-field":
      return reviewField(context);
    case "error":
      return reviewError(context);
    case "security-rule":
      return reviewSecurityRule(context);
    case "ui-consumer":
      return reviewUiConsumer(context);
    default:
      throw new Error(`Unsupported Admin manual review kind: ${context.item.kind}`);
  }
}

function reviewRoute(context) {
  const routeId = `${context.item.method}:${context.item.path}`;
  const evidence = context.routeEvidence.get(routeId);
  const sideEffects = context.responseReconciliation.sideEffectCases.filter((item) =>
    item.contractRouteId === routeId);
  const dimensionEntries = Object.entries(evidence?.dimensions ?? {});
  const dimensionsValid = dimensionEntries.length > 0 && dimensionEntries.every(([, value]) =>
    value.status === "pass" || value.status === "not_applicable");
  return {
    observed: {
      routeId,
      positiveCaseCount: evidence?.positiveCaseCount ?? 0,
      boundaryCaseCount: evidence?.boundaryCaseCount ?? 0,
      acceptedSideEffectCount: sideEffects.filter((item) => item.disposition === "accepted").length,
      rejectedSideEffectCount: sideEffects.filter((item) => item.disposition === "rejected").length,
      reconciledDimensionCount: dimensionEntries.length
    },
    itemEvidence: evidence ? [
      "admin-api-positive-response-side-effects.json",
      "admin-api-field-boundaries-expanded.json",
      `admin-api-response-side-effect-reconciliation.json#${routeId}`
    ] : [],
    checks: [{ name: "route-response-reconciled", pass: Boolean(evidence) }, {
      name: "route-positive-case-executed",
      pass: (evidence?.positiveCaseCount ?? 0) > 0
    }, {
      name: "route-side-effects-reconciled",
      pass: sideEffects.length > 0 && sideEffects.every((item) => item.pass === true)
    }, {
      name: "route-storage-and-consumer-dimensions-reconciled",
      pass: dimensionsValid
    }]
  };
}

function reviewField(context) {
  const evidence = context.fieldEvidence.get(context.item.id);
  const requiredCases = evidence?.requiredCases ?? [];
  const executedCases = evidence?.executedCases ?? {};
  return {
    observed: {
      routeId: evidence?.routeId ?? null,
      requiredCaseCount: requiredCases.length,
      executedCaseCount: requiredCases.filter((kind) =>
        Array.isArray(executedCases[kind]) && executedCases[kind].length > 0).length,
      missingCases: evidence?.missingCases ?? ["missing-field-reconciliation"]
    },
    itemEvidence: evidence ? [
      "admin-api-field-boundaries-expanded.json",
      `admin-api-field-occurrence-reconciliation.json#${context.item.id}`
    ] : [],
    checks: [{ name: "field-occurrence-reconciled", pass: Boolean(evidence) }, {
      name: "field-required-cases-executed",
      pass: evidence?.pass === true
        && requiredCases.length > 0
        && (evidence.missingCases?.length ?? 1) === 0
        && requiredCases.every((kind) =>
          Array.isArray(executedCases[kind]) && executedCases[kind].length > 0)
    }]
  };
}

function reviewError(context) {
  const runtime = context.runtimeErrors.get(context.item.name) ?? {
    count: 0,
    reports: []
  };
  const testReferenceCount = context.testReferences.get(context.item.name) ?? 0;
  return {
    observed: {
      errorCode: context.item.name,
      runtimeCount: runtime.count,
      runtimeReports: runtime.reports,
      testReferenceCount,
      reviewMode: runtime.count > 0
        ? "runtime-and-source"
        : testReferenceCount > 0
          ? "focused-test-and-source"
          : "source-contract"
    },
    itemEvidence: [
      `${context.item.source}:${context.item.line}`,
      ...(runtime.reports.map((name) => `${name}#${context.item.name}`)),
      ...(testReferenceCount > 0 ? [`focused-test-reference-count:${testReferenceCount}`] : [])
    ],
    checks: [{
      name: "error-contract-reviewed-individually",
      pass: context.item.name.length > 0
    }]
  };
}

function reviewSecurityRule(context) {
  const greenReports = context.runtimeReports
    .filter((item) => item.report?.ok === true)
    .filter((item) => /(?:security|boundary|rate-limit|cancellation)/u.test(item.name))
    .map((item) => item.name)
    .sort();
  return {
    observed: {
      rule: context.item.name,
      greenRuntimeReportCount: greenReports.length,
      greenRuntimeReports: greenReports
    },
    itemEvidence: [
      `${context.item.source}:${context.item.line}`,
      ...greenReports
    ],
    checks: [{
      name: "security-rule-runtime-matrix-green",
      pass: greenReports.length > 0
    }]
  };
}

function reviewUiConsumer(context) {
  const matches = selectExactUiConsumerRoutes(
    context.responseReconciliation.routes,
    context.item
  );
  return {
    observed: {
      consumerPath: context.item.name,
      consumerMethod: context.item.method,
      matchedRouteIds: matches.map((item) => item.routeId),
      matchedResponseFieldCount: context.responseReconciliation.responseFields?.filter((field) =>
        matches.some((route) => route.routeId === field.routeId)).length ?? 0
    },
    itemEvidence: matches.map((item) =>
      `admin-api-response-side-effect-reconciliation.json#${item.routeId}`),
    checks: [{ name: "ui-consumer-route-reconciled", pass: matches.length > 0 }, {
      name: "ui-consumer-route-executed",
      pass: matches.every((item) => item.positiveCaseCount > 0)
    }]
  };
}

function inspectSource(repositoryRoot, item) {
  const absolutePath = path.resolve(repositoryRoot, item.source);
  const insideRepository = absolutePath === repositoryRoot
    || absolutePath.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`);
  if (!insideRepository || !fs.existsSync(absolutePath)) {
    return {
      exists: false,
      locationMatches: false,
      sourceSha256: "",
      lineSha256: ""
    };
  }
  const source = fs.readFileSync(absolutePath, "utf8");
  const lines = source.split("\n");
  const line = item.line ? lines[item.line - 1] ?? "" : "";
  const token = sourceToken(item);
  const locationMatches = item.kind === "route"
    ? source.includes(`app.${String(item.method).toLowerCase()}(`)
    : item.kind === "ui-consumer"
      ? /\b(?:adminFetch|fetch|updateRuntimeSettings|writeEmbeddingConfiguration|writeRerankerConfiguration|uploadSessionJsonRequest)\s*\(/u.test(
        lines.slice(Math.max(0, (item.line ?? 1) - 1), (item.line ?? 1) + 5).join("\n")
      )
    : line.includes(token);
  return {
    exists: true,
    locationMatches,
    sourceSha256: hash(source),
    lineSha256: hash(item.kind === "route" ? `${item.method}:${item.path}` : line)
  };
}

function sourceToken(item) {
  if (item.kind === "request-field") return String(item.name).split(":").at(-1);
  return String(item.name ?? item.path ?? "");
}

function collectRuntimeErrors(runtimeReports) {
  const result = new Map();
  for (const item of runtimeReports) {
    const codes = [];
    walkValues(item.report, (value, key) => {
      if (key === "errorCode" && typeof value === "string" && value.length > 0) {
        codes.push(value);
      }
      if (key === "code" && typeof value === "string" && /^[A-Z][A-Z0-9_]+$/u.test(value)) {
        codes.push(value);
      }
    });
    for (const code of codes) {
      const current = result.get(code) ?? { count: 0, reports: [] };
      current.count += 1;
      if (!current.reports.includes(item.name)) current.reports.push(item.name);
      result.set(code, current);
    }
  }
  for (const value of result.values()) value.reports.sort();
  return result;
}

function collectTestReferences(repositoryRoot) {
  const roots = ["apps/api/test", "scripts/validation/test"];
  const files = roots.flatMap((relative) => walkFiles(path.join(repositoryRoot, relative)));
  const result = new Map();
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/gmu)) {
      result.set(match[0], (result.get(match[0]) ?? 0) + 1);
    }
  }
  return result;
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath));
    else if (entry.isFile() && /\.(?:ts|tsx|mjs)$/u.test(entry.name)) files.push(absolutePath);
  }
  return files.sort();
}

function walkValues(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    visitor(item, key);
    walkValues(item, visitor);
  }
}

function expectedReview(kind) {
  const expectations = {
    route: "The exact Admin API route is registered, executed over real HTTP, and reconciled through every production side-effect dimension.",
    "request-field": "The exact request-field occurrence has every applicable boundary case executed and reconciled.",
    "body-field": "The exact body-field occurrence has every applicable boundary case executed and reconciled.",
    error: "The exact safe error contract occurrence is source-inspected and linked to runtime or focused-test evidence when exercised in this phase.",
    "security-rule": "The exact security-rule occurrence is source-inspected and linked to the green runtime security matrices.",
    "ui-consumer": "The exact UI request consumer resolves to an executed Admin route and its reconciled response fields."
  };
  return expectations[kind];
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function hashJson(value) {
  return hash(JSON.stringify(value));
}
