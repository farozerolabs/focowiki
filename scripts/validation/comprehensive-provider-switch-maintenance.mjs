#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import {
  assertComprehensiveProviderSwitchReuse,
  createComprehensiveMaintenanceIdempotencyKey
} from "./lib/comprehensive-provider-state.mjs";

const adminBaseUrl = process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_BASE_URL?.trim()
  || "http://127.0.0.1:43000";
const adminOrigin = process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_ORIGIN?.trim()
  || "http://127.0.0.1:43100";
const provider = requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_PROVIDER");
const maintenanceAttempt = process.env
  .FOCOWIKI_COMPREHENSIVE_PROVIDER_SWITCH_ATTEMPT?.trim() || "initial";
const knowledgeBaseIds = requiredEnv("FOCOWIKI_COMPREHENSIVE_KNOWLEDGE_BASE_IDS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const reportDirectory = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT_DIR"));
const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_PROVIDER_SWITCH_REPORT?.trim()
    || path.join(reportDirectory, `provider-switch-to-${provider}.json`)
);
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});
let cookie = "";
const report = {
  format: "focowiki-comprehensive-provider-switch-v1",
  provider,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  before: null,
  after: null,
  reuse: null,
  maintenance: [],
  failures: []
};

if (knowledgeBaseIds.length !== 2 || new Set(knowledgeBaseIds).size !== 2) {
  throw new Error("Comprehensive provider switch requires exactly two knowledge bases");
}

try {
  await login();
  report.before = await readReuseSnapshot();
  writePrivateReport(reportPath, report);
  for (const knowledgeBaseId of knowledgeBaseIds) {
    const maintenance = await runMaintenance(knowledgeBaseId);
    report.maintenance.push(maintenance);
    writePrivateReport(reportPath, report);
  }
  report.after = await readReuseSnapshot();
  report.reuse = assertComprehensiveProviderSwitchReuse({
    before: report.before,
    after: report.after
  });
  const active = await readActiveProviderState();
  if (
    active.length !== knowledgeBaseIds.length
    || active.some((row) => row.lexicalProvider !== provider
      || row.vectorProvider !== provider)
  ) {
    throw new Error("Comprehensive provider switch did not activate both provider projections");
  }
  report.active = active;
  report.ok = true;
} catch (error) {
  report.failures.push(safeError(error));
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writePrivateReport(reportPath, report);
  await sql.end({ timeout: 5 });
}

async function login() {
  const response = await fetch(`${adminBaseUrl}/admin/api/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: adminOrigin
    },
    body: JSON.stringify({
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    })
  });
  if (!response.ok) throw new Error(`Admin login returned HTTP ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie) throw new Error("Admin login omitted the session cookie");
}

async function runMaintenance(knowledgeBaseId) {
  const idempotencyKey = createComprehensiveMaintenanceIdempotencyKey({
    provider,
    knowledgeBaseId,
    attempt: maintenanceAttempt
  });
  const acceptedAt = new Date().toISOString();
  const accepted = await adminJson(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/index-maintenance`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: { idempotencyKey }
    },
    202
  );
  if (!accepted.maintenance?.requestId) {
    throw new Error("Index maintenance response omitted its request ID");
  }
  const progress = [];
  const deadline = Date.now() + 30 * 60 * 1_000;
  while (Date.now() < deadline) {
    const summary = await adminJson(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/processing-summary`,
      {},
      200
    );
    const status = summary.indexMaintenance;
    progress.push({
      observedAt: new Date().toISOString(),
      requestId: status.requestId,
      state: status.state,
      stage: status.stage,
      completedCount: status.completedCount,
      expectedCount: status.expectedCount,
      retryCount: status.retryCount,
      lastProgressAt: status.lastProgressAt,
      lastCompletedAt: status.lastCompletedAt,
      safeErrorCode: status.safeErrorCode
    });
    if (status.state === "completed") {
      return {
        knowledgeBaseId,
        acceptedAt,
        result: accepted.result,
        requestId: accepted.maintenance.requestId,
        completedAt: new Date().toISOString(),
        final: progress.at(-1),
        progress
      };
    }
    if (["failed", "superseded", "canceled"].includes(status.state)) {
      throw new Error(
        `Index maintenance ended in ${status.state}: ${status.safeErrorCode ?? "no_safe_code"}`
      );
    }
    writePrivateReport(reportPath, report);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Index maintenance exceeded the 30-minute validation deadline");
}

