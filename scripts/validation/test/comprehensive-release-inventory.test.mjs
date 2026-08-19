import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  COMPREHENSIVE_INVENTORY_CATEGORIES,
  assertInventoryLedgerParity,
  buildComprehensiveSourceInventory,
  buildInventoryReviewLedger,
  buildInventorySnapshot
} from "../lib/comprehensive-release-inventory.mjs";
import { buildDeveloperOpenApiInventory } from "../lib/comprehensive-openapi-inventory.mjs";

const repositoryRoot = process.cwd();
const openApiDocument = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);
const currentInventory = buildComprehensiveSourceInventory({ repositoryRoot });

test("enumerates every Developer OpenAPI operation and nested contract field", () => {
  const inventory = buildDeveloperOpenApiInventory(openApiDocument);
  const operations = inventory.filter((item) => item.kind === "operation");

  assert.ok(operations.length > 0);
  assert.ok(inventory.some((item) => item.kind === "request-field"));
  assert.ok(inventory.some((item) => item.kind === "response-field"));
  assert.ok(inventory.some((item) => item.kind === "response-status"));
  assert.ok(inventory.some((item) => item.kind === "security"));
  assert.ok(inventory.some((item) => item.kind === "example"));
  const documentation = inventory.filter((item) => item.kind === "documentation");
  const swaggerEntries = inventory.filter((item) => item.kind === "swagger-entry");
  for (const operation of operations) {
    assert.ok(documentation.some((item) => item.operationId === operation.operationId));
    assert.ok(swaggerEntries.some((item) => item.operationId === operation.operationId));
  }
  assert.ok(documentation.every((item) =>
    operations.some((operation) => operation.operationId === item.operationId)));
  assert.ok(swaggerEntries.every((item) =>
    operations.some((operation) => operation.operationId === item.operationId)));
  assert.equal(new Set(inventory.map((item) => item.id)).size, inventory.length);
});

test("builds every source-derived production-audit inventory category", () => {
  const inventory = currentInventory;

  assert.deepEqual(Object.keys(inventory).sort(), [...COMPREHENSIVE_INVENTORY_CATEGORIES].sort());
  for (const category of COMPREHENSIVE_INVENTORY_CATEGORIES) {
    assert.ok(inventory[category].length > 0, category);
    assert.equal(
      new Set(inventory[category].map((item) => item.id)).size,
      inventory[category].length,
      category
    );
    assert.ok(inventory[category].every((item) => item.source && item.manualRequired));
  }
  assert.ok(inventory.adminUi.some((item) => item.kind === "display"));
  assert.ok(inventory.adminUi.some((item) => item.kind === "control"));
  assert.ok(inventory.adminUi.some((item) => item.kind === "state"));
  const postgresTables = inventory.postgres.filter((item) => item.kind === "table");
  assert.ok(postgresTables.length > 0);
  assert.ok(postgresTables.every((item) => item.ownershipBoundary === "schema:focowiki"));
  assert.ok(postgresTables.every((item) => item.lifecyclePhase.startsWith("migration:")));
  const criticalQueries = inventory.postgres.filter(
    (item) => item.kind === "critical-query-path"
  );
  assert.ok(criticalQueries.length >= 50);
  assert.ok(criticalQueries.length <= 600);
  assert.ok(criticalQueries.every((item) =>
    Number.isSafeInteger(item.statementLine)
    && item.statementLine > 0
    && Array.isArray(item.tables)
    && item.tables.length > 0
    && typeof item.queryClass === "string"
    && item.queryClass.length > 0
    && /^[a-f0-9]{64}$/u.test(item.queryFingerprint)
    && /^[a-f0-9]{64}$/u.test(item.queryAnchorFingerprint)
    && Array.isArray(item.queryAnchorTokenHashes)
    && item.queryAnchorTokenHashes.length > 0
    && item.queryAnchorTokenHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash))
    && Number.isSafeInteger(item.parameterCount)
    && item.parameterCount >= 0));
  assert.equal(
    new Set(criticalQueries.map((item) => `${item.source}:${item.statementLine}`)).size,
    criticalQueries.length
  );
  const s3Sources = new Set(inventory.s3
    .filter((item) => item.kind === "source")
    .map((item) => item.source));
  const productionS3Sources = fs.readdirSync("apps/api/src", { recursive: true })
    .filter((entry) => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => `apps/api/src/${entry}`)
    .filter((sourcePath) => fs.readFileSync(sourcePath, "utf8")
      .includes('from "@aws-sdk/client-s3"'));
  assert.ok(productionS3Sources.length > 0);
  assert.deepEqual(
    productionS3Sources.filter((sourcePath) => !s3Sources.has(sourcePath)),
    []
  );
  const workerSources = new Set(inventory.workers
    .filter((item) => item.kind === "source")
    .map((item) => item.source));
  for (const sourcePath of [
    "apps/api/src/worker-main.ts",
    "apps/api/src/storage-vnext/maintenance/maintenance-coordinator.ts",
    "apps/api/src/document-indexing/infrastructure/production-background-runtime.ts",
    "apps/api/src/storage-vnext/maintenance/upload-terminal-object-cleanup-worker.ts",
    "apps/api/src/storage-vnext/maintenance/zero-owner-object-cleanup-worker.ts"
  ]) {
    assert.ok(workerSources.has(sourcePath), sourcePath);
  }
  const workerValues = new Set(inventory.workers
    .filter((item) => item.kind === "worker-value")
    .map((item) => item.name));
  for (const workKind of [
    "document",
    "maintenance",
    "cleanup",
    "prepare",
    "first_layer",
    "content_projection",
    "graphrag",
    "relation_reconcile",
    "knowledge_projection",
    "activate"
  ]) {
    assert.ok(workerValues.has(workKind), workKind);
  }
  for (const removedStage of [
    "source_prepare", "semantic", "indexing", "finalizing", "publication_ready"
  ]) {
    assert.equal(workerValues.has(removedStage), false, removedStage);
  }
});

