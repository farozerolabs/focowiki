#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const adminBaseUrl = optionalEnv(
  "FOCOWIKI_COMPREHENSIVE_ADMIN_BASE_URL",
  "http://127.0.0.1:43000"
);
const adminOrigin = optionalEnv(
  "FOCOWIKI_COMPREHENSIVE_ADMIN_ORIGIN",
  "http://127.0.0.1:43100"
);
const knowledgeBaseId = requiredEnv("FOCOWIKI_COMPREHENSIVE_KNOWLEDGE_BASE_ID");
const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const reportPath = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT"));
const idempotencyKey = requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_MAINTENANCE_IDEMPOTENCY_KEY"
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
  format: "focowiki-comprehensive-embedding-adoption-v1",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  knowledgeBaseId,
  requestId: null,
  before: null,
  progress: [],
  after: null,
  failures: []
};

try {
  await login();
  report.before = await readBefore();
  writeReport();
  const accepted = await adminJson(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/index-maintenance`,
    {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: { idempotencyKey }
    },
    202
  );
  report.requestId = accepted.maintenance?.requestId ?? null;
  if (!report.requestId) throw new Error("Maintenance response omitted requestId");
  await waitForMaintenance();
  report.after = await readAfter(report.before.activeGenerationPublicId);
  assertEmbeddingOnlyAdoption(report.before, report.after);
  report.ok = true;
} catch (error) {
  report.failures.push(safeError(error));
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeReport();
  await sql.end({ timeout: 5 });
}

process.stdout.write(`${JSON.stringify(report)}\n`);

async function login() {
  const response = await fetch(`${adminBaseUrl}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: adminOrigin },
    body: JSON.stringify({
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    })
  });
  if (!response.ok) throw new Error(`Admin login returned HTTP ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie) throw new Error("Admin login omitted the session cookie");
}

async function waitForMaintenance() {
  const deadline = Date.now() + 20 * 60 * 1_000;
  let lastProgressKey = "";
  while (Date.now() < deadline) {
    const summary = await adminJson(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/processing-summary`,
      {},
      200
    );
    const status = summary.indexMaintenance;
    const observation = {
      observedAt: new Date().toISOString(),
      requestId: status.requestId,
      state: status.state,
      stage: status.stage,
      completedCount: status.completedCount,
      expectedCount: status.expectedCount,
      retryCount: status.retryCount,
      safeErrorCode: status.safeErrorCode
    };
    report.progress.push(observation);
    const progressKey = [
      observation.state,
      observation.stage,
      observation.completedCount,
      observation.expectedCount,
      observation.safeErrorCode
    ].join(":");
    if (progressKey !== lastProgressKey) {
      process.stderr.write(`maintenance ${progressKey}\n`);
      lastProgressKey = progressKey;
    }
    writeReport();
    if (status.state === "completed") return;
    if (["failed", "superseded", "canceled"].includes(status.state)) {
      throw new Error(
        `Maintenance ended in ${status.state}: ${status.safeErrorCode ?? "no_safe_code"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Maintenance exceeded the 20-minute validation deadline");
}

async function readBefore() {
  const [row] = await sql`
    SELECT generation.public_id AS active_generation_public_id,
      contract.embedding_configuration_revision_public_id,
      (SELECT count(*)::integer
       FROM focowiki.source_files source
       JOIN focowiki.source_file_current_revisions current_revision
         ON current_revision.knowledge_base_id = source.knowledge_base_id
        AND current_revision.source_file_public_id = source.public_id
       WHERE source.knowledge_base_id = ${knowledgeBaseId}
         AND source.status = 'ready'
         AND source.deleted_at IS NULL) AS source_count,
      (SELECT count(*)::integer
       FROM focowiki.source_files source
       WHERE source.knowledge_base_id = ${knowledgeBaseId}
         AND source.model_invocation_status = 'completed'
         AND source.deleted_at IS NULL) AS model_invocation_count,
      (SELECT max(model_invocation_ended_at)
       FROM focowiki.source_files source
       WHERE source.knowledge_base_id = ${knowledgeBaseId}
         AND source.deleted_at IS NULL) AS model_invocation_watermark
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.semantic_generation_public_id = generation.public_id
     AND contract.knowledge_base_id = generation.knowledge_base_id
    WHERE generation.knowledge_base_id = ${knowledgeBaseId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
  `;
  if (!row) throw new Error("Active semantic generation is missing");
  return {
    activeGenerationPublicId: row.active_generation_public_id,
    embeddingConfigurationRevisionPublicId:
      row.embedding_configuration_revision_public_id,
    sourceCount: row.source_count,
    modelInvocationCount: row.model_invocation_count,
    modelInvocationWatermark: timestamp(row.model_invocation_watermark)
  };
}

async function readAfter(predecessorPublicId) {
  const [generation] = await sql`
    SELECT generation.public_id, generation.generation_role, generation.state,
      contract.embedding_configuration_revision_public_id
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.semantic_generation_public_id = generation.public_id
     AND contract.knowledge_base_id = generation.knowledge_base_id
    WHERE generation.knowledge_base_id = ${knowledgeBaseId}
      AND generation.operation_public_id = ${report.requestId}
      AND generation.deleted_at IS NULL
    ORDER BY generation.created_at DESC
    LIMIT 1
  `;
  if (!generation) throw new Error("Adopted semantic generation is missing");
  const stages = await sql`
    SELECT stage_kind, state, count(*)::integer AS count
    FROM focowiki.semantic_stage_work_items
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND operation_public_id = ${report.requestId}
      AND semantic_generation_public_id = ${generation.public_id}
    GROUP BY stage_kind, state
    ORDER BY stage_kind COLLATE "C", state COLLATE "C"
  `;
  const factCounts = await readFactCounts(predecessorPublicId, generation.public_id);
  const [runtime] = await sql`
    SELECT
      (SELECT count(*)::integer
       FROM focowiki.source_files source
       WHERE source.knowledge_base_id = ${knowledgeBaseId}
         AND source.model_invocation_status = 'completed'
         AND source.deleted_at IS NULL) AS model_invocation_count,
      (SELECT max(model_invocation_ended_at)
       FROM focowiki.source_files source
       WHERE source.knowledge_base_id = ${knowledgeBaseId}
         AND source.deleted_at IS NULL) AS model_invocation_watermark,
      (SELECT count(*)::integer
       FROM focowiki.semantic_vector_documents vector
       WHERE vector.knowledge_base_id = ${knowledgeBaseId}
         AND vector.semantic_generation_public_id = ${generation.public_id}
         AND vector.state = 'active'
         AND vector.deleted_at IS NULL) AS active_vector_count,
      (SELECT count(*)::integer
       FROM focowiki.semantic_embedding_artifact_refs reference
       WHERE reference.knowledge_base_id = ${knowledgeBaseId}
         AND reference.semantic_generation_public_id = ${generation.public_id})
        AS embedding_reference_count
  `;
  return {
    generation: {
      publicId: generation.public_id,
      role: generation.generation_role,
      state: generation.state,
      embeddingConfigurationRevisionPublicId:
        generation.embedding_configuration_revision_public_id
    },
    stages,
    factCounts,
    modelInvocationCount: runtime.model_invocation_count,
    modelInvocationWatermark: timestamp(runtime.model_invocation_watermark),
    activeVectorCount: runtime.active_vector_count,
    embeddingReferenceCount: runtime.embedding_reference_count
  };
}

async function readFactCounts(predecessorPublicId, candidatePublicId) {
  return sql`
    WITH fact_rows AS (
      SELECT 'semantic_source_reconciliations' AS table_name,
        semantic_generation_public_id FROM focowiki.semantic_source_reconciliations
      WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_entities', semantic_generation_public_id
        FROM focowiki.semantic_entities WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_entity_aliases', semantic_generation_public_id
        FROM focowiki.semantic_entity_aliases WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_evidence', semantic_generation_public_id
        FROM focowiki.semantic_evidence WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_mentions', semantic_generation_public_id
        FROM focowiki.semantic_mentions WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_entity_observations', semantic_generation_public_id
        FROM focowiki.semantic_entity_observations WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_relationships', semantic_generation_public_id
        FROM focowiki.semantic_relationships WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_relationship_evidence', semantic_generation_public_id
        FROM focowiki.semantic_relationship_evidence WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_relationship_observations', semantic_generation_public_id
        FROM focowiki.semantic_relationship_observations WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_reverse_references', semantic_generation_public_id
        FROM focowiki.semantic_reverse_references WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_communities', semantic_generation_public_id
        FROM focowiki.semantic_communities WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_community_memberships', semantic_generation_public_id
        FROM focowiki.semantic_community_memberships WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_community_reports', semantic_generation_public_id
        FROM focowiki.semantic_community_reports WHERE knowledge_base_id = ${knowledgeBaseId}
      UNION ALL SELECT 'semantic_entity_partitions', semantic_generation_public_id
        FROM focowiki.semantic_entity_partitions WHERE knowledge_base_id = ${knowledgeBaseId}
    )
    SELECT table_name,
      count(*) FILTER (WHERE semantic_generation_public_id = ${predecessorPublicId})::integer
        AS predecessor_count,
      count(*) FILTER (WHERE semantic_generation_public_id = ${candidatePublicId})::integer
        AS candidate_count
    FROM fact_rows
    WHERE semantic_generation_public_id IN (${predecessorPublicId}, ${candidatePublicId})
    GROUP BY table_name
    ORDER BY table_name COLLATE "C"
  `;
}

function assertEmbeddingOnlyAdoption(before, after) {
  const expectedStages = new Map([
    ["embedding", before.sourceCount],
    ["vector", before.sourceCount]
  ]);
  if (after.stages.length !== expectedStages.size) {
    throw new Error("Embedding-only maintenance planned unexpected stage kinds");
  }
  for (const stage of after.stages) {
    if (stage.state !== "completed"
      || expectedStages.get(stage.stage_kind) !== stage.count) {
      throw new Error("Embedding-only stage count or state is invalid");
    }
  }
  if (after.generation.role !== "active" || after.generation.state !== "active") {
    throw new Error("Embedding-only semantic generation was not activated");
  }
  if (after.generation.embeddingConfigurationRevisionPublicId
    === before.embeddingConfigurationRevisionPublicId) {
    throw new Error("Embedding-only maintenance did not adopt the current revision");
  }
  if (after.factCounts.length !== 14
    || after.factCounts.some((row) =>
      row.predecessor_count !== row.candidate_count)) {
    throw new Error("Reusable graph fact parity failed");
  }
  if (after.modelInvocationCount !== before.modelInvocationCount
    || after.modelInvocationWatermark !== before.modelInvocationWatermark) {
    throw new Error("Embedding-only maintenance repeated generation model work");
  }
  if (after.activeVectorCount < before.sourceCount
    || after.embeddingReferenceCount < before.sourceCount) {
    throw new Error("Embedding-only maintenance did not build vector artifacts");
  }
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
      // HTTP status and safe code are sufficient for this private validation report.
    }
    throw new Error(`Admin API returned HTTP ${response.status}: ${code}`);
  }
  return JSON.parse(text);
}

function writeReport() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  };
}

function optionalEnv(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
