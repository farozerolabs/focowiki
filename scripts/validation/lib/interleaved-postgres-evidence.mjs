import { createRequire } from "node:module";
import { sanitizeEvidenceValue } from "./interleaved-evidence-redaction.mjs";

const require = createRequire(
  new URL("../../../apps/api/package.json", import.meta.url)
);
const postgres = require("postgres");

const KNOWLEDGE_BASE_QUERY_NAMES = Object.freeze([
  "knowledgeBase",
  "uploadSessions",
  "uploadEntries",
  "operations",
  "operationTargets",
  "sourceDirectories",
  "sourceFiles",
  "sourceRevisions",
  "dispatchMarkers",
  "sourceEvents",
  "deletionIntents",
  "roleJobs",
  "generations",
  "publicationProgress",
  "publicationImpacts",
  "publicationSubtasks",
  "projectionInputs",
  "generationProjections",
  "generationObjectRefs",
  "immutableObjects",
  "activeProjections",
  "projectionRepairs",
  "projectionRepairSubtasks",
  "lexicalRebuilds",
  "lexicalWorkItems",
  "compactionJobs",
  "cleanupObjectDeletions"
]);

const GLOBAL_QUERY_NAMES = Object.freeze([
  "globalCounts",
  "globalRuntimeSettings",
  "globalWorkers",
  "globalKnowledgeBases",
  "globalImmutableObjects"
]);

export function createInterleavedPostgresEvidence(input) {
  const sql = input.sql ?? (
    input.databaseUrl
      ? postgres(input.databaseUrl, { max: 2, prepare: false })
      : null
  );
  const query = input.query ?? (sql ? createQueryExecutor(sql) : null);
  if (!query) {
    throw new Error("PostgreSQL evidence requires a query executor or database URL.");
  }

  return {
    async snapshotGlobal() {
      const entries = await Promise.all(
        GLOBAL_QUERY_NAMES.map(async (name) => [name, await query(name, null)])
      );
      const raw = Object.fromEntries(entries);
      return sanitizeEvidenceValue({
        capturedAt: new Date().toISOString(),
        counts: raw.globalCounts?.[0] ?? {},
        runtimeSettings: raw.globalRuntimeSettings ?? [],
        workers: raw.globalWorkers ?? [],
        knowledgeBases: raw.globalKnowledgeBases ?? [],
        immutableObjects: raw.globalImmutableObjects ?? []
      });
    },
    async snapshotKnowledgeBase(knowledgeBaseId) {
      if (!knowledgeBaseId) {
        throw new Error("PostgreSQL evidence requires a knowledge-base identity.");
      }

      const entries = await Promise.all(
        KNOWLEDGE_BASE_QUERY_NAMES.map(async (name) => [
          name,
          await query(name, knowledgeBaseId)
        ])
      );
      const raw = Object.fromEntries(entries);
      const knowledgeBase = raw.knowledgeBase?.[0];
      if (!knowledgeBase) {
        throw new Error("Knowledge base evidence was not found.");
      }
      if (knowledgeBase.id !== knowledgeBaseId) {
        throw new Error("Knowledge base evidence crossed its requested scope.");
      }

      return sanitizeEvidenceValue({
        capturedAt: new Date().toISOString(),
        knowledgeBase,
        ...Object.fromEntries(
          entries.filter(([name]) => name !== "knowledgeBase")
        )
      });
    },
    async close() {
      if (sql) await sql.end({ timeout: 5 });
    }
  };
}

