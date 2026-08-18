import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { walkFiles } from "./comprehensive-code-inventory.mjs";

const TEST_ROOTS = Object.freeze([
  "apps/api/test",
  "apps/admin/test",
  "apps/api/python/tests",
  "packages/okf/test",
  "scripts/validation/test",
  "scripts/docs/test"
]);

export function buildComprehensiveTestInventory(repositoryRoot) {
  const rows = TEST_ROOTS.flatMap((root) =>
    walkFiles(path.join(repositoryRoot, root), isTestFile).map((filePath) => {
      const source = relative(repositoryRoot, filePath);
      return {
        id: `test-file:${source}`,
        source,
        suite: testSuite(source),
        taxonomy: testTaxonomy(source),
        sha256: hash(fs.readFileSync(filePath))
      };
    })
  ).sort(byId);
  if (rows.length === 0 || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Comprehensive test inventory is empty or duplicated");
  }
  return rows;
}

export function buildComprehensiveTestInventorySnapshot(rows) {
  return {
    schemaVersion: 1,
    count: rows.length,
    suites: countBy(rows, "suite"),
    taxonomies: countBy(rows, "taxonomy"),
    fingerprint: hash(JSON.stringify(rows))
  };
}

export function assertComprehensiveTestInventorySnapshot(rows, expected) {
  if (JSON.stringify(buildComprehensiveTestInventorySnapshot(rows)) !== JSON.stringify(expected)) {
    throw new Error("Comprehensive test inventory snapshot drift detected");
  }
}

export function parseVitestBaselineReport(report, repositoryRoot) {
  const rows = [];
  for (const suite of report.testResults ?? []) {
    for (const [index, result] of (suite.assertionResults ?? []).entries()) {
      rows.push({
        id: `vitest:${relative(repositoryRoot, suite.name)}:${result.fullName}:${index + 1}`,
        runner: "vitest",
        source: relative(repositoryRoot, suite.name),
        title: result.fullName,
        status: normalizeStatus(result.status)
      });
    }
  }
  return rows.sort(byId);
}

export function parseNodeJunitBaselineReport(xml, repositoryRoot) {
  const rows = [];
  let index = 0;
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gmu)) {
    index += 1;
    const attributes = match[1];
    const title = decodeXml(readXmlAttribute(attributes, "name"));
    const source = relative(repositoryRoot, decodeXml(readXmlAttribute(attributes, "file")));
    const body = match[2] ?? "";
    rows.push({
      id: `node-test:${source}:${title}:${index}`,
      runner: "node-test",
      source,
      title,
      status: /<failure\b/u.test(body) ? "failed" : /<skipped\b/u.test(body) ? "skipped" : "passed"
    });
  }
  return rows.sort(byId);
}

function readXmlAttribute(attributes, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(attributes);
  if (!match) throw new Error(`Node test JUnit testcase is missing ${name}`);
  return match[1];
}

export function assertDeterministicBaseline(input) {
  const rows = input.rows ?? [];
  if (rows.length === 0 || new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Deterministic baseline result set is empty or duplicated");
  }
  const failures = rows.filter((row) => row.status === "failed");
  if (failures.length > 0) throw new Error(`Deterministic baseline contains ${failures.length} failures`);
  const dispositions = new Map((input.skipDispositions ?? []).map((item) => [item.id, item]));
  for (const row of rows.filter((item) => item.status === "skipped")) {
    const disposition = dispositions.get(row.id);
    if (!disposition || !disposition.reason || !/^\d+\.\d+$/u.test(disposition.task)) {
      throw new Error(`Deterministic baseline skip has no exact disposition: ${row.id}`);
    }
  }
  for (const id of dispositions.keys()) {
    if (!rows.some((row) => row.id === id && row.status === "skipped")) {
      throw new Error(`Deterministic baseline skip disposition is stale: ${id}`);
    }
  }
}

export function buildDeterministicBaselineSummary(input) {
  assertDeterministicBaseline(input);
  return {
    schemaVersion: 1,
    inventory: input.inventorySnapshot,
    counts: countBy(input.rows, "status"),
    runners: countBy(input.rows, "runner"),
    skipDispositions: [...input.skipDispositions].sort(byId),
    resultFingerprint: hash(JSON.stringify([...input.rows].sort(byId)))
  };
}

function isTestFile(value) {
  return /(?:\.test\.(?:ts|tsx|mjs)|\/test_[^/]+\.py)$/u.test(value);
}

function testSuite(source) {
  if (source.startsWith("apps/api/python/")) return "python-adapter";
  if (source.startsWith("apps/api/")) return "api";
  if (source.startsWith("apps/admin/")) return "admin-ui";
  if (source.startsWith("packages/okf/")) return "okf-package";
  if (source.startsWith("scripts/docs/")) return "documentation";
  return "validation";
}

function testTaxonomy(source) {
  const rules = [
    [/(?:migration|postgres|repository|transaction|partition|database)/u, "database"],
    [/(?:redis)/u, "redis"],
    [/(?:s3|object-store|object-ownership)/u, "s3"],
    [/(?:opensearch|meilisearch|search-provider)/u, "search-provider"],
    [/(?:embedding|vector)/u, "embedding-vector"],
    [/(?:rerank)/u, "reranker"],
    [/(?:graphrag|graph)/u, "graph"],
    [/(?:openapi|swagger)/u, "openapi"],
    [/(?:admin|browser|component|accessibility|i18n)/u, "admin-ui"],
    [/(?:security|auth|origin|host|redact|leak)/u, "security"],
    [/(?:docker|compose|runtime-image|worker-health)/u, "docker-runtime"],
    [/(?:performance|scale|budget|benchmark|concurrency|capacity)/u, "performance"],
    [/(?:generated|okf|markdown|navigation|publication)/u, "generated-content"],
    [/(?:cleanup|deletion|retention|reconciliation|repair)/u, "lifecycle-cleanup"],
    [/(?:architecture|module|boundary|neutrality|scope)/u, "architecture"],
    [/(?:model|generation)/u, "model-transport"]
  ];
  return rules.find(([pattern]) => pattern.test(source))?.[1] ?? "unit-utility";
}

function normalizeStatus(status) {
  if (status === "passed") return "passed";
  if (["skipped", "pending", "todo"].includes(status)) return "skipped";
  return "failed";
}

function countBy(rows, field) {
  return Object.fromEntries([...new Set(rows.map((row) => row[field]))]
    .sort().map((value) => [value, rows.filter((row) => row[field] === value).length]));
}

function decodeXml(value) {
  return value.replaceAll("&quot;", "\"").replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function relative(repositoryRoot, filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}
