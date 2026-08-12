import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  COMPREHENSIVE_INVENTORY_CATEGORIES,
  assertInventoryLedgerParity,
  assertInventorySnapshot,
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

  assert.equal(operations.length, 43);
  assert.ok(inventory.some((item) => item.kind === "request-field"));
  assert.ok(inventory.some((item) => item.kind === "response-field"));
  assert.ok(inventory.some((item) => item.kind === "response-status"));
  assert.ok(inventory.some((item) => item.kind === "security"));
  assert.ok(inventory.some((item) => item.kind === "example"));
  assert.equal(inventory.filter((item) => item.kind === "documentation").length, 86);
  assert.equal(inventory.filter((item) => item.kind === "swagger-entry").length, 43);
  assert.equal(new Set(inventory.map((item) => item.id)).size, inventory.length);
});

test("builds every source-derived release-audit inventory category", () => {
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
  assert.equal(postgresTables.length, 82);
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
    "apps/api/src/semantic/application/stage-worker.ts",
    "apps/api/src/semantic/infrastructure/source-stage-production-runtime.ts",
    "apps/api/src/storage-vnext/source-processing/worker.ts",
    "apps/api/src/storage-vnext/publication/worker.ts",
    "apps/api/src/storage-vnext/maintenance/production-runtime.ts",
    "apps/api/src/storage-vnext/deletion/deletion-worker.ts",
    "apps/api/src/storage-vnext/search/provider-index-cleanup-worker.ts",
    "apps/api/src/storage-vnext/webhook/worker.ts"
  ]) {
    assert.ok(workerSources.has(sourcePath), sourcePath);
  }
  const workerValues = new Set(inventory.workers
    .filter((item) => item.kind === "worker-value")
    .map((item) => item.name));
  for (const stage of [
    "extraction",
    "reconciliation",
    "embedding",
    "community",
    "vector",
    "publication",
    "validation",
    "cleanup"
  ]) {
    assert.ok(workerValues.has(stage), stage);
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
  assert.deepEqual(
    [...new Set(bodyFields.map((item) => item.name))].sort(),
    [
      "configuration",
      "declaredByteCount",
      "declaredFileCount",
      "description",
      "entries",
      "expectedResourceRevision",
      "expectedRevision",
      "idempotencyKey",
      "name",
      "password",
      "relativePath",
      "sourceFileIds",
      "username"
    ]
  );
  assert.equal(bodyFields.some((item) => item.name === "sql"), false);
  assert.equal(bodyFields.some((item) => item.name === "js"), false);
  assert.equal(bodyFields.some((item) => item.name === "mutations"), false);
});

test("Admin API UI consumers resolve an exact HTTP method", () => {
  const consumers = currentInventory.adminApi.filter((item) => item.kind === "ui-consumer");

  assert.equal(consumers.length, 63);
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

test("fails when the reviewed source snapshot drifts", () => {
  const inventory = currentInventory;
  const snapshot = JSON.parse(
    fs.readFileSync(
      "scripts/validation/fixtures/comprehensive-release-inventory.json",
      "utf8"
    )
  );

  assert.doesNotThrow(() => assertInventorySnapshot(inventory, snapshot));
  const drifted = structuredClone(snapshot);
  drifted.counts.adminApi -= 1;
  assert.throws(() => assertInventorySnapshot(inventory, drifted), /inventory snapshot drift/u);
  assert.deepEqual(buildInventorySnapshot(inventory), snapshot);
});
