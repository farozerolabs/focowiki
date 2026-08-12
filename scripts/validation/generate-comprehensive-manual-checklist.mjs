#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  buildComprehensiveManualChecklist
} from "./lib/comprehensive-manual-checklist.mjs";

const reportDirectory = requireReportDirectory();
const outputPath = path.join(reportDirectory, "comprehensive-manual-checklist.json");

const files = Object.freeze({
  inventory: "source-inventory.json",
  corpus: "corpus-expectation-ledger.json",
  generated: "manual-generated-ui-ledger.json",
  search: "search-provider-opensearch-expanded-ownership-fix-current-final.json",
  vector: "vector-oracle-opensearch-post-crud-current-ids-retry-aware.json",
  crud: "comprehensive-crud-results.ndjson",
  directory: "comprehensive-directory-lifecycle-results-corrected.ndjson",
  adminSecurity: "admin-api-security-expanded-after-proxy-fix.json",
  openApiSecurity: "developer-openapi-security-after-proxy-fix.json",
  fault: "docker-live-fault-opensearch.json",
  settings: "runtime-settings-fields.json",
  postgres: "postgres-table-ledger-post-complete-directory-lifecycle.json",
  redis: "redis-runtime-ledger-current.json",
  s3: "s3-runtime-ledger-current.json",
  openSearch: "search-provider-opensearch-state-ownership-fix-current-final.json",
  meilisearch: "search-provider-meilisearch-state-ownership-fix-current.json",
  meilisearchTasks: "meilisearch-task-ledger-post-crud-current-ids.json",
  worker: "worker-runtime-ledger-post-load.json",
  docker: "docker-runtime-ledger-opensearch-current.json"
});

const ndjsonKeys = new Set(["crud", "directory"]);
const evidence = Object.fromEntries(Object.entries(files)
  .filter(([key]) => !ndjsonKeys.has(key))
  .map(([key, fileName]) => [key, readJson(fileName)]));
const crudCases = await readNdjsonCases(files.crud);
const directoryCases = await readNdjsonCases(files.directory);
const collections = [
  inventoryCollection(evidence.inventory),
  collection(files.corpus, "corpus-file", evidence.corpus.rows, (item) => item.id),
  collection(files.generated, "generated-item", evidence.generated.rows, (item) => item.id),
  searchQueryCollection(evidence.search),
  collection(files.vector, "vector-artifact", evidence.vector.artifacts,
    (item) => item.artifactPublicId),
  collection(files.vector, "vector-query", evidence.vector.queries,
    (item) => `${item.queryId}:${item.family}`),
  collection(files.crud, "crud-case", crudCases, (item) => item.id),
  collection(files.directory, "directory-case", directoryCases, (item) => item.id),
  indexedCollection(files.adminSecurity, "admin-security-case", evidence.adminSecurity.rows,
    (item) => `${item.routeId}:${item.case}`),
  indexedCollection(files.openApiSecurity, "openapi-security-case", evidence.openApiSecurity.rows,
    (item) => `${item.operationId}:${item.case}`),
  collection(files.fault, "fault-case", evidence.fault.results, (item) => item.id),
  collection(files.settings, "setting-field", evidence.settings.fields, (item) => item.id),
  collection(files.postgres, "postgres-table", evidence.postgres.rows,
    (item) => item.tableName),
  collection(files.redis, "redis-responsibility", evidence.redis.rows,
    (item) => item.responsibility),
  collection(files.s3, "s3-registration", evidence.s3.registrations,
    (item) => item.registrationFingerprint),
  collection(files.s3, "s3-owner", evidence.s3.owners,
    (item) => `${item.ownerFingerprint}:${item.ownerTargetFingerprint}`),
  collection(files.s3, "s3-object", evidence.s3.currentObjects,
    (item) => item.storageKeyFingerprint),
  collection(files.s3, "s3-version", evidence.s3.versions,
    (item) => `${item.storageKeyFingerprint}:${item.versionFingerprint}`),
  ...providerCollections("opensearch", files.openSearch, evidence.openSearch),
  ...providerCollections("meilisearch", files.meilisearch, evidence.meilisearch),
  meilisearchTaskCollection(evidence.meilisearchTasks),
  ...workerCollections(evidence.worker),
  collection(files.docker, "docker-service", evidence.docker.services,
    (item) => item.service)
];
const requiredCategories = collections.map((item) => item.category);
if (new Set(requiredCategories).size !== requiredCategories.length) {
  throw new Error("Comprehensive manual checklist collection categories must be unique");
}

const report = buildComprehensiveManualChecklist({
  runId: path.basename(reportDirectory),
  applicationFingerprint: currentWorktreeFingerprint(),
  requiredCategories,
  collections
});
const inputEvidence = Object.fromEntries(await Promise.all(Object.values(files).map(
  async (fileName) => [fileName, await sha256File(path.join(reportDirectory, fileName))]
)));
const persistedReport = { ...report, inputEvidence };
fs.writeFileSync(outputPath, `${JSON.stringify(persistedReport, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputPath,
  totalItems: report.totalItems,
  counts: report.counts,
  checklistFingerprintSha256: report.checklistFingerprintSha256
})}\n`);

function inventoryCollection(report) {
  const items = Object.entries(report.inventory).flatMap(([category, values]) =>
    values.map((item) => ({ id: `${category}:${item.id}` })));
  return collection(files.inventory, "inventory", items, (item) => item.id);
}

