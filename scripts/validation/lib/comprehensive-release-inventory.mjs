import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildAdminApiInventory,
  buildAdminUiInventory,
  buildConfigurationInventory
} from "./comprehensive-code-inventory.mjs";
import { buildDeveloperOpenApiInventory } from "./comprehensive-openapi-inventory.mjs";
import {
  buildDockerInventory,
  buildDocsInventory,
  buildPostgresInventory,
  buildSubsystemInventories
} from "./comprehensive-persistence-inventory.mjs";

export const COMPREHENSIVE_INVENTORY_CATEGORIES = Object.freeze([
  "developerOpenApi",
  "adminApi",
  "adminUi",
  "configuration",
  "postgres",
  "redis",
  "s3",
  "opensearch",
  "meilisearch",
  "vector",
  "workers",
  "generated",
  "docker",
  "docs"
]);

export function buildComprehensiveSourceInventory({ repositoryRoot }) {
  const openApiDocument = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "docs/public/openapi/focowiki-openapi.json"), "utf8")
  );
  const subsystems = buildSubsystemInventories(repositoryRoot);
  const inventory = {
    developerOpenApi: buildDeveloperOpenApiInventory(openApiDocument),
    adminApi: buildAdminApiInventory(repositoryRoot),
    adminUi: buildAdminUiInventory(repositoryRoot),
    configuration: buildConfigurationInventory(repositoryRoot),
    postgres: buildPostgresInventory(repositoryRoot),
    redis: subsystems.redis,
    s3: subsystems.s3,
    opensearch: subsystems.opensearch,
    meilisearch: subsystems.meilisearch,
    vector: subsystems.vector,
    workers: subsystems.workers,
    generated: subsystems.generated,
    docker: buildDockerInventory(repositoryRoot),
    docs: buildDocsInventory(repositoryRoot)
  };

  for (const category of COMPREHENSIVE_INVENTORY_CATEGORIES) {
    const items = inventory[category];
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`Comprehensive source inventory category is empty: ${category}`);
    }
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Comprehensive source inventory contains duplicates: ${category}`);
    }
  }
  return inventory;
}

export function buildInventoryReviewLedger(inventory) {
  return flattenInventory(inventory).map(({ category, item }) => ({
    id: `${category}::${item.id}`,
    category,
    sourceId: item.id,
    automatedStatus: "pending",
    manualStatus: "pending",
    expectedEvidence: ["automated", "manual"]
  }));
}

export function assertInventoryLedgerParity(inventory, ledger) {
  const expected = buildInventoryReviewLedger(inventory).map((item) => item.id);
  const actual = Array.isArray(ledger) ? ledger.map((item) => item?.id) : [];
  const missing = expected.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !expected.includes(id));
  if (
    missing.length > 0
    || extra.length > 0
    || actual.some((id) => !id || id === "bulk-pass")
    || new Set(actual).size !== actual.length
  ) {
    throw new Error(`Inventory ledger mismatch: missing=${missing.length} extra=${extra.length}`);
  }
}

export function buildInventorySnapshot(inventory) {
  const categoryFingerprints = Object.fromEntries(
    COMPREHENSIVE_INVENTORY_CATEGORIES.map((category) => [
      category,
      createHash("sha256").update(stableStringify(inventory[category])).digest("hex")
    ])
  );
  return {
    schemaVersion: 1,
    categories: [...COMPREHENSIVE_INVENTORY_CATEGORIES],
    counts: Object.fromEntries(
      COMPREHENSIVE_INVENTORY_CATEGORIES.map((category) => [category, inventory[category].length])
    ),
    categoryFingerprints,
    inventoryFingerprint: createHash("sha256")
      .update(stableStringify(categoryFingerprints))
      .digest("hex")
  };
}

function flattenInventory(inventory) {
  return COMPREHENSIVE_INVENTORY_CATEGORIES.flatMap((category) =>
    inventory[category].map((item) => ({ category, item }))
  ).sort((left, right) =>
    `${left.category}:${left.item.id}`.localeCompare(`${right.category}:${right.item.id}`)
  );
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