async function adminJson(pathname, input, expectedStatus) {
  const response = await fetch(`${adminBaseUrl}${pathname}`, {
    method: input.method ?? "GET",
    headers: {
      cookie,
      origin: adminOrigin,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.headers ?? {})
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    let code = "unknown";
    try {
      code = JSON.parse(text)?.error?.code ?? code;
    } catch {
      // The safe status remains sufficient when the response is not JSON.
    }
    throw new Error(`Admin API returned HTTP ${response.status}: ${code}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Admin API returned invalid JSON");
  }
}

async function readReuseSnapshot() {
  const rows = await sql`
    SELECT
      (SELECT count(*) FROM focowiki.embedding_artifacts
       WHERE deleted_at IS NULL)::integer AS embedding_artifact_count,
      (SELECT max(created_at) FROM focowiki.embedding_artifacts
       WHERE deleted_at IS NULL) AS embedding_artifact_watermark,
      (SELECT count(*) FROM focowiki.semantic_generations
       WHERE deleted_at IS NULL)::integer AS semantic_generation_count,
      (SELECT max(created_at) FROM focowiki.semantic_generations
       WHERE deleted_at IS NULL) AS semantic_generation_watermark,
      (SELECT count(*) FROM focowiki.semantic_source_reconciliations)::integer
        AS semantic_reconciliation_count,
      (SELECT count(*) FROM focowiki.source_files
       WHERE model_invocation_status = 'completed'
         AND deleted_at IS NULL)::integer AS completed_model_source_count,
      (SELECT count(*) FROM focowiki.semantic_vector_documents
       WHERE state = 'active' AND deleted_at IS NULL)::integer
        AS active_vector_document_count,
      (SELECT count(*) FROM focowiki.semantic_stage_work_items)::integer
        AS semantic_stage_work_item_count
  `;
  const row = rows[0];
  return {
    embeddingArtifactCount: row.embedding_artifact_count,
    embeddingArtifactWatermark: timestamp(row.embedding_artifact_watermark),
    semanticGenerationCount: row.semantic_generation_count,
    semanticGenerationWatermark: timestamp(row.semantic_generation_watermark),
    semanticReconciliationCount: row.semantic_reconciliation_count,
    completedModelSourceCount: row.completed_model_source_count,
    activeVectorDocumentCount: row.active_vector_document_count,
    semanticStageWorkItemCount: row.semantic_stage_work_item_count
  };
}

async function readActiveProviderState() {
  const rows = await sql`
    SELECT snapshot.knowledge_base_id,
           lexical.provider_kind AS lexical_provider,
           contract.search_provider_kind AS vector_provider,
           lexical.provider_index_uid AS lexical_index_uid,
           lexical.document_count AS lexical_document_count,
           generation.public_id AS semantic_generation_public_id
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections lexical
      ON lexical.knowledge_base_id = snapshot.knowledge_base_id
     AND lexical.public_id = snapshot.search_projection_public_id
     AND lexical.projection_role = 'active'
     AND lexical.state = 'ready'
    JOIN focowiki.semantic_generations generation
      ON generation.knowledge_base_id = snapshot.knowledge_base_id
     AND generation.generation_role = 'active'
     AND generation.state = 'active'
     AND generation.deleted_at IS NULL
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    WHERE snapshot.knowledge_base_id = ANY(${knowledgeBaseIds})
    ORDER BY snapshot.knowledge_base_id COLLATE "C"
  `;
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledge_base_id,
    lexicalProvider: row.lexical_provider,
    vectorProvider: row.vector_provider,
    lexicalIndexUid: row.lexical_index_uid,
    lexicalDocumentCount: Number(row.lexical_document_count),
    semanticGenerationPublicId: row.semantic_generation_public_id
  }));
}

function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return null;
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unknown provider switch error";
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
