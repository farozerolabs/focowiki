#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { assertCorpusPostgresRows } from
  "./lib/comprehensive-corpus-postgres.mjs";

const reportDirectory = requireReportDirectory();
const corpusReport = readJson(path.join(reportDirectory, "corpus-e2e.json"));
const databaseUrl = requireValidationDatabaseUrl();
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

try {
  const expected = buildExpectedRows(corpusReport);
  const knowledgeBaseIds = [...new Set(expected.map((row) => row.knowledgeBaseId))];
  const expectedBySourceId = new Map(expected.map((row) => [row.sourceFileId, row]));
  const databaseRows = await readDatabaseRows(knowledgeBaseIds);
  const rows = databaseRows.map((row) => {
    const expectedRow = expectedBySourceId.get(row.source_file_id);
    if (!expectedRow) {
      return {
        alias: `unknown-${row.source_file_id}`,
        family: "unknown"
      };
    }
    return {
      alias: expectedRow.alias,
      family: expectedRow.family,
      sourceFileId: row.source_file_id,
      expectedChecksumSha256: expectedRow.expectedChecksumSha256,
      expectedSizeBytes: expectedRow.expectedSizeBytes,
      expectedModelInvocationStatus: expectedRow.expectedModelInvocationStatus,
      sourceStatus: row.source_status,
      sourceDeleted: row.source_deleted,
      safeErrorCode: row.safe_error_code,
      currentRevisionCount: row.current_revision_count,
      sourceChecksumSha256: row.source_checksum_sha256,
      sourceByteCount: number(row.source_byte_count),
      objectState: row.object_state,
      objectChecksumSha256: row.object_checksum_sha256,
      objectByteCount: number(row.object_byte_count),
      sourceObjectOwnerCount: row.source_object_owner_count,
      modelInvocationStatus: row.model_invocation_status,
      modelNameRecorded: row.model_name_recorded,
      activeSemanticGenerationCount: row.active_semantic_generation_count,
      activeSemanticGenerationState: row.active_semantic_generation_state,
      projectionContractCount: row.projection_contract_count,
      reconciliationCount: row.reconciliation_count,
      skeletonSelected: row.skeleton_selected,
      sourceChunkCount: row.source_chunk_count,
      selectedChunkCount: row.selected_chunk_count,
      completedStages: row.completed_stages ?? [],
      liveSemanticStageCount: row.live_semantic_stage_count,
      liveOperationWorkCount: row.live_operation_work_count,
      historicalTerminalStages: row.historical_terminal_stages ?? [],
      activationEventCount: row.activation_event_count,
      latestActivationAt: timestamp(row.latest_activation_at),
      catalogSourceEntryCount: row.catalog_source_entry_count,
      catalogObjectState: row.catalog_object_state,
      activeSnapshotCount: row.active_snapshot_count,
      activeSearchProjectionCount: row.active_search_projection_count,
      activeSearchProjectionState: row.active_search_projection_state,
      activeSearchProviderKind: row.active_search_provider_kind,
      activeVectorDocumentCount: row.active_vector_document_count,
      activeVectorDimensionMismatchCount: row.active_vector_dimension_mismatch_count
    };
  });
  const files = assertCorpusPostgresRows(rows, {
    expectedAliases: expected.map((row) => row.alias),
    expectedProvider: corpusReport.provider
  });
  const output = path.join(reportDirectory, "corpus-postgres-e2e.json");
  const report = {
    kind: "focowiki-comprehensive-corpus-postgres-e2e",
    version: 1,
    generatedAt: new Date().toISOString(),
    ok: true,
    provider: corpusReport.provider,
    counts: {
      expected: expected.length,
      observed: files.length,
      official: files.filter((file) => file.family === "official").length,
      legacy: files.filter((file) => file.family === "legacy").length,
      modelCompleted: files.filter((file) => file.modelInvocation === "completed").length,
      modelSkipped: files.filter((file) => file.modelInvocation === "skipped").length,
      historicalTerminal: files.reduce((sum, file) =>
        sum + file.historicalTerminalCount, 0),
      activeVectorDocuments: files.reduce((sum, file) =>
        sum + file.activeVectorDocumentCount, 0)
    },
    files
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output,
    counts: report.counts
  })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