function createQueryExecutor(sql) {
  return async (name, knowledgeBaseId) => {
    switch (name) {
      case "globalCounts":
        return sql`
          SELECT
            (SELECT count(*) FROM focowiki.knowledge_bases) AS "knowledgeBases",
            (SELECT count(*) FROM focowiki.source_files) AS "sourceFiles",
            (SELECT count(*) FROM focowiki.upload_sessions) AS "uploadSessions",
            (SELECT count(*) FROM focowiki.resource_operations) AS "resourceOperations",
            (SELECT count(*) FROM focowiki.deletion_intents) AS "deletionIntents",
            (SELECT count(*) FROM focowiki.role_jobs) AS "roleJobs",
            (SELECT count(*) FROM focowiki.publication_generations) AS "generations",
            (SELECT count(*) FROM focowiki.active_projection_records) AS "activeProjectionRecords",
            (SELECT count(*) FROM focowiki.immutable_objects) AS "immutableObjects"
        `;
      case "globalRuntimeSettings":
        return sql`
          SELECT key, version, source, updated_at AS "updatedAt"
          FROM focowiki.runtime_settings
          ORDER BY key
          LIMIT 100
        `;
      case "globalWorkers":
        return sql`
          SELECT role, active_job_count AS "activeJobCount",
                 last_seen_at AS "lastSeenAt", updated_at AS "updatedAt"
          FROM focowiki.role_heartbeats
          ORDER BY role, last_seen_at DESC
          LIMIT 100
        `;
      case "globalKnowledgeBases":
        return sql`
          SELECT id, active_generation_id AS "activeGenerationId",
                 resource_revision AS "resourceRevision",
                 catalog_generation AS "catalogGeneration",
                 deleted_at AS "deletedAt"
          FROM focowiki.knowledge_bases
          ORDER BY created_at, id
          LIMIT 10000
        `;
      case "globalImmutableObjects":
        return sql`
          SELECT lifecycle_state AS "lifecycleState",
                 count(*) AS count,
                 coalesce(sum(size_bytes), 0) AS "totalSizeBytes"
          FROM focowiki.immutable_objects
          GROUP BY lifecycle_state
          ORDER BY lifecycle_state
          LIMIT 20
        `;
      case "knowledgeBase":
        return sql`
          SELECT id, name, description,
                 active_generation_id AS "activeGenerationId",
                 resource_revision AS "resourceRevision",
                 catalog_generation AS "catalogGeneration",
                 deleted_at AS "deletedAt"
          FROM focowiki.knowledge_bases
          WHERE id = ${knowledgeBaseId}
          LIMIT 1
        `;
      case "uploadSessions":
        return sql`
          SELECT id, state, declared_file_count AS "declaredFileCount",
                 selected_count AS "selectedCount",
                 upload_required_count AS "uploadRequiredCount",
                 skipped_existing_count AS "skippedExistingCount",
                 waiting_reservation_count AS "waitingReservationCount",
                 rejected_deleting_count AS "rejectedDeletingCount",
                 uploaded_count AS "uploadedCount",
                 failed_count AS "failedCount",
                 finalized_count AS "finalizedCount",
                 error_code AS "errorCode", expires_at AS "expiresAt",
                 completed_at AS "completedAt", updated_at AS "updatedAt"
          FROM focowiki.upload_sessions
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "uploadEntries":
        return sql`
          SELECT entry.id, entry.session_id AS "sessionId",
                 entry.source_file_id AS "sourceFileId",
                 entry.source_directory_id AS "sourceDirectoryId",
                 entry.relative_path AS "relativePath",
                 entry.disposition, entry.transfer_state AS "transferState",
                 entry.existing_resource_revision AS "existingResourceRevision",
                 entry.error_code AS "errorCode",
                 entry.finalized_at AS "finalizedAt"
          FROM focowiki.upload_session_entries entry
          WHERE entry.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY entry.session_id, entry.sequence_number
          LIMIT 50000
        `;
      case "operations":
        return sql`
          SELECT id, operation_kind AS "operationKind", state,
                 expected_resource_revision AS "expectedResourceRevision",
                 candidate_catalog_generation AS "candidateCatalogGeneration",
                 error_code AS "errorCode", completed_at AS "completedAt",
                 updated_at AS "updatedAt"
          FROM focowiki.resource_operations
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "operationTargets":
        return sql`
          SELECT target.operation_id AS "operationId",
                 target.target_kind AS "targetKind",
                 target.target_id AS "targetId",
                 target.expected_resource_revision AS "expectedResourceRevision",
                 target.sequence_number AS "sequenceNumber"
          FROM focowiki.resource_operation_targets target
          JOIN focowiki.resource_operations operation
            ON operation.id = target.operation_id
          WHERE operation.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY target.operation_id, target.sequence_number
          LIMIT 50000
        `;
      case "sourceDirectories":
        return sql`
          SELECT id, parent_id AS "parentId", relative_path AS "relativePath",
                 depth, resource_revision AS "resourceRevision",
                 deletion_intent_id AS "deletionIntentId",
                 candidate_operation_id AS "candidateOperationId",
                 candidate_relative_path AS "candidateRelativePath",
                 deleted_at AS "deletedAt", updated_at AS "updatedAt"
          FROM focowiki.source_directories
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY depth, relative_path, id
          LIMIT 50000
        `;
      case "sourceFiles":
        return sql`
          SELECT id, relative_path AS "relativePath",
                 directory_id AS "directoryId",
                 active_revision_id AS "activeRevisionId",
                 resource_revision AS "resourceRevision",
                 content_revision AS "contentRevision",
                 processing_status AS "processingStatus",
                 processing_stage AS "processingStage",
                 generated_output_status AS "generatedOutputStatus",
                 terminal_failure_stage AS "terminalFailureStage",
                 terminal_failure_code AS "terminalFailureCode",
                 terminal_failure_message AS "terminalFailureMessage",
                 terminal_failure_retry_kind AS "terminalFailureRetryKind",
                 candidate_operation_id AS "candidateOperationId",
                 candidate_revision_id AS "candidateRevisionId",
                 candidate_relative_path AS "candidateRelativePath",
                 deletion_intent_id AS "deletionIntentId",
                 task_deleted_at AS "taskDeletedAt", deleted_at AS "deletedAt"
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY relative_path, id
          LIMIT 50000
        `;
      case "sourceRevisions":
        return sql`
          SELECT id, source_file_id AS "sourceFileId", revision,
                 processing_status AS "processingStatus",
                 checksum_sha256 AS "checksumSha256", created_at AS "createdAt"
          FROM focowiki.source_revisions
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY source_file_id, revision, id
          LIMIT 50000
        `;
      case "dispatchMarkers":
        return sql`
          SELECT id, source_file_id AS "sourceFileId",
                 source_revision_id AS "sourceRevisionId",
                 sequence_number AS "sequenceNumber", status,
                 run_after AS "runAfter", claimed_at AS "claimedAt",
                 dispatched_at AS "dispatchedAt",
                 last_error_code AS "lastErrorCode",
                 updated_at AS "updatedAt"
          FROM focowiki.source_dispatch_markers
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY sequence_number, id
          LIMIT 50000
        `;
      case "sourceEvents":
        return sql`
          SELECT id, source_file_id AS "sourceFileId",
                 stage_key AS "stageKey", message_key AS "messageKey",
                 severity, started_at AS "startedAt", ended_at AS "endedAt",
                 created_at AS "createdAt"
          FROM focowiki.source_file_events
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "deletionIntents":
        return sql`
          SELECT id, target_kind AS "targetKind", target_id AS "targetId",
                 catalog_generation AS "catalogGeneration", state,
                 attempt_count AS "attemptCount",
                 error_code AS "errorCode", completed_at AS "completedAt",
                 updated_at AS "updatedAt"
          FROM focowiki.deletion_intents
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "roleJobs":
        return sql`
          SELECT id, role, kind, source_file_id AS "sourceFileId",
                 source_revision_id AS "sourceRevisionId",
                 generation_id AS "generationId", status,
                 run_after AS "runAfter", attempt_count AS "attemptCount",
                 max_attempts AS "maxAttempts", locked_at AS "lockedAt",
                 heartbeat_at AS "heartbeatAt",
                 completed_at AS "completedAt", failed_at AS "failedAt",
                 last_error_code AS "lastErrorCode",
                 last_error_message AS "lastErrorMessage",
                 updated_at AS "updatedAt"
          FROM focowiki.role_jobs
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "generations":
        return sql`
          SELECT id,
                 predecessor_generation_id AS "predecessorGenerationId",
                 successor_generation_id AS "successorGenerationId",
                 state, format_version AS "formatVersion",
                 safe_error_code AS "safeErrorCode",
                 safe_error_message AS "safeErrorMessage",
                 frozen_at AS "frozenAt", validated_at AS "validatedAt",
                 activated_at AS "activatedAt", failed_at AS "failedAt",
                 updated_at AS "updatedAt"
          FROM focowiki.publication_generations
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "publicationProgress":
        return sql`
          SELECT generation_id AS "generationId", stage,
                 processed_impact_count AS "processedImpactCount",
                 total_impact_count AS "totalImpactCount",
                 touched_shard_count AS "touchedShardCount",
                 heartbeat_at AS "heartbeatAt",
                 completed_at AS "completedAt",
                 safe_error_code AS "safeErrorCode",
                 safe_error_message AS "safeErrorMessage",
                 updated_at AS "updatedAt"
          FROM focowiki.publication_progress
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY updated_at, generation_id
          LIMIT 50000
        `;
      case "publicationImpacts":
        return sql`
          SELECT id, generation_id AS "generationId",
                 projection_kind AS "projectionKind",
                 projection_key AS "projectionKey",
                 record_identity AS "recordIdentity", action, status,
                 attempt_count AS "attemptCount",
                 max_attempts AS "maxAttempts",
                 last_error_code AS "lastErrorCode",
                 last_error_message AS "lastErrorMessage",
                 updated_at AS "updatedAt"
          FROM focowiki.publication_impacts
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY generation_id, id
          LIMIT 50000
        `;
      case "publicationSubtasks":
        return sql`
          SELECT id, generation_id AS "generationId",
                 task_kind AS "taskKind",
                 projection_kind AS "projectionKind",
                 physical_partition AS "physicalPartition", state,
                 processed_count AS "processedCount",
                 total_count AS "totalCount",
                 attempt_count AS "attemptCount",
                 max_attempts AS "maxAttempts",
                 lease_expires_at AS "leaseExpiresAt",
                 last_error_code AS "lastErrorCode",
                 last_error_message AS "lastErrorMessage",
                 updated_at AS "updatedAt"
          FROM focowiki.publication_subtasks
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY generation_id, task_kind, physical_partition, id
          LIMIT 50000
        `;
      case "projectionInputs":
        return sql`
          SELECT generation_id AS "generationId", input_key AS "inputKey",
                 updated_at AS "updatedAt"
          FROM focowiki.publication_projection_inputs
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY generation_id, input_key
          LIMIT 50000
        `;
      case "generationProjections":
        return sql`
          SELECT generation_id AS "generationId",
                 projection_kind AS "projectionKind",
                 record_id AS "recordId", action, source_file_id AS "sourceFileId",
                 related_source_file_id AS "relatedSourceFileId",
                 logical_path AS "logicalPath"
          FROM focowiki.generation_projection_records
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY generation_id, projection_kind, record_id
          LIMIT 50000
        `;
      case "generationObjectRefs":
        return sql`
          SELECT generation_id AS "generationId", ref_kind AS "refKind",
                 ref_key AS "refKey", file_id AS "fileId", action,
                 checksum_sha256 AS "checksumSha256",
                 format_version AS "formatVersion",
                 logical_path AS "logicalPath",
                 source_file_id AS "sourceFileId",
                 projection_shard_id AS "projectionShardId"
          FROM focowiki.generation_object_refs
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY generation_id, ref_kind, ref_key
          LIMIT 50000
        `;
      case "immutableObjects":
        return sql`
          SELECT DISTINCT object.checksum_sha256 AS "checksumSha256",
                 object.format_version AS "formatVersion",
                 object.lifecycle_state AS "lifecycleState",
                 object.size_bytes AS "sizeBytes",
                 object.write_attempt_count AS "writeAttemptCount",
                 object.last_write_error_code AS "lastWriteErrorCode",
                 object.integrity_error_code AS "integrityErrorCode"
          FROM focowiki.generation_object_refs ref
          JOIN focowiki.immutable_objects object
            ON object.checksum_sha256 = ref.checksum_sha256
           AND object.format_version = ref.format_version
          WHERE ref.knowledge_base_id = ${knowledgeBaseId}
            AND ref.action = 'upsert'
          ORDER BY object.checksum_sha256, object.format_version
          LIMIT 50000
        `;
      case "activeProjections":
        return sql`
          SELECT projection_kind AS "projectionKind",
                 record_id AS "recordId",
                 last_changed_generation_id AS "lastChangedGenerationId",
                 source_file_id AS "sourceFileId",
                 related_source_file_id AS "relatedSourceFileId",
                 logical_path AS "logicalPath",
                 parent_path AS "parentPath"
          FROM focowiki.active_projection_records
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY projection_kind, record_id
          LIMIT 50000
        `;
      case "projectionRepairs":
        return sql`
          SELECT repair_version AS "repairVersion",
                 base_generation_id AS "baseGenerationId",
                 target_generation_id AS "targetGenerationId", state,
                 attempt_count AS "attemptCount",
                 next_attempt_at AS "nextAttemptAt",
                 last_error_code AS "lastErrorCode",
                 completed_at AS "completedAt", updated_at AS "updatedAt"
          FROM focowiki.knowledge_base_projection_repairs
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY repair_version
          LIMIT 50000
        `;
      case "projectionRepairSubtasks":
        return sql`
          SELECT repair_version AS "repairVersion",
                 target_generation_id AS "targetGenerationId",
                 task_kind AS "taskKind", partition_key AS "partitionKey",
                 state, expected_record_count AS "expectedRecordCount",
                 processed_record_count AS "processedRecordCount",
                 attempt_count AS "attemptCount",
                 max_attempts AS "maxAttempts",
                 lease_expires_at AS "leaseExpiresAt",
                 last_error_code AS "lastErrorCode",
                 updated_at AS "updatedAt"
          FROM focowiki.projection_repair_subtasks
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY repair_version, phase_order, partition_key
          LIMIT 50000
        `;
      case "lexicalRebuilds":
        return sql`
          SELECT target_generation_id AS "targetGenerationId",
                 base_generation_id AS "baseGenerationId", state, phase,
                 processed_source_count AS "processedSourceCount",
                 total_source_count AS "totalSourceCount",
                 rebase_count AS "rebaseCount",
                 attempt_count AS "attemptCount",
                 max_attempts AS "maxAttempts",
                 last_error_code AS "lastErrorCode",
                 updated_at AS "updatedAt"
          FROM focowiki.knowledge_base_lexical_rebuilds
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, target_generation_id
          LIMIT 50000
        `;
      case "lexicalWorkItems":
        return sql`
          SELECT work.target_generation_id AS "targetGenerationId",
                 work.source_file_id AS "sourceFileId",
                 work.source_revision_id AS "sourceRevisionId",
                 work.logical_path AS "logicalPath", work.state,
                 work.attempt_count AS "attemptCount",
                 work.max_attempts AS "maxAttempts",
                 work.lease_expires_at AS "leaseExpiresAt",
                 work.last_error_stage AS "lastErrorStage",
                 work.last_error_code AS "lastErrorCode",
                 work.updated_at AS "updatedAt"
          FROM focowiki.lexical_rebuild_work_items work
          JOIN focowiki.knowledge_base_lexical_rebuilds rebuild
            ON rebuild.knowledge_base_id = work.knowledge_base_id
           AND rebuild.target_generation_id = work.target_generation_id
          WHERE work.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY work.target_generation_id, work.source_file_id
          LIMIT 50000
        `;
      case "compactionJobs":
        return sql`
          SELECT id, projection_kind AS "projectionKind",
                 logical_partition AS "logicalPartition",
                 active_generation_id AS "activeGenerationId",
                 state, attempt_count AS "attemptCount",
                 max_attempts AS "maxAttempts",
                 lease_expires_at AS "leaseExpiresAt",
                 last_error_code AS "lastErrorCode",
                 updated_at AS "updatedAt"
          FROM focowiki.projection_compaction_jobs
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, id
          LIMIT 50000
        `;
      case "cleanupObjectDeletions":
        return sql`
          SELECT deletion.job_id AS "jobId", deletion.status,
                 deletion.deleted_at AS "deletedAt",
                 deletion.updated_at AS "updatedAt"
          FROM focowiki.cleanup_object_deletions deletion
          WHERE deletion.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY deletion.created_at, deletion.job_id
          LIMIT 50000
        `;
      default:
        throw new Error(`Unknown PostgreSQL evidence query: ${name}.`);
    }
  };
}
