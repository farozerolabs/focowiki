#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  createRateLimitedFetch
} from "./lib/storage-vnext-rate-limited-fetch.mjs";
import {
  summarizeStorageVnextScaleReadEvidence
} from "./lib/storage-vnext-scale-read-evidence.mjs";
import {
  createStorageVnextScaleRuntimeEnvironment,
  createStorageVnextValidationProfile
} from "./lib/storage-vnext-scale-scope.mjs";
import {
  STORAGE_VNEXT_10000_BUDGETS
} from "./storage-vnext-scale-budget.mjs";

const REPRESENTATIVE_SOURCE_PATH =
  "01_宪法/中华人民共和国宪法修正案（1988年）__1988-04-12__有效__0a74bc2d55f6.md";
const SEARCH_CASES = Object.freeze([
  ["exact", "中华人民共和国宪法修正案（1988年）__1988-04-12__有效__0a74bc2d55f6", "file"],
  ["title", "中华人民共和国宪法修正案（1988年）", "file"],
  ["path", `pages/${REPRESENTATIVE_SOURCE_PATH}`, "file"],
  ["content", "国家允许私营经济", "file"],
  ["broad", "宪法", "file"],
  ["chinese", "社会主义公有制经济的补充", "file"],
  ["mixed-script", "中华人民共和国宪法修正案 1988 resource", "file"],
  ["multi-term", "私营经济 社会主义公有制经济", "file"],
  ["phrase", "\"国家允许私营经济\"", "file"],
  ["typo", "2c909fdd678bf17901678bf59424000", "file"],
  ["graph", "中华人民共和国宪法修正案 1988", "graph"],
  ["hybrid", "中华人民共和国宪法修正案 1988", "hybrid"]
]);
const WARM_SAMPLE_COUNT = 5;

loadLocalEnv();
const readMode = process.env.FOCOWIKI_STORAGE_VNEXT_READ_MODE?.trim() || "scale";
const profile = createStorageVnextValidationProfile(readMode);
const proofManifest = readJson(path.resolve(requiredEnvironment(
  "FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"
)));
const proof = proofManifest?.proof;
const runtimeEnvironment = createStorageVnextScaleRuntimeEnvironment({
  proof,
  env: process.env
});
Object.assign(process.env, runtimeEnvironment);
const rebuildReportPath = path.join(proof.filesystemScope, profile.rebuildFileName);
const rebuild = readJson(rebuildReportPath);
assertRebuildEvidence(rebuild);
const reportPath = path.join(proof.filesystemScope, profile.readsFileName);
const apiRequire = createRequire(path.resolve("apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(runtimeEnvironment.DATABASE_URL, {
  max: 2,
  idle_timeout: 5,
  connect_timeout: 10
});
const retryingFetch = createRateLimitedFetch({ maximumRetries: 240 });
const origin = requiredEnvironment("ADMIN_PUBLIC_ORIGIN");
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnvironment.ADMIN_API_PORT || "43000"}`,
  fetchImpl: retryingFetch
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnvironment.PUBLIC_OPENAPI_PORT || "43200"}`,
  fetchImpl: retryingFetch
});
const report = {
  kind: profile.readsKind,
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  representativeSourceFileId: null,
  relatedSourceFileId: null,
  measurements: [],
  providerProcessingTimesMs: [],
  latency: null,
  failure: null
};