test("configuration consumer counts include production sources only", () => {
  const source = fs.readFileSync(
    "scripts/validation/lib/comprehensive-code-inventory.mjs",
    "utf8"
  );
  assert.match(source, /\["apps\/api\/src", "apps\/admin\/src"\]\.flatMap/u);
  assert.doesNotMatch(
    source,
    /productionSources\s*=\s*walkFiles\(path\.join\(repositoryRoot, "apps"\)/u
  );
});

test("Admin UI inventory excludes dormant reusable UI primitives", () => {
  assert.equal(
    currentInventory.adminUi.some((item) => item.source.includes("/components/ui/")),
    false
  );
});

test("Admin API body-field inventory excludes internal implementation objects", () => {
  const bodyFields = currentInventory.adminApi.filter((item) => item.kind === "body-field");
  assert.ok(bodyFields.length > 0);
  assert.ok(bodyFields.every((item) => typeof item.name === "string" && item.name.length > 0));
  assert.equal(bodyFields.some((item) => item.name === "sql"), false);
  assert.equal(bodyFields.some((item) => item.name === "js"), false);
  assert.equal(bodyFields.some((item) => item.name === "mutations"), false);
});

test("Admin API UI consumers resolve an exact HTTP method", () => {
  const consumers = currentInventory.adminApi.filter((item) => item.kind === "ui-consumer");

  assert.ok(consumers.length > 0);
  assert.ok(consumers.every((item) =>
    ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(item.method)));
});

test("requires exact source, automated, and manual ledger parity", () => {
  const inventory = currentInventory;
  const ledger = buildInventoryReviewLedger(inventory);

  assert.doesNotThrow(() => assertInventoryLedgerParity(inventory, ledger));
  assert.throws(
    () => assertInventoryLedgerParity(inventory, ledger.slice(1)),
    /Inventory ledger mismatch/u
  );
  assert.throws(
    () => assertInventoryLedgerParity(inventory, [{ ...ledger[0], id: "bulk-pass" }]),
    /Inventory ledger mismatch/u
  );
});

test("builds a deterministic live inventory summary without locking source changes", () => {
  const snapshot = buildInventorySnapshot(currentInventory);
  const rebuilt = buildInventorySnapshot(
    buildComprehensiveSourceInventory({ repositoryRoot })
  );

  assert.deepEqual(rebuilt, snapshot);
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.categories, [...COMPREHENSIVE_INVENTORY_CATEGORIES]);
  assert.ok(Object.values(snapshot.counts).every((count) => count > 0));
  assert.ok(Object.values(snapshot.categoryFingerprints)
    .every((fingerprint) => /^[a-f0-9]{64}$/u.test(fingerprint)));
  assert.match(snapshot.inventoryFingerprint, /^[a-f0-9]{64}$/u);

  const expanded = structuredClone(currentInventory);
  expanded.adminApi.push({
    ...expanded.adminApi[0],
    id: "live-inventory-change"
  });
  const expandedSnapshot = buildInventorySnapshot(expanded);
  assert.equal(expandedSnapshot.counts.adminApi, snapshot.counts.adminApi + 1);
  assert.notEqual(expandedSnapshot.inventoryFingerprint, snapshot.inventoryFingerprint);
});
