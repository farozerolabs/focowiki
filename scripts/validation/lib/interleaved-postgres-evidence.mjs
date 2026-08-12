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
  "workItems",
  "operationResults",
  "operationDependencies",
  "sourceDirectories",
  "sourceFiles",
  "sourceRevisions",
  "semanticStages",
  "graphNodes",
  "graphEdges",
  "graphEvidenceRefs",
  "releaseRoots",
  "releaseShards",
  "releaseRootShards",
  "releaseCatalogEntries",
  "releaseCatalogTombstones",
  "searchProjections",
  "activeSnapshots",
  "releaseCandidates",
  "releaseCandidateValidations",
  "releaseEventSummaries",
  "objectOwners",
  "objectRegistrations",
  "cleanupActions"
]);

const GLOBAL_QUERY_NAMES = Object.freeze([
  "globalCounts",
  "globalRuntimeSettings",
  "globalWorkers",
  "globalKnowledgeBases",
  "globalObjectRegistrations"
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
        immutableObjects: raw.globalObjectRegistrations ?? []
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
        ...Object.fromEntries(entries.filter(([name]) => name !== "knowledgeBase"))
      });
    },

    async hasLiveWorkItems(knowledgeBaseId) {
      if (!knowledgeBaseId) {
        throw new Error("PostgreSQL evidence requires a knowledge-base identity.");
      }
      const rows = await query("liveWorkItemCount", knowledgeBaseId);
      return Number(rows[0]?.liveCount ?? 0) > 0;
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
            (SELECT count(*) FROM focowiki.operations) AS "operations",
            (SELECT count(*) FROM focowiki.operation_work_items) AS "workItems",
            (SELECT count(*) FROM focowiki.release_roots) AS "releaseRoots",
            (SELECT count(*) FROM focowiki.active_snapshots) AS "activeSnapshots",
            (SELECT count(*) FROM focowiki.search_projections) AS "searchProjections",
            (SELECT count(*) FROM focowiki.object_registrations) AS "objectRegistrations",
            (SELECT count(*) FROM focowiki.object_owners) AS "objectOwners",
            (SELECT count(*) FROM focowiki.cleanup_actions) AS "cleanupActions"
        `;
      case "globalRuntimeSettings":
        return sql`
          SELECT revision.public_id AS id,
                 revision.checksum_sha256 AS "checksumSha256",
                 revision.created_at AS "createdAt"
          FROM focowiki.runtime_setting_current current
          JOIN focowiki.runtime_setting_revisions revision
            ON revision.public_id = current.revision_public_id
          WHERE current.singleton = true
          LIMIT 1
        `;
      case "globalWorkers":
        return sql`
          SELECT work_kind AS role, state, count(*) AS "activeJobCount",
                 min(updated_at) AS "oldestUpdatedAt"
          FROM focowiki.operation_work_items
          GROUP BY work_kind, state
          ORDER BY work_kind, state
          LIMIT 100
        `;
      case "globalKnowledgeBases":
        return sql`
          SELECT knowledge_base.public_id AS id,
                 knowledge_base.revision AS "resourceRevision",
                 snapshot.release_root_public_id AS "activeRootPublicId",
                 snapshot.revision AS "activeRevision",
                 knowledge_base.deleted_at AS "deletedAt"
          FROM focowiki.knowledge_bases knowledge_base
          LEFT JOIN focowiki.active_snapshots snapshot
            ON snapshot.knowledge_base_id = knowledge_base.public_id
          ORDER BY knowledge_base.created_at, knowledge_base.public_id
          LIMIT 10000
        `;
      case "globalObjectRegistrations":
        return sql`
          SELECT state, object_format AS "objectFormat", count(*) AS count,
                 coalesce(sum(byte_count), 0) AS "totalSizeBytes"
          FROM focowiki.object_registrations
          GROUP BY state, object_format
          ORDER BY state, object_format
          LIMIT 100
        `;
      case "knowledgeBase":
        return sql`
          SELECT knowledge_base.public_id AS id, knowledge_base.name,
                 knowledge_base.description,
                 knowledge_base.revision AS "resourceRevision",
                 snapshot.release_root_public_id AS "activeRootPublicId",
                 snapshot.revision AS "activeRevision",
                 knowledge_base.deleted_at AS "deletedAt"
          FROM focowiki.knowledge_bases knowledge_base
          LEFT JOIN focowiki.active_snapshots snapshot
            ON snapshot.knowledge_base_id = knowledge_base.public_id
          WHERE knowledge_base.public_id = ${knowledgeBaseId}
          LIMIT 1
        `;
      case "liveWorkItemCount":
        return sql`
          SELECT count(*) AS "liveCount"
          FROM focowiki.operation_work_items
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND state IN ('queued', 'running', 'retry')
        `;
      case "uploadSessions":
        return sql`
          SELECT public_id AS id, operation_public_id AS "operationId", state,
                 expected_entry_count AS "expectedEntryCount",
                 expected_byte_count AS "expectedByteCount",
                 received_entry_count AS "receivedEntryCount",
                 received_byte_count AS "receivedByteCount",
                 expires_at AS "expiresAt", updated_at AS "updatedAt"
          FROM focowiki.upload_sessions
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, public_id
          LIMIT 50000
        `;
      case "uploadEntries":
        return sql`
          SELECT upload_session_public_id AS "sessionId",
                 entry_public_id AS id,
                 source_file_public_id AS "sourceFileId",
                 logical_path AS "logicalPath", state,
                 object_id AS "objectId", updated_at AS "updatedAt"
          FROM focowiki.upload_entries
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY upload_session_public_id, entry_public_id
          LIMIT 50000
        `;
      case "operations":
        return sql`
          SELECT public_id AS id, operation_kind AS "operationKind", state,
                 expected_resource_revision AS "expectedResourceRevision",
                 target_kind AS "targetKind", target_public_id AS "targetId",
                 candidate_relative_path AS "candidateRelativePath",
                 completed_at AS "completedAt", updated_at AS "updatedAt"
          FROM focowiki.operations
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, public_id
          LIMIT 50000
        `;
      case "workItems":
        return sql`
          SELECT operation_public_id AS "operationId", work_kind AS "workKind",
                 state, operation_revision AS "operationRevision",
                 attempt_count AS "attemptCount", safe_error_code AS "safeErrorCode",
                 checkpoint, lease_expires_at AS "leaseExpiresAt",
                 next_attempt_at AS "nextAttemptAt", updated_at AS "updatedAt"
          FROM focowiki.operation_work_items
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY updated_at, operation_public_id
          LIMIT 50000
        `;
      case "operationResults":
        return sql`
          SELECT public_id AS id, operation_kind AS "operationKind",
                 terminal_state AS state, result_code AS "resultCode",
                 safe_message AS "safeMessage", result_summary AS summary,
                 completed_at AS "completedAt", expires_at AS "expiresAt"
          FROM focowiki.operation_results
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY completed_at, public_id
          LIMIT 50000
        `;
      case "operationDependencies":
        return sql`
          SELECT operation_public_id AS "operationId",
                 dependency_operation_public_id AS "dependencyOperationId"
          FROM focowiki.operation_dependencies
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY operation_public_id, dependency_operation_public_id
          LIMIT 50000
        `;
      case "sourceDirectories":
        return sql`
          SELECT public_id AS id, parent_public_id AS "parentId",
                 logical_path AS "logicalPath", revision AS "resourceRevision",
                 deleted_at AS "deletedAt"
          FROM focowiki.source_directories
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY logical_path, public_id
          LIMIT 50000
        `;
      case "sourceFiles":
        return sql`
          SELECT source.public_id AS id, source.directory_public_id AS "directoryId",
                 source.logical_path AS "logicalPath", source.status,
                 source.revision AS "resourceRevision",
                 current.source_revision_public_id AS "currentRevisionId",
                 source.safe_error_code AS "safeErrorCode",
                 source.safe_error_message AS "safeErrorMessage",
                 source.deleted_at AS "deletedAt", source.updated_at AS "updatedAt"
          FROM focowiki.source_files source
          LEFT JOIN focowiki.source_file_current_revisions current
            ON current.knowledge_base_id = source.knowledge_base_id
           AND current.source_file_public_id = source.public_id
          WHERE source.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY source.logical_path, source.public_id
          LIMIT 50000
        `;
      case "sourceRevisions":
        return sql`
          SELECT public_id AS id, source_file_public_id AS "sourceFileId",
                 object_id AS "objectId", checksum_sha256 AS "checksumSha256",
                 byte_count AS "byteCount", revision_role AS "revisionRole",
                 expires_at AS "expiresAt", created_at AS "createdAt"
          FROM focowiki.source_revisions
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY source_file_public_id, created_at, public_id
          LIMIT 50000
        `;
      case "semanticStages":
        return sql`
          SELECT public_id AS id, source_file_public_id AS "sourceFileId",
                 source_revision_public_id AS "sourceRevisionId",
                 stage_kind AS "stageKind", state,
                 attempt_count AS "attemptCount",
                 maximum_attempts AS "maximumAttempts",
                 safe_error_code AS "safeErrorCode",
                 next_attempt_at AS "nextAttemptAt", updated_at AS "updatedAt"
          FROM focowiki.semantic_stage_work_items
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY updated_at, public_id
          LIMIT 50000
        `;
      case "graphNodes":
        return sql`
          SELECT public_id AS id, source_file_public_id AS "sourceFileId",
                 source_revision_public_id AS "sourceRevisionId",
                 logical_path AS "logicalPath", node_kind AS "nodeKind",
                 revision AS "resourceRevision"
          FROM focowiki.graph_nodes
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY logical_path, public_id
          LIMIT 50000
        `;
      case "graphEdges":
        return sql`
          SELECT public_id AS id, from_node_public_id AS "fromNodeId",
                 to_node_public_id AS "toNodeId", relation, edge_source AS "edgeSource",
                 revision AS "resourceRevision"
          FROM focowiki.graph_edges
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY from_node_public_id, to_node_public_id, public_id
          LIMIT 50000
        `;
      case "graphEvidenceRefs":
        return sql`
          SELECT public_id AS id, node_public_id AS "nodeId",
                 edge_public_id AS "edgeId", source_file_public_id AS "sourceFileId",
                 source_revision_public_id AS "sourceRevisionId",
                 logical_path AS "logicalPath", checksum_sha256 AS "checksumSha256"
          FROM focowiki.graph_evidence_refs
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY public_id
          LIMIT 50000
        `;
      case "releaseRoots":
        return sql`
          SELECT public_id AS id, base_root_public_id AS "baseRootId",
                 root_role AS "rootRole", revision AS "resourceRevision",
                 manifest_checksum_sha256 AS "manifestChecksumSha256",
                 expires_at AS "expiresAt", created_at AS "createdAt"
          FROM focowiki.release_roots
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, public_id
          LIMIT 50000
        `;
      case "releaseShards":
        return sql`
          SELECT public_id AS id, logical_kind AS "logicalKind",
                 first_logical_path AS "firstLogicalPath",
                 last_logical_path AS "lastLogicalPath",
                 record_count AS "recordCount", byte_count AS "byteCount",
                 object_id AS "objectId", checksum_sha256 AS "checksumSha256"
          FROM focowiki.release_shards
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY logical_kind, first_logical_path, public_id
          LIMIT 50000
        `;
      case "releaseRootShards":
        return sql`
          SELECT release_root_public_id AS "releaseRootId",
                 release_shard_public_id AS "releaseShardId", ordinal
          FROM focowiki.release_root_shards
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY release_root_public_id, ordinal, release_shard_public_id
          LIMIT 50000
        `;
      case "releaseCatalogEntries":
        return sql`
          SELECT release_root_public_id AS "releaseRootId",
                 logical_path AS "logicalPath", entry_kind AS "entryKind",
                 source_file_public_id AS "sourceFileId", object_id AS "objectId",
                 checksum_sha256 AS "checksumSha256", byte_count AS "byteCount",
                 ordinal
          FROM focowiki.release_catalog_entries
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY release_root_public_id, logical_path
          LIMIT 50000
        `;
      case "releaseCatalogTombstones":
        return sql`
          SELECT release_root_public_id AS "releaseRootId",
                 logical_path AS "logicalPath"
          FROM focowiki.release_catalog_tombstones
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY release_root_public_id, logical_path
          LIMIT 50000
        `;
      case "searchProjections":
        return sql`
          SELECT public_id AS id, projection_role AS role, state,
                 revision AS "resourceRevision", document_count AS "documentCount",
                 safe_error_code AS "safeErrorCode", updated_at AS "updatedAt"
          FROM focowiki.search_projections
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY role, public_id
          LIMIT 10
        `;
      case "activeSnapshots":
        return sql`
          SELECT release_root_public_id AS "releaseRootId",
                 search_projection_public_id AS "searchProjectionId",
                 revision AS "resourceRevision",
                 activated_by_operation_public_id AS "operationId",
                 publicly_visible_at AS "publiclyVisibleAt"
          FROM focowiki.active_snapshots
          WHERE knowledge_base_id = ${knowledgeBaseId}
          LIMIT 1
        `;
      case "releaseCandidates":
        return sql`
          SELECT public_id AS id, operation_public_id AS "operationId",
                 candidate_root_public_id AS "candidateRootId",
                 expected_active_root_public_id AS "expectedActiveRootId",
                 expected_active_revision AS "expectedActiveRevision", state,
                 reason_code AS "reasonCode", updated_at AS "updatedAt"
          FROM focowiki.release_candidates
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, public_id
          LIMIT 100
        `;
      case "releaseCandidateValidations":
        return sql`
          SELECT validation.candidate_public_id AS "candidateId",
                 validation.search_projection_public_id AS "searchProjectionId",
                 validation.object_owner_count AS "objectOwnerCount",
                 validation.search_document_count AS "searchDocumentCount",
                 validation.graph_node_count AS "graphNodeCount",
                 validation.graph_edge_count AS "graphEdgeCount",
                 validation.generated_entry_count AS "generatedEntryCount",
                 validation.validated_at AS "validatedAt"
          FROM focowiki.release_candidate_validations validation
          WHERE validation.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY validation.validated_at, validation.candidate_public_id
          LIMIT 100
        `;
      case "releaseEventSummaries":
        return sql`
          SELECT public_id AS id, operation_public_id AS "operationId",
                 candidate_public_id AS "candidateId",
                 release_root_public_id AS "releaseRootId", outcome,
                 result_code AS "resultCode", safe_message AS "safeMessage",
                 revision AS "resourceRevision", created_at AS "createdAt"
          FROM focowiki.release_event_summaries
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY created_at, public_id
          LIMIT 50000
        `;
      case "objectOwners":
        return sql`
          SELECT public_id AS id, object_id AS "objectId", owner_kind AS "ownerKind",
                 source_revision_public_id AS "sourceRevisionId",
                 release_root_public_id AS "releaseRootId",
                 release_shard_public_id AS "releaseShardId",
                 operation_public_id AS "operationId"
          FROM focowiki.object_owners
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY object_id, owner_kind, public_id
          LIMIT 50000
        `;
      case "objectRegistrations":
        return sql`
          SELECT DISTINCT registration.object_id AS id,
                 registration.checksum_sha256 AS "checksumSha256",
                 registration.byte_count AS "byteCount",
                 registration.object_format AS "objectFormat", registration.state,
                 registration.zero_owner_since AS "zeroOwnerSince"
          FROM focowiki.object_owners owner
          JOIN focowiki.object_registrations registration
            ON registration.object_id = owner.object_id
          WHERE owner.knowledge_base_id = ${knowledgeBaseId}
          ORDER BY registration.object_id
          LIMIT 50000
        `;
      case "cleanupActions":
        return sql`
          SELECT public_id AS id, operation_public_id AS "operationId",
                 action_kind AS "actionKind", cleanup_plane AS "cleanupPlane",
                 resource_kind AS "resourceKind",
                 resource_public_id AS "resourceId", required, state,
                 attempt_count AS "attemptCount",
                 safe_error_code AS "safeErrorCode", updated_at AS "updatedAt"
          FROM focowiki.cleanup_actions
          WHERE knowledge_base_id = ${knowledgeBaseId}
          ORDER BY sequence_number, public_id
          LIMIT 50000
        `;
      default:
        throw new Error(`Unknown PostgreSQL evidence query: ${name}.`);
    }
  };
}