let credentialId = null;
let adminLoggedIn = false;
try {
  const context = await loadReadContext();
  report.representativeSourceFileId = context.representative.sourceFileId;
  report.relatedSourceFileId = context.relatedSourceFileId;
  await loginAdmin();
  adminLoggedIn = true;
  const credential = await createCredential();
  credentialId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;

  for (const [kind, query, mode] of SEARCH_CASES) {
    const measurement = await measureCase(
      kind,
      () => searchPublic(context, query, mode)
    );
    measurement.relevantSourceFileIds = [context.representative.sourceFileId];
    report.measurements.push(measurement);
    const provider = await searchProvider(context, query, mode);
    report.providerProcessingTimesMs.push(provider.processingTimeMs);
    if (provider.sourceFileIds[0] !== context.representative.sourceFileId) {
      throw new Error(`Scale provider relevance failed: ${kind}`);
    }
    writeProgress(kind, measurement);
  }

  for (const [kind, read] of createNonSearchCases(context)) {
    const measurement = await measureCase(kind, read);
    measurement.relevantSourceFileIds = [];
    report.measurements.push(measurement);
    writeProgress(kind, measurement);
  }

  const summary = summarizeStorageVnextScaleReadEvidence({
    measurements: report.measurements,
    providerProcessingTimesMs: report.providerProcessingTimesMs
  });
  assertReadBudgets(summary);
  report.latency = {
    warmReadP95Ms: summary.warmReadP95Ms,
    coldReadP95Ms: summary.coldReadP95Ms,
    readP99Ms: summary.readP99Ms,
    searchProviderP95Ms: summary.searchProviderP95Ms,
    minimumRecall: summary.minimumRecall,
    minimumNdcg: summary.minimumNdcg
  };
  report.cases = summary.cases;
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    runId: proof.runId,
    knowledgeBaseId: report.knowledgeBaseId,
    caseCount: report.cases.length,
    latency: report.latency,
    reportPath
  }, null, 2)}\n`);
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  if (credentialId && adminLoggedIn) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
      headers: { origin },
      expectedStatus: 204
    }).catch(() => undefined);
  }
  await Promise.allSettled([
    adminLoggedIn
      ? admin.request("/admin/api/logout", { method: "POST", headers: { origin } })
      : Promise.resolve(),
    sql.end({ timeout: 5 })
  ]);
}

async function loadReadContext() {
  const representativeRows = await sql`
    SELECT
      public_id AS "sourceFileId",
      logical_path AS "sourcePath",
      title
    FROM focowiki.source_files
    WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
      AND logical_path = ${REPRESENTATIVE_SOURCE_PATH}
      AND status = 'ready'
      AND deleted_at IS NULL
  `;
  if (representativeRows.length !== 1) {
    throw new Error("Scale representative source identity is unavailable");
  }
  const relatedRows = await sql`
    SELECT node.source_file_public_id AS "sourceFileId"
    FROM focowiki.graph_nodes node
    JOIN focowiki.graph_edges edge
      ON edge.knowledge_base_id = node.knowledge_base_id
      AND (edge.from_node_public_id = node.public_id OR edge.to_node_public_id = node.public_id)
    WHERE node.knowledge_base_id = ${rebuild.knowledgeBaseId}
    GROUP BY node.source_file_public_id, node.logical_path
    ORDER BY count(*) DESC, node.logical_path, node.source_file_public_id
    LIMIT 1
  `;
  if (relatedRows.length !== 1) {
    throw new Error("Scale related-file source identity is unavailable");
  }
  const projectionRows = await sql`
    SELECT provider_index_uid AS "providerIndexUid"
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
      AND projection_role = 'active'
      AND state = 'ready'
  `;
  if (projectionRows.length !== 1) {
    throw new Error("Scale active search projection is unavailable");
  }
  return {
    representative: representativeRows[0],
    relatedSourceFileId: relatedRows[0].sourceFileId,
    providerIndexUid: projectionRows[0].providerIndexUid
  };
}

async function loginAdmin() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnvironment("ADMIN_USERNAME"),
      password: requiredEnvironment("ADMIN_PASSWORD")
    }
  });
}

async function createCredential() {
  const response = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: `storage-vnext-${readMode}-reads-${proof.runId}` },
    expectedStatus: 201
  });
  if (!response.key?.id || !response.oneTimeKey?.rawKey) {
    throw new Error("Scale read credential was not returned");
  }
  return { id: response.key.id, rawKey: response.oneTimeKey.rawKey };
}

async function measureCase(kind, read) {
  const cold = await timed(read);
  const warm = [];
  for (let index = 0; index < WARM_SAMPLE_COUNT; index += 1) {
    warm.push(await timed(read));
  }
  return {
    kind,
    relevantSourceFileIds: [],
    cold,
    warm
  };
}

async function timed(read) {
  const startedAt = performance.now();
  const result = await read();
  return {
    durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    contractPassed: result.contractPassed,
    returnedSourceFileIds: result.returnedSourceFileIds
  };
}

async function searchPublic(context, query, mode) {
  const response = await developer.json(openApiPath(
    `/files/search?query=${encodeURIComponent(query)}&mode=${mode}&limit=10`
  ));
  const sourceFileIds = (response.items ?? []).map((item) => item.sourceFileId);
  return {
    contractPassed: response.searchStatus === "ok"
      && response.searchMode === mode
      && sourceFileIds[0] === context.representative.sourceFileId
      && new Set(sourceFileIds).size === sourceFileIds.length,
    returnedSourceFileIds: sourceFileIds
  };
}

async function searchProvider(context, query, mode) {
  const kinds = mode === "file" ? ["content"]
    : mode === "graph" ? ["graph_seed"]
      : ["content", "graph_seed"];
  const schema = {
    content: "storage-vnext-content-v1",
    graph_seed: "storage-vnext-graph-seed-v1"
  };
  const kindFilter = kinds.map((kind) => (
    `(documentKind = ${JSON.stringify(kind)} AND schemaVersion = ${JSON.stringify(schema[kind])})`
  )).join(" OR ");
  const response = await retryingFetch(new URL(
    `/indexes/${encodeURIComponent(context.providerIndexUid)}/search`,
    requiredEnvironment("MEILI_HOST")
  ), {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnvironment("MEILI_API_KEY")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      filter: `knowledgeBaseId = ${JSON.stringify(rebuild.knowledgeBaseId)} AND (${kindFilter})`,
      limit: 10,
      attributesToSearchOn: ["title", "logicalPath", "searchText", "rankingTerms"],
      attributesToRetrieve: ["sourceFilePublicId"],
      matchingStrategy: "all",
      distinct: "sourceFilePublicId"
    })
  });
  if (!response.ok) {
    throw new Error(`Scale provider search failed with ${response.status}`);
  }
  const body = await response.json();
  return {
    processingTimeMs: body.processingTimeMs,
    sourceFileIds: (body.hits ?? []).map((item) => item.sourceFilePublicId)
  };
}

function createNonSearchCases(context) {
  return [
    ["pagination", async () => {
      const first = await developer.json(openApiPath(
        "/files/search?query=%E5%AE%AA%E6%B3%95&mode=file&limit=1"
      ));
      if (!first.nextCursor || first.items?.length !== 1) {
        return { contractPassed: false, returnedSourceFileIds: [] };
      }
      const second = await developer.json(openApiPath(
        `/files/search?query=%E5%AE%AA%E6%B3%95&mode=file&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`
      ));
      const ids = [...first.items, ...(second.items ?? [])].map((item) => item.sourceFileId);
      return {
        contractPassed: second.items?.length === 1 && new Set(ids).size === ids.length,
        returnedSourceFileIds: ids
      };
    }],
    ["tree", async () => {
      const response = await developer.json(openApiPath("/tree?parentPath=pages&limit=50"));
      return {
        contractPassed: Array.isArray(response.items)
          && response.items.length > 0
          && response.items.every((item) => item.path?.startsWith("pages/")),
        returnedSourceFileIds: []
      };
    }],
    ["file", async () => {
      const response = await developer.json(openApiPath(
        `/files/${encodeURIComponent(context.representative.sourceFileId)}`
      ));
      return {
        contractPassed: response.file?.sourceFileId === context.representative.sourceFileId
          && response.file?.path === `pages/${REPRESENTATIVE_SOURCE_PATH}`,
        returnedSourceFileIds: response.file?.sourceFileId
          ? [response.file.sourceFileId]
          : []
      };
    }],
    ["metadata", async () => {
      const response = await developer.json(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}`
      );
      return {
        contractPassed: response.knowledgeBase?.knowledgeBaseId === rebuild.knowledgeBaseId,
        returnedSourceFileIds: []
      };
    }],
    ["related-file", async () => {
      const response = await developer.json(openApiPath(
        `/files/${encodeURIComponent(context.relatedSourceFileId)}/related?limit=50`
      ));
      return {
        contractPassed: Array.isArray(response.items)
          && response.items.length > 0
          && response.items.every((item) => item.sourceFileId && item.path),
        returnedSourceFileIds: response.items?.map((item) => item.sourceFileId) ?? []
      };
    }]
  ];
}