async function readDatabaseRows(knowledgeBaseIds) {
  return sql`
    SELECT source.public_id AS source_file_id,
           source.status AS source_status,
           source.deleted_at IS NOT NULL AS source_deleted,
           source.safe_error_code,
           source.model_invocation_status,
           source.model_invocation_model_name IS NOT NULL AS model_name_recorded,
           current_revision.current_revision_count,
           revision.checksum_sha256 AS source_checksum_sha256,
           revision.byte_count AS source_byte_count,
           object.state AS object_state,
           object.checksum_sha256 AS object_checksum_sha256,
           object.byte_count AS object_byte_count,
           owner.source_object_owner_count,
           generation.active_semantic_generation_count,
           generation.state AS active_semantic_generation_state,
           contract.projection_contract_count,
           reconciliation.reconciliation_count,
           reconciliation.skeleton_selected,
           reconciliation.source_chunk_count,
           reconciliation.selected_chunk_count,
           stages.completed_stages,
           stages.live_semantic_stage_count,
           stages.historical_terminal_stages,
           live_operation.live_operation_work_count,
           activation.activation_event_count,
           activation.latest_activation_at,
           catalog.catalog_source_entry_count,
           catalog.catalog_object_state,
           snapshot.active_snapshot_count,
           projection.active_search_projection_count,
           projection.state AS active_search_projection_state,
           projection.provider_kind AS active_search_provider_kind,
           vectors.active_vector_document_count,
           vectors.active_vector_dimension_mismatch_count
    FROM focowiki.source_files source
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS current_revision_count,
             max(current.source_revision_public_id) AS source_revision_public_id
      FROM focowiki.source_file_current_revisions current
      WHERE current.knowledge_base_id = source.knowledge_base_id
        AND current.source_file_public_id = source.public_id
    ) current_revision ON true
    LEFT JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = source.knowledge_base_id
     AND revision.source_file_public_id = source.public_id
     AND revision.public_id = current_revision.source_revision_public_id
    LEFT JOIN focowiki.object_registrations object
      ON object.object_id = revision.object_id
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS source_object_owner_count
      FROM focowiki.object_owners source_owner
      WHERE source_owner.knowledge_base_id = source.knowledge_base_id
        AND source_owner.source_revision_public_id = revision.public_id
        AND source_owner.object_id = revision.object_id
        AND source_owner.owner_kind = 'source_revision'
    ) owner ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS active_semantic_generation_count,
             max(semantic.public_id) AS public_id,
             max(semantic.state) AS state
      FROM focowiki.semantic_generations semantic
      WHERE semantic.knowledge_base_id = source.knowledge_base_id
        AND semantic.generation_role = 'active'
        AND semantic.state = 'active'
        AND semantic.deleted_at IS NULL
    ) generation ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS projection_contract_count,
             max(projection_contract.public_id) AS public_id,
             max(projection_contract.resolved_dimension) AS resolved_dimension
      FROM focowiki.semantic_projection_contracts projection_contract
      WHERE projection_contract.knowledge_base_id = source.knowledge_base_id
        AND projection_contract.semantic_generation_public_id = generation.public_id
    ) contract ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS reconciliation_count,
             bool_or(item.skeleton_selected) AS skeleton_selected,
             max(item.source_chunk_count)::integer AS source_chunk_count,
             max(item.selected_chunk_count)::integer AS selected_chunk_count
      FROM focowiki.semantic_source_reconciliations item
      WHERE item.knowledge_base_id = source.knowledge_base_id
        AND item.semantic_generation_public_id = generation.public_id
        AND item.source_file_public_id = source.public_id
        AND item.source_revision_public_id = current_revision.source_revision_public_id
    ) reconciliation ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(
               array_agg(DISTINCT stage.stage_kind ORDER BY stage.stage_kind)
                 FILTER (WHERE stage.state = 'completed'),
               ARRAY[]::text[]
             ) AS completed_stages,
             count(*) FILTER (
               WHERE stage.state IN ('queued', 'running', 'retry')
             )::integer AS live_semantic_stage_count,
             coalesce(
               jsonb_agg(jsonb_build_object(
                 'stageKind', stage.stage_kind,
                 'state', stage.state,
                 'safeErrorCode', stage.safe_error_code,
                 'completedAt', stage.completed_at
               ) ORDER BY stage.completed_at, stage.stage_kind)
                 FILTER (WHERE stage.state IN ('failed', 'cancelled', 'superseded')),
               '[]'::jsonb
             ) AS historical_terminal_stages
      FROM focowiki.semantic_stage_work_items stage
      WHERE stage.knowledge_base_id = source.knowledge_base_id
        AND stage.semantic_generation_public_id = generation.public_id
        AND stage.source_file_public_id = source.public_id
        AND stage.source_revision_public_id = current_revision.source_revision_public_id
    ) stages ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS live_operation_work_count
      FROM focowiki.operation_work_items work
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = work.knowledge_base_id
       AND operation.public_id = work.operation_public_id
      WHERE work.knowledge_base_id = source.knowledge_base_id
        AND (
          operation.target_public_id = source.public_id
          OR operation.target_kind = 'knowledge_base'
        )
    ) live_operation ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS activation_event_count,
             max(event.ended_at) AS latest_activation_at
      FROM focowiki.source_event_summaries event
      WHERE event.knowledge_base_id = source.knowledge_base_id
        AND event.source_file_public_id = source.public_id
        AND event.source_revision_public_id = current_revision.source_revision_public_id
        AND event.stage_key = 'generation_activation'
        AND event.severity = 'info'
    ) activation ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS active_snapshot_count,
             max(active.release_root_public_id) AS release_root_public_id,
             max(active.search_projection_public_id) AS search_projection_public_id
      FROM focowiki.active_snapshots active
      WHERE active.knowledge_base_id = source.knowledge_base_id
    ) snapshot ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS catalog_source_entry_count,
             max(registration.state) AS catalog_object_state
      FROM focowiki.resolve_release_catalog(snapshot.release_root_public_id) entry
      JOIN focowiki.object_registrations registration
        ON registration.object_id = entry.object_id
      WHERE entry.entry_kind = 'source'
        AND entry.source_file_public_id = source.public_id
    ) catalog ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS active_search_projection_count,
             max(search.state) AS state,
             max(search.provider_kind) AS provider_kind
      FROM focowiki.search_projections search
      WHERE search.knowledge_base_id = source.knowledge_base_id
        AND search.public_id = snapshot.search_projection_public_id
        AND search.projection_role = 'active'
    ) projection ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (
               WHERE vector.state = 'active' AND vector.deleted_at IS NULL
             )::integer AS active_vector_document_count,
             count(*) FILTER (
               WHERE vector.state = 'active'
                 AND vector.deleted_at IS NULL
                 AND vector.dimension <> contract.resolved_dimension
             )::integer AS active_vector_dimension_mismatch_count
      FROM focowiki.semantic_vector_documents vector
      WHERE vector.knowledge_base_id = source.knowledge_base_id
        AND vector.semantic_generation_public_id = generation.public_id
        AND vector.source_file_public_id = source.public_id
        AND vector.source_revision_public_id = current_revision.source_revision_public_id
    ) vectors ON true
    WHERE source.knowledge_base_id IN ${sql(knowledgeBaseIds)}
    ORDER BY source.knowledge_base_id, source.public_id
  `;
}