function searchQueryCollection(report) {
  const items = report.rows.flatMap((row) => row.queries.map((query) => ({
    id: `${row.alias}:${query.variant}`,
    automatedStatus: query.status === 200 && query.found && query.scopeMatches ? "pass" : "fail"
  })));
  return collection(files.search, "search-query", items, (item) => item.id);
}

function providerCollections(provider, source, report) {
  const indexes = [
    ...(report.clusterReconciliation?.indexes ?? []),
    ...(report.clusterReconciliation?.retainedIndexes ?? [])
  ];
  const lexicalDocuments = report.knowledgeBases.flatMap((knowledgeBase) =>
    knowledgeBase.lexical.documents.map((item) => ({
      ...item,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId
    })));
  const vectorDocuments = report.knowledgeBases.flatMap((knowledgeBase) =>
    knowledgeBase.vector.documents.map((item) => ({
      ...item,
      knowledgeBaseId: knowledgeBase.knowledgeBaseId
    })));
  const mappingFields = report.knowledgeBases.flatMap((knowledgeBase) =>
    ["lexical", "vector"].flatMap((lane) =>
      knowledgeBase.providerEvidence[lane].mappingFields.map((field) => ({
        id: `${knowledgeBase.knowledgeBaseId}:${lane}:${field}`
      }))));
  return [
    collection(source, `${provider}-index`, indexes, (item) => item.indexUid),
    collection(source, `${provider}-document`, lexicalDocuments,
      (item) => `${item.knowledgeBaseId}:${item.id}`),
    collection(source, `${provider}-vector-document`, vectorDocuments,
      (item) => `${item.knowledgeBaseId}:${item.id}`),
    collection(source, `${provider}-mapping-field`, mappingFields, (item) => item.id)
  ];
}

function meilisearchTaskCollection(report) {
  const tasks = Array.isArray(report.items)
    ? report.items
    : Array.isArray(report.tasks)
      ? report.tasks
      : report.rows;
  return indexedCollection(files.meilisearchTasks, "meilisearch-task", tasks,
    (item) => String(item.taskUid ?? item.uid ?? item.identity ?? "task"));
}

function workerCollections(report) {
  return [
    optionalCollection(files.worker, "worker-stage-item", report.stageItems,
      (item) => `${item.stageKind}:${item.identity}`),
    optionalCollection(files.worker, "worker-operation-item", report.operationItems,
      (item) => `${item.workKind}:${item.identity}`),
    optionalCollection(files.worker, "worker-dirty-item", report.dirtyItems,
      (item) => `${item.reasonKind}:${item.identity}`),
    optionalCollection(files.worker, "worker-cleanup-item", report.cleanupItems,
      (item) => `${item.actionKind}:${item.identity}`)
  ].filter(Boolean);
}

function optionalCollection(source, category, items, identify) {
  return Array.isArray(items) && items.length > 0
    ? collection(source, category, items, identify)
    : null;
}

function indexedCollection(source, category, items, identify) {
  return collection(source, category, items, (item, index) =>
    `${String(index + 1).padStart(6, "0")}:${identify(item)}`);
}

function collection(source, category, items, identify) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`Comprehensive manual checklist source is empty: ${source}:${category}`);
  }
  return {
    category,
    source,
    granularity: "item",
    items: items.map((item, index) => ({
      id: requiredId(identify(item, index), `${source}:${category}:${index + 1}`),
      automatedStatus: automatedStatus(item),
      sourcePointer: `${source}#${index + 1}`,
      evidenceHash: evidenceHash(item)
    }))
  };
}

function automatedStatus(item) {
  if (item?.pass === true || item?.ok === true || item?.status === "passed"
    || item?.automatedStatus === "pass") return "pass";
  if (item?.pass === false || item?.ok === false || item?.status === "failed"
    || item?.automatedStatus === "fail") return "fail";
  return "pending";
}

function evidenceHash(item) {
  for (const key of ["evidenceHash", "evidenceSha256", "sha256"]) {
    if (/^[a-f0-9]{64}$/u.test(String(item?.[key] ?? ""))) return item[key];
  }
  return sha256(Buffer.from(JSON.stringify(item)));
}

async function readNdjsonCases(fileName) {
  const items = [];
  const input = fs.createReadStream(path.join(reportDirectory, fileName), { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.kind === "case") items.push(row);
  }
  if (items.length === 0) throw new Error(`Comprehensive manual checklist NDJSON has no cases: ${fileName}`);
  return items;
}

function readJson(fileName) {
  const filePath = path.join(reportDirectory, fileName);
  if (!fs.existsSync(filePath)) throw new Error(`Comprehensive manual checklist input is missing: ${fileName}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR?.trim();
  if (!value || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  return path.resolve(value);
}

function requiredId(value, context) {
  const id = String(value ?? "").trim();
  if (!id) throw new Error(`Comprehensive manual checklist item ID is missing: ${context}`);
  return id;
}

function currentWorktreeFingerprint() {
  const hash = createHash("sha256");
  hash.update(execFileSync("git", ["rev-parse", "HEAD"]));
  hash.update(execFileSync("git", ["diff", "--binary", "HEAD"], {
    maxBuffer: 256 * 1024 * 1024
  }));
  const untracked = execFileSync(
    "git", ["ls-files", "--others", "--exclude-standard", "-z"]
  ).toString("utf8").split("\0").filter(Boolean).sort();
  for (const relativePath of untracked) {
    hash.update(relativePath);
    const absolutePath = path.resolve(relativePath);
    if (fs.statSync(absolutePath).isFile()) hash.update(fs.readFileSync(absolutePath));
  }
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