function assertReadBudgets(summary) {
  const budgets = STORAGE_VNEXT_10000_BUDGETS.latency;
  const failures = [];
  if (summary.warmReadP95Ms > budgets.maximumWarmReadP95Ms) failures.push("warm P95");
  if (summary.coldReadP95Ms > budgets.maximumColdReadP95Ms) failures.push("cold P95");
  if (summary.readP99Ms > budgets.maximumReadP99Ms) failures.push("read P99");
  if (summary.searchProviderP95Ms > budgets.maximumSearchProviderP95Ms) {
    failures.push("provider P95");
  }
  if (summary.minimumRecall < budgets.minimumRecall) failures.push("recall");
  if (summary.minimumNdcg < budgets.minimumNdcg) failures.push("NDCG");
  for (const item of summary.cases) {
    if (item.coldMs > budgets.maximumColdReadP95Ms) failures.push(`${item.kind} cold`);
    if (item.warmP95Ms > budgets.maximumWarmReadP95Ms) failures.push(`${item.kind} warm`);
  }
  if (failures.length > 0) {
    throw new Error(`Scale read budget failed: ${[...new Set(failures)].join(", ")}`);
  }
}

function openApiPath(suffix) {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}${suffix}`;
}

function assertRebuildEvidence(value) {
  if (
    value?.kind !== profile.rebuildKind
    || value.runId !== proof.runId
    || value.corpus?.fileCount !== profile.expectedFileCount
    || value.failure !== null
    || !value.knowledgeBaseId
    || value.convergence?.readySources !== profile.expectedFileCount
    || value.convergence?.activeUnifiedIndexes !== 1
  ) throw new Error(`Completed ${profile.expectedFileCount}-file rebuild evidence is required`);
}

function writeProgress(kind, measurement) {
  process.stdout.write(`${JSON.stringify({
    phase: `${readMode}-read`,
    kind,
    coldMs: measurement.cold.durationMs,
    warmSamples: measurement.warm.length
  })}\n`);
  writeReport();
}

function writeReport() {
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for scale reads`);
  return value;
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}