function buildExpectedRows(report) {
  assert(report?.kind === "focowiki-comprehensive-corpus-e2e" && report.ok === true,
    "A successful corpus-e2e.json report is required.");
  assert(report.counts?.total === 200 && Object.keys(report.files ?? {}).length === 200,
    "The corpus report must contain exactly 200 files.");
  const knowledgeBaseByFamily = {
    official: report.knowledgeBases?.official?.id,
    legacy: report.knowledgeBases?.legacy?.id
  };
  return Object.entries(report.files).map(([alias, file]) => {
    const knowledgeBaseId = knowledgeBaseByFamily[file.family];
    assert(knowledgeBaseId && file.sourceFileId, `${alias} is missing durable identities.`);
    assert(file.finalState === "visible" && file.sourceChecksumVerified
      && file.generatedContentVerified, `${alias} is not a successful corpus row.`);
    return {
      alias,
      family: file.family,
      knowledgeBaseId,
      sourceFileId: file.sourceFileId,
      expectedChecksumSha256: file.expectedChecksumSha256,
      expectedSizeBytes: file.expectedSizeBytes,
      expectedModelInvocationStatus: file.modelInvocationStatus
    };
  }).sort((left, right) => left.alias.localeCompare(right.alias));
}

function requireValidationDatabaseUrl() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_DATABASE_URL;
  if (!value) throw new Error("FOCOWIKI_COMPREHENSIVE_DATABASE_URL is required.");
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Comprehensive PostgreSQL evidence requires a loopback database target.");
  }
  return value;
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
  if (
    !value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)
  ) throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory.");
  return path.resolve(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

function number(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("PostgreSQL returned an unsafe integer.");
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
