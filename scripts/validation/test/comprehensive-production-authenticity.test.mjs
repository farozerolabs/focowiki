import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertProductionAuthenticity,
  buildProductionAuthenticitySnapshot,
  buildProductionWiringGraph,
  classifyCatchBody
} from "../lib/comprehensive-production-authenticity.mjs";
import { buildComprehensiveSourceInventory } from "../lib/comprehensive-release-inventory.mjs";

const repositoryRoot = process.cwd();
const graph = buildProductionWiringGraph(repositoryRoot);

test("maps production sources, imports, settings, ports, tables, routes, workers, and outputs", () => {
  const kinds = new Set(graph.nodes.map((node) => node.kind));
  for (const kind of [
    "source",
    "environment-field",
    "runtime-field",
    "port",
    "postgres-table",
    "admin-route",
    "ui-control",
    "worker-role",
    "generated-output",
    "surface-item"
  ]) assert.ok(kinds.has(kind), kind);
  const inventory = buildComprehensiveSourceInventory({ repositoryRoot });
  assert.equal(
    graph.nodes.filter((node) => node.kind === "surface-item").length,
    Object.values(inventory).reduce((total, items) => total + items.length, 0)
  );
  assert.ok(graph.edges.some((edge) => edge.kind === "imports"));
  assert.ok(graph.edges.some((edge) => edge.kind === "consumes-setting"));
  assert.ok(graph.edges.some((edge) => edge.kind === "queries-table"));
  assert.ok(graph.edges.some((edge) => edge.kind === "binds-port"));
  assert.doesNotThrow(() => assertProductionAuthenticity(graph));
});

test("rejects production test imports, disconnected fields, unbound ports, and duplicate worker bindings", () => {
  for (const mutation of [
    (copy) => copy.edges.push({ id: "bad-import", kind: "imports-test-support", from: "source:a", to: "source:test" }),
    (copy) => { copy.nodes.find((node) => node.kind === "runtime-field").acceptedSetting = true; copy.edges = copy.edges.filter((edge) => edge.from !== copy.nodes.find((node) => node.kind === "runtime-field").id); },
    (copy) => copy.nodes.push({ id: "port:unbound", kind: "port", name: "UnboundPort", source: "apps/api/src/application/ports/unbound.ts" }),
    (copy) => copy.edges.push({ id: "duplicate-worker", kind: "starts-role", from: "source:duplicate", to: "worker-role:api" }),
    (copy) => copy.findings.push({ id: "finding:swallowed", kind: "catch-path", source: "source.ts", line: 1, classification: "potentially-swallowed-error", evidenceHash: "a".repeat(64) }),
    (copy) => copy.findings.push({ id: "finding:test-selector", kind: "production-selector", source: "source.ts", line: 1, classification: "production-test-double-selector", evidenceHash: "b".repeat(64) })
  ]) {
    const copy = structuredClone(graph);
    mutation(copy);
    assert.throws(() => assertProductionAuthenticity(copy));
  }
});

test("keeps every removed disconnected production path absent", () => {
  for (const source of [
    "apps/api/src/domain/publication.ts",
    "apps/api/src/domain/role-job.ts",
    "apps/api/src/graph/graph-term-frequency.ts",
    "apps/api/src/infrastructure/postgres/immutable-object-lock.ts",
    "apps/api/src/runtime-settings/model-assistance.ts",
    "apps/api/src/runtime/model-task-runner.ts",
    "apps/api/src/storage-vnext/api/openapi-ports.ts",
    "apps/api/src/storage-vnext/settings/ports.ts"
  ]) assert.equal(fs.existsSync(source), false, source);
  assert.equal(fs.existsSync("apps/admin/src/components/ui/breadcrumb.tsx"), true);
  assert.ok(graph.findings.some((finding) =>
    finding.source === "apps/admin/src/components/ui/breadcrumb.tsx"
      && finding.classification === "dormant-library-module"
  ));
});

test("distinguishes handled catch paths from genuinely swallowed errors", () => {
  assert.equal(classifyCatchBody({ body: "", before: "try { work(); }", after: "" }), "potentially-swallowed-error");
  assert.equal(classifyCatchBody({ body: "setError(error);", before: "", after: "" }), "explicit-error-handling");
  assert.equal(classifyCatchBody({ body: "// normalized below", before: "", after: "\nthrow stableError();" }), "explicit-error-propagation");
  assert.equal(classifyCatchBody({ body: "// already closed", before: "client.destroy();", after: "" }), "best-effort-cleanup");
});

test("classifies every suspicious production finding and summarizes the live graph", () => {
  assert.ok(graph.findings.length > 0);
  assert.ok(graph.findings.every((finding) => finding.classification && finding.evidenceHash));
  assert.equal(graph.findings.some((finding) => finding.classification === "unreviewed"), false);
  const summary = buildProductionAuthenticitySnapshot(graph);
  assert.equal(summary.schemaVersion, 1);
  assert.ok(Object.values(summary.counts).every((count) => count > 0));
  assert.match(summary.nodeHash, /^[a-f0-9]{64}$/u);
  assert.match(summary.edgeHash, /^[a-f0-9]{64}$/u);
  assert.match(summary.findingHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    buildProductionAuthenticitySnapshot(structuredClone(graph)),
    summary
  );

  const changed = structuredClone(graph);
  changed.findings[0].evidenceHash = changed.findings[0].evidenceHash === "0".repeat(64)
    ? "1".repeat(64)
    : "0".repeat(64);
  assert.notEqual(
    buildProductionAuthenticitySnapshot(changed).findingHash,
    summary.findingHash
  );
});
