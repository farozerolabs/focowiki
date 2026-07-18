import type { DatabaseClient } from "../../db/client.js";
import { createSourceFileLifecycleStatePredicate } from "../../db/source-file-list-predicates.js";
import type {
  ResourceOperationFailureResult,
  SourceResourceRepository
} from "../../application/ports/source-resource-repository.js";
import type {
  ResourceOperationRecord,
  SourceDirectoryRecord,
  SourceResourceFileRecord
} from "../../domain/source-resource.js";
import { SourceResourceError } from "../../domain/source-resource.js";
import type {
  SourceFileFailureStage,
  SourceFileTerminalFailure
} from "../../domain/source-file-lifecycle.js";
import {
  generatedPagePath,
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../../domain/source-path.js";

type DirectoryRow = {
  id: string;
  knowledge_base_id: string;
  parent_id: string | null;
  name: string;
  relative_path: string;
  depth: number;
  resource_revision: number;
  direct_file_count: number;
  descendant_file_count: number;
  deletion_intent_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type SourceFileRow = {
  id: string;
  knowledge_base_id: string;
  directory_id: string | null;
  name: string;
  relative_path: string;
  content_type: string;
  size_bytes: number | string;
  checksum_sha256: string;
  resource_revision: number;
  content_revision: number;
  active_revision_id: string;
  processing_status: SourceResourceFileRecord["processingStatus"];
  processing_stage: SourceFileFailureStage;
  terminal_failure_stage: SourceFileFailureStage | null;
  terminal_failure_code: string | null;
  terminal_failure_message: string | null;
  terminal_failure_at: Date | null;
  terminal_failure_retry_kind: SourceFileTerminalFailure["retryKind"] | null;
  terminal_failure_correlation_id: string | null;
  generated_output_status: SourceResourceFileRecord["generatedOutputStatus"];
  deletion_intent_id: string | null;
  created_at: Date;
};

type OperationRow = {
  id: string;
  knowledge_base_id: string;
  operation_kind: ResourceOperationRecord["kind"];
  state: ResourceOperationRecord["state"];
  expected_resource_revision: number | null;
  candidate_catalog_generation: number | string;
  result_json: unknown;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  request_fingerprint?: string;
  request_json?: unknown;
  target_kind?: "source_file" | "source_directory" | "knowledge_base" | null;
  target_id?: string | null;
  candidate_relative_path?: string | null;
};

const OPERATION_COLUMNS = `
  id, knowledge_base_id, operation_kind, state, expected_resource_revision,
  candidate_catalog_generation, result_json, error_code, created_at, updated_at, completed_at
`;

const QUALIFIED_OPERATION_COLUMNS = `
  operation.id, operation.knowledge_base_id, operation.operation_kind, operation.state,
  operation.expected_resource_revision, operation.candidate_catalog_generation,
  operation.result_json, operation.error_code, operation.created_at,
  operation.updated_at, operation.completed_at
`;

export function createPostgresSourceResourceRepository(
  sql: DatabaseClient
): SourceResourceRepository {
  return {
    async updateKnowledgeBase(input) {
      const rows = await sql<Array<{
        id: string;
        name: string;
        description: string | null;
        active_generation_id: string | null;
        resource_revision: number;
        catalog_generation: number | string;
        created_at: Date;
        updated_at: Date;
      }>>`
        UPDATE focowiki.knowledge_bases
        SET name = COALESCE(${input.name ?? null}, name),
            description = CASE
              WHEN ${input.description === undefined} THEN description
              ELSE ${input.description ?? null}
            END,
            resource_revision = resource_revision + 1,
            catalog_generation = catalog_generation + 1,
            updated_at = now()
        WHERE id = ${input.knowledgeBaseId}
          AND resource_revision = ${input.expectedResourceRevision}
          AND deleted_at IS NULL
        RETURNING id, name, description, active_generation_id, resource_revision,
                  catalog_generation, created_at, updated_at
      `;
      const row = rows[0];
      return row
        ? {
            id: row.id,
            name: row.name,
            description: row.description,
            activeGenerationId: row.active_generation_id,
            resourceRevision: row.resource_revision,
            catalogGeneration: Number(row.catalog_generation),
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString()
          }
        : null;
    },

    async listDirectories(input) {
      const rows = await sql<DirectoryRow[]>`
        WITH RECURSIVE visible_directories AS (
          SELECT directory.id, directory.parent_id
          FROM focowiki.source_directories directory
          WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
            AND directory.deleted_at IS NULL
        ),
        descendants AS (
          SELECT visible.id AS root_id, visible.id
          FROM visible_directories visible
          UNION ALL
          SELECT descendants.root_id, child.id
          FROM descendants
          JOIN visible_directories child ON child.parent_id = descendants.id
        ),
        descendant_counts AS (
          SELECT descendants.root_id, count(source.id)::int AS file_count
          FROM descendants
          LEFT JOIN focowiki.source_files source
            ON source.directory_id = descendants.id
           AND source.deleted_at IS NULL
           AND source.deletion_intent_id IS NULL
          GROUP BY descendants.root_id
        ),
        direct_counts AS (
          SELECT source.directory_id, count(*)::int AS file_count
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
          GROUP BY source.directory_id
        )
        SELECT directory.id, directory.knowledge_base_id, directory.parent_id,
               directory.name, directory.relative_path, directory.depth,
               directory.resource_revision,
               COALESCE(direct.file_count, 0)::int AS direct_file_count,
               COALESCE(total.file_count, 0)::int AS descendant_file_count,
               directory.deletion_intent_id, directory.created_at, directory.updated_at
        FROM focowiki.source_directories directory
        LEFT JOIN direct_counts direct ON direct.directory_id = directory.id
        LEFT JOIN descendant_counts total ON total.root_id = directory.id
        WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
          AND directory.parent_id IS NOT DISTINCT FROM ${input.parentDirectoryId}
          AND directory.deleted_at IS NULL
          AND directory.deletion_intent_id IS NULL
          AND (${input.cursor}::text IS NULL OR directory.id > ${input.cursor})
        ORDER BY directory.id ASC
        LIMIT ${input.limit + 1}
      `;
      return directoryPage(rows, input.limit);
    },

    async getDirectory(input) {
      const rows = await sql<DirectoryRow[]>`
        WITH RECURSIVE descendants AS (
          SELECT directory.id
          FROM focowiki.source_directories directory
          WHERE directory.id = ${input.directoryId}
            AND directory.knowledge_base_id = ${input.knowledgeBaseId}
            AND directory.deleted_at IS NULL
          UNION ALL
          SELECT child.id
          FROM descendants
          JOIN focowiki.source_directories child ON child.parent_id = descendants.id
          WHERE child.deleted_at IS NULL
        )
        SELECT directory.id, directory.knowledge_base_id, directory.parent_id,
               directory.name, directory.relative_path, directory.depth,
               directory.resource_revision,
               (SELECT count(*)::int FROM focowiki.source_files source
                WHERE source.directory_id = directory.id AND source.deleted_at IS NULL
                  AND source.deletion_intent_id IS NULL) AS direct_file_count,
               (SELECT count(*)::int FROM focowiki.source_files source
                WHERE source.directory_id IN (SELECT id FROM descendants)
                  AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL) AS descendant_file_count,
               directory.deletion_intent_id, directory.created_at, directory.updated_at
        FROM focowiki.source_directories directory
        WHERE directory.id = ${input.directoryId}
          AND directory.knowledge_base_id = ${input.knowledgeBaseId}
          AND directory.deleted_at IS NULL
          AND directory.deletion_intent_id IS NULL
        LIMIT 1
      `;
      return rows[0] ? mapDirectory(rows[0]) : null;
    },

    async listSourceFiles(input) {
      const directoryPredicate = input.directoryId === undefined
        ? sql``
        : sql`AND source.directory_id IS NOT DISTINCT FROM ${input.directoryId}`;
      const pathPredicate = input.filters.pathQuery
        ? sql`AND source.relative_path ILIKE ${containsLike(input.filters.pathQuery)} ESCAPE ${"\\"}`
        : sql``;
      const sourceFileIdPredicate = input.filters.sourceFileIdPrefix
        ? sql`AND source.id LIKE ${prefixLike(input.filters.sourceFileIdPrefix)} ESCAPE ${"\\"}`
        : sql``;
      const lifecycleStatePredicate = createSourceFileLifecycleStatePredicate(
        sql,
        input.filters.state
      );
      const currentStagePredicate = input.filters.currentStage
        ? sql`AND COALESCE(source.terminal_failure_stage, source.processing_stage)
            = ${input.filters.currentStage}`
        : sql``;
      const generatedOutputPredicate = input.filters.generatedOutputStatus
        ? sql`AND source.generated_output_status = ${input.filters.generatedOutputStatus}`
        : sql``;
      const rows = await sql<SourceFileRow[]>`
        SELECT source.id, source.knowledge_base_id, source.directory_id, source.name,
               source.relative_path, source.content_type, source.size_bytes,
               source.checksum_sha256, source.resource_revision, source.content_revision,
               source.active_revision_id, source.processing_status, source.processing_stage,
               source.terminal_failure_stage, source.terminal_failure_code,
               source.terminal_failure_message, source.terminal_failure_at,
               source.terminal_failure_retry_kind, source.terminal_failure_correlation_id,
               source.generated_output_status,
               source.deletion_intent_id, source.created_at
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
          ${directoryPredicate}
          ${pathPredicate}
          ${sourceFileIdPredicate}
          ${lifecycleStatePredicate}
          ${currentStagePredicate}
          ${generatedOutputPredicate}
          AND (${input.cursor}::text IS NULL OR source.id > ${input.cursor})
        ORDER BY source.id ASC
        LIMIT ${input.limit + 1}
      `;
      return sourceFilePage(rows, input.limit);
    },

    async getSourceFile(input) {
      const rows = await sql<SourceFileRow[]>`
        SELECT source.id, source.knowledge_base_id, source.directory_id, source.name,
               source.relative_path, source.content_type, source.size_bytes,
               source.checksum_sha256, source.resource_revision, source.content_revision,
               source.active_revision_id, source.processing_status, source.processing_stage,
               source.terminal_failure_stage, source.terminal_failure_code,
               source.terminal_failure_message, source.terminal_failure_at,
               source.terminal_failure_retry_kind, source.terminal_failure_correlation_id,
               source.generated_output_status,
               source.deletion_intent_id, source.created_at
        FROM focowiki.source_files source
        WHERE source.id = ${input.sourceFileId}
          AND source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
        LIMIT 1
      `;
      return rows[0] ? mapSourceFile(rows[0]) : null;
    },

    async getSourceFileContentDescriptor(input) {
      const rows = await sql<Array<{
        object_key: string;
        content_type: string;
        size_bytes: number | string;
        checksum_sha256: string;
        resource_revision: number;
        revision: number;
      }>>`
        SELECT revision.object_key, revision.content_type, revision.size_bytes,
               revision.checksum_sha256, source.resource_revision,
               revision.revision
        FROM focowiki.source_files source
        JOIN focowiki.source_revisions revision
          ON revision.id = source.active_revision_id
         AND revision.source_file_id = source.id
        WHERE source.id = ${input.sourceFileId}
          AND source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      return row
        ? {
            objectKey: row.object_key,
            contentType: row.content_type,
            sizeBytes: Number(row.size_bytes),
            checksumSha256: row.checksum_sha256,
            resourceRevision: row.resource_revision,
            contentRevision: row.revision
          }
        : null;
    },

    async createOperation(input) {
      return sql.begin(async (transaction) => {
        const existing = await transaction<(OperationRow & { request_fingerprint: string })[]>`
          SELECT ${transaction.unsafe(OPERATION_COLUMNS)}, request_fingerprint
          FROM focowiki.resource_operations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND idempotency_key = ${input.idempotencyKey}
          LIMIT 1
        `;
        if (existing[0]) {
          if (existing[0].request_fingerprint !== input.requestFingerprint) {
            throw new SourceResourceError("IDEMPOTENCY_CONFLICT");
          }
          return { operation: mapOperation(existing[0]), replayed: true };
        }

        await assertMutableTarget(transaction, input);
        const knowledgeBases = await transaction<Array<{ catalog_generation: string | number }>>`
          UPDATE focowiki.knowledge_bases
          SET catalog_generation = catalog_generation + 1, updated_at = now()
          WHERE id = ${input.knowledgeBaseId}
            AND deleted_at IS NULL
          RETURNING catalog_generation
        `;
        const candidateCatalogGeneration = Number(knowledgeBases[0]?.catalog_generation);
        if (!Number.isSafeInteger(candidateCatalogGeneration)) {
          throw new SourceResourceError("RESOURCE_NOT_FOUND");
        }
        const rows = await transaction<OperationRow[]>`
          INSERT INTO focowiki.resource_operations (
            id, knowledge_base_id, operation_kind, state, idempotency_key,
            request_fingerprint, request_json, expected_resource_revision, candidate_catalog_generation
          ) VALUES (
            ${input.operationId}, ${input.knowledgeBaseId}, ${input.kind}, 'accepted',
            ${input.idempotencyKey}, ${input.requestFingerprint},
            ${transaction.json(input.request as never)},
            ${input.expectedResourceRevision}, ${candidateCatalogGeneration}
          )
          RETURNING ${transaction.unsafe(OPERATION_COLUMNS)}
        `;
        await transaction`
          INSERT INTO focowiki.resource_operation_targets (
            operation_id, target_kind, target_id, expected_resource_revision
          ) VALUES (
            ${input.operationId}, ${input.targetKind}, ${input.targetId},
            ${input.expectedResourceRevision}
          )
        `;
        return { operation: mapOperation(requireRow(rows[0])), replayed: false };
      });
    },

    async prepareOperation(input) {
      try {
        return await sql.begin(async (transaction) => {
          const rows = await transaction<(OperationRow & { request_json: unknown })[]>`
            SELECT ${transaction.unsafe(OPERATION_COLUMNS)}, request_json
            FROM focowiki.resource_operations
            WHERE id = ${input.operationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
            LIMIT 1
            FOR UPDATE
          `;
          const row = requireRow(rows[0]);
          if (
            row.state !== "accepted" &&
            !(row.operation_kind === "source_directory_delete" && row.state === "processing")
          ) {
            return operationPreparationResult(row, null);
          }
          const request = requireRecord(row.request_json);
          const targets = await transaction<Array<{
            target_kind: "source_file" | "source_directory" | "knowledge_base";
            target_id: string;
          }>>`
            SELECT target_kind, target_id
            FROM focowiki.resource_operation_targets
            WHERE operation_id = ${input.operationId}
            ORDER BY sequence_number ASC, target_kind ASC, target_id ASC
            LIMIT 1
          `;
          const target = requireRow(targets[0]);

          if (row.operation_kind === "source_directory_delete") {
            if (target.target_kind !== "source_directory") {
              throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
            }
            return prepareSourceDirectoryDeletionBatch(transaction, {
              operation: row,
              directoryId: target.target_id,
              now: input.now,
              batchSize: input.batchSize
            });
          }

          if (row.operation_kind === "source_file_replace" || row.operation_kind === "source_file_move") {
            if (target.target_kind !== "source_file") {
              throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
            }
            const prepared = await prepareSourceFileOperation(transaction, {
              operation: row,
              sourceFileId: target.target_id,
              request,
              now: input.now
            });
            return operationPreparationResult(prepared.operation, target.target_id);
          }

          if (row.operation_kind === "source_directory_move") {
            if (target.target_kind !== "source_directory") {
              throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
            }
            const prepared = await prepareSourceDirectoryMove(transaction, {
              operation: row,
              directoryId: target.target_id,
              request,
              now: input.now
            });
            return operationPreparationResult(prepared, null);
          }

          throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SourceResourceError("RESOURCE_PATH_CONFLICT");
        }
        throw error;
      }
    },

    async listPendingOperationSourceMutations(input) {
      const limit = Math.min(Math.max(Math.floor(input.limit), 1), 1_000);
      const rows = input.deletionIntentId
        ? await sql<Array<{
            source_file_id: string;
            source_revision_id: string;
            previous_path: string;
            path: string | null;
            resource_revision: number;
          }>>`
            SELECT source.id AS source_file_id,
                   source.active_revision_id AS source_revision_id,
                   source.relative_path AS previous_path,
                   NULL::text AS path,
                   source.resource_revision
            FROM focowiki.source_files source
            WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.deletion_intent_id = ${input.deletionIntentId}
              AND source.active_revision_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.publication_change_facts fact
                WHERE fact.knowledge_base_id = source.knowledge_base_id
                  AND fact.source_file_id = source.id
                  AND fact.deletion_intent_id = ${input.deletionIntentId}
                  AND fact.kind = 'source_deleted'
              )
            ORDER BY source.path_key COLLATE "C", source.id
            LIMIT ${limit + 1}
          `
        : await sql<Array<{
            source_file_id: string;
            source_revision_id: string;
            previous_path: string;
            path: string | null;
            resource_revision: number;
          }>>`
            SELECT source.id AS source_file_id,
                   source.active_revision_id AS source_revision_id,
                   source.relative_path AS previous_path,
                   source.candidate_relative_path AS path,
                   source.resource_revision + 1 AS resource_revision
            FROM focowiki.source_files source
            WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.candidate_operation_id = ${input.operationId}
              AND source.active_revision_id IS NOT NULL
              AND source.deleted_at IS NULL
              AND source.candidate_relative_path IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.publication_change_facts fact
                WHERE fact.knowledge_base_id = source.knowledge_base_id
                  AND fact.source_file_id = source.id
                  AND fact.operation_id = ${input.operationId}
                  AND fact.kind = 'source_moved'
              )
            ORDER BY source.path_key COLLATE "C", source.id
            LIMIT ${limit + 1}
          `;
      return {
        items: rows.slice(0, limit).map((row) => ({
          sourceFileId: row.source_file_id,
          sourceRevisionId: row.source_revision_id,
          kind: input.deletionIntentId ? "source_deleted" as const : "source_moved" as const,
          previousPath: row.previous_path,
          path: row.path,
          resourceRevision: row.resource_revision
        })),
        hasMore: rows.length > limit
      };
    },

    async failOperation(input) {
      return sql.begin((transaction) => failCandidateOperation(transaction, input));
    },

    async failSourceFileCandidateOperation(input) {
      return sql.begin(async (transaction) => {
        const operations = await transaction<Array<{ operation_id: string }>>`
          SELECT candidate_operation_id AS operation_id
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id = ${input.sourceFileId}
            AND candidate_operation_id IS NOT NULL
          LIMIT 1
          FOR UPDATE
        `;
        const operationId = operations[0]?.operation_id;
        if (!operationId) return { operation: null, objectKeys: [] };
        return failCandidateOperation(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          operationId,
          errorCode: input.errorCode,
          failedAt: input.failedAt
        });
      });
    },

    async getOperation(input) {
      const rows = await sql<OperationRow[]>`
        SELECT ${sql.unsafe(QUALIFIED_OPERATION_COLUMNS)},
               target.target_kind, target.target_id,
               target.candidate_json->>'relativePath' AS candidate_relative_path
        FROM focowiki.resource_operations operation
        LEFT JOIN LATERAL (
          SELECT candidate.target_kind, candidate.target_id, candidate.candidate_json
          FROM focowiki.resource_operation_targets candidate
          WHERE candidate.operation_id = operation.id
          ORDER BY candidate.sequence_number ASC, candidate.target_kind ASC, candidate.target_id ASC
          LIMIT 1
        ) target ON TRUE
        WHERE operation.id = ${input.operationId}
          AND operation.knowledge_base_id = ${input.knowledgeBaseId}
        LIMIT 1
      `;
      return rows[0] ? mapOperation(rows[0]) : null;
    },

    async listOperations(input) {
      const statePredicate = input.states?.length
        ? sql`AND operation.state = ANY(${input.states})`
        : sql``;
      const rows = await sql<OperationRow[]>`
        SELECT ${sql.unsafe(QUALIFIED_OPERATION_COLUMNS)},
               target.target_kind, target.target_id,
               target.candidate_json->>'relativePath' AS candidate_relative_path
        FROM focowiki.resource_operations operation
        LEFT JOIN LATERAL (
          SELECT candidate.target_kind, candidate.target_id, candidate.candidate_json
          FROM focowiki.resource_operation_targets candidate
          WHERE candidate.operation_id = operation.id
          ORDER BY candidate.sequence_number ASC, candidate.target_kind ASC, candidate.target_id ASC
          LIMIT 1
        ) target ON TRUE
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          ${statePredicate}
          AND (${input.cursor}::text IS NULL OR operation.id > ${input.cursor})
        ORDER BY operation.id ASC
        LIMIT ${input.limit + 1}
      `;
      const items = rows.slice(0, input.limit).map(mapOperation);
      return {
        items,
        nextCursor: rows.length > input.limit ? items.at(-1)?.id ?? null : null
      };
    },

    async acceptDirectoryDeletion(input) {
      return sql.begin(async (transaction) => {
        const replay = await findOperationReplay(transaction, input);
        if (replay) {
          const result = requireRecord(replay.result_json);
          return {
            operation: mapOperation(replay),
            replayed: true,
            deletionIntentId: readString(result.deletionIntentId) ?? "",
            effectiveDirectoryId: readString(result.effectiveDirectoryId) ?? input.directoryId,
            affectedDirectoryCount: readNumber(result.affectedDirectoryCount),
            affectedFileCount: readNumber(result.affectedFileCount)
          };
        }

        const targets = await transaction<Array<{
          id: string;
          relative_path: string;
          path_key: string;
          resource_revision: number;
          deletion_intent_id: string | null;
        }>>`
          SELECT id, relative_path, path_key, resource_revision, deletion_intent_id
          FROM focowiki.source_directories
          WHERE id = ${input.directoryId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          LIMIT 1
          FOR UPDATE
        `;
        const target = targets[0];
        if (!target) throw new SourceResourceError("RESOURCE_NOT_FOUND");

        const effective = await findEffectiveDirectoryDeletion(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          targetPathKey: target.path_key
        });
        if (effective) {
          const effectiveResult = requireRecord(effective.operation.result_json);
          return {
            operation: mapOperation(effective.operation),
            replayed: true,
            deletionIntentId: effective.deletionIntentId,
            effectiveDirectoryId: effective.directoryId,
            affectedDirectoryCount: readNumber(effectiveResult.affectedDirectoryCount),
            affectedFileCount: readNumber(effectiveResult.affectedFileCount)
          };
        }
        if (target.resource_revision !== input.expectedResourceRevision) {
          throw new SourceResourceError("RESOURCE_REVISION_CONFLICT");
        }
        const generation = await incrementCatalogGeneration(transaction, input.knowledgeBaseId);

        const affected = await transaction<Array<{
          directory_count: number;
          file_count: number;
        }>>`
          WITH RECURSIVE descendants AS (
            SELECT id FROM focowiki.source_directories
            WHERE id = ${input.directoryId} AND knowledge_base_id = ${input.knowledgeBaseId}
            UNION ALL
            SELECT child.id
            FROM descendants parent
            JOIN focowiki.source_directories child ON child.parent_id = parent.id
            WHERE child.knowledge_base_id = ${input.knowledgeBaseId}
              AND child.deleted_at IS NULL
          )
          SELECT count(DISTINCT descendants.id)::int AS directory_count,
                 count(source.id)::int AS file_count
          FROM descendants
          LEFT JOIN focowiki.source_files source
            ON source.directory_id = descendants.id
           AND source.knowledge_base_id = ${input.knowledgeBaseId}
           AND source.deleted_at IS NULL
           AND source.task_deleted_at IS NULL
        `;
        const counts = affected[0] ?? { directory_count: 0, file_count: 0 };
        const result = {
          deletionIntentId: input.deletionIntentId,
          effectiveDirectoryId: input.directoryId,
          activeRelativePath: target.relative_path,
          candidateRelativePath: null,
          candidateResourceRevision: target.resource_revision + 1,
          affectedDirectoryCount: counts.directory_count,
          affectedFileCount: counts.file_count
        };

        await insertDeletionIntentAndOperation(transaction, {
          operationId: input.operationId,
          deletionIntentId: input.deletionIntentId,
          knowledgeBaseId: input.knowledgeBaseId,
          kind: "source_directory_delete",
          targetKind: "source_directory",
          targetId: input.directoryId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          expectedResourceRevision: input.expectedResourceRevision,
          generation,
          result
        });

        await supersedeDescendantDeletionIntents(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          targetPathKey: target.path_key,
          excludeIntentId: input.deletionIntentId,
          completedAt: input.deletedAt
        });
        await transaction`
          UPDATE focowiki.source_directories directory
          SET deletion_intent_id = ${input.deletionIntentId},
              deleted_at = ${input.deletedAt},
              updated_at = now()
          WHERE directory.id = ${input.directoryId}
        `;
        const operation = await readOperationById(transaction, input.operationId);
        return {
          operation: mapOperation(operation),
          replayed: false,
          deletionIntentId: input.deletionIntentId,
          effectiveDirectoryId: input.directoryId,
          affectedDirectoryCount: counts.directory_count,
          affectedFileCount: counts.file_count
        };
      });
    },

    async acceptSourceFileDeletion(input) {
      return sql.begin(async (transaction) => {
        const replay = await findOperationReplay(transaction, input);
        if (replay) {
          const result = requireRecord(replay.result_json);
          return {
            operation: mapOperation(replay),
            replayed: true,
            deletionIntentId: readString(result.deletionIntentId) ?? "",
            sourceFileId: readString(result.sourceFileId) ?? input.sourceFileId,
            sourceMutation: readPendingSourceMutation(result)
          };
        }
        const sources = await transaction<Array<{
          id: string;
          path_key: string;
          resource_revision: number;
          deletion_intent_id: string | null;
          candidate_operation_id: string | null;
          relative_path: string;
          active_revision_id: string | null;
          deleted_at: Date | null;
        }>>`
          SELECT source.id, source.path_key, source.resource_revision,
                 source.deletion_intent_id, source.candidate_operation_id,
                 source.relative_path, source.active_revision_id, source.deleted_at
          FROM focowiki.source_files source
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = source.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE source.id = ${input.sourceFileId}
            AND source.knowledge_base_id = ${input.knowledgeBaseId}
          LIMIT 1 FOR UPDATE
        `;
        const source = sources[0];
        if (!source) throw new SourceResourceError("RESOURCE_NOT_FOUND");
        const effectiveDeletion = await findEffectiveSourceFileDeletion(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: source.id,
          sourcePathKey: source.path_key,
          deletionIntentId: source.deletion_intent_id
        });
        if (effectiveDeletion) {
          return {
            operation: mapOperation(effectiveDeletion.operation),
            replayed: true,
            deletionIntentId: effectiveDeletion.deletionIntentId,
            sourceFileId: source.id,
            sourceMutation: readPendingSourceMutation(
              requireRecord(effectiveDeletion.operation.result_json)
            )
          };
        }
        if (source.deleted_at) throw new SourceResourceError("RESOURCE_NOT_FOUND");
        if (source.resource_revision !== input.expectedResourceRevision) {
          throw new SourceResourceError("RESOURCE_REVISION_CONFLICT");
        }
        if (source.candidate_operation_id) {
          await supersedeCandidateOperation(transaction, source.candidate_operation_id, input.deletedAt);
        }
        const generation = await incrementCatalogGeneration(transaction, input.knowledgeBaseId);
        const result = {
          deletionIntentId: input.deletionIntentId,
          sourceFileId: source.id,
          affectedFileCount: 1,
          sourceMutation: source.active_revision_id
            ? {
                sourceFileId: source.id,
                sourceRevisionId: source.active_revision_id,
                kind: "source_deleted" as const,
                previousPath: source.relative_path,
                path: null,
                resourceRevision: source.resource_revision
              }
            : null
        };
        await insertDeletionIntentAndOperation(transaction, {
          operationId: input.operationId,
          deletionIntentId: input.deletionIntentId,
          knowledgeBaseId: input.knowledgeBaseId,
          kind: "source_file_delete",
          targetKind: "source_file",
          targetId: source.id,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          expectedResourceRevision: input.expectedResourceRevision,
          generation,
          result
        });
        await transaction`
          UPDATE focowiki.source_files
          SET deletion_intent_id = ${input.deletionIntentId}, deleted_at = ${input.deletedAt}
          WHERE id = ${source.id} AND deleted_at IS NULL
        `;
        await transaction`
          DELETE FROM focowiki.source_path_reservations reservation
          USING focowiki.upload_session_entries entry
          WHERE reservation.entry_id = entry.id
            AND entry.knowledge_base_id = ${input.knowledgeBaseId}
            AND entry.path_key = ${source.path_key}
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries
          SET disposition = 'rejected_deleting', transfer_state = 'skipped',
              error_code = 'SOURCE_FILE_DELETING', updated_at = now()
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND path_key = ${source.path_key}
            AND disposition IN ('pending', 'upload_required', 'waiting_reservation')
        `;
        const operation = await readOperationById(transaction, input.operationId);
        return {
          operation: mapOperation(operation),
          replayed: false,
          deletionIntentId: input.deletionIntentId,
          sourceFileId: source.id,
          sourceMutation: result.sourceMutation
        };
      });
    },

    async acceptKnowledgeBaseDeletion(input) {
      return sql.begin(async (transaction) => {
        const replay = await findOperationReplay(transaction, input);
        if (replay) {
          const result = requireRecord(replay.result_json);
          return {
            operation: mapOperation(replay),
            replayed: true,
            deletionIntentId: readString(result.deletionIntentId) ?? "",
            affectedDirectoryCount: readNumber(result.affectedDirectoryCount),
            affectedFileCount: readNumber(result.affectedFileCount)
          };
        }
        const knowledgeBases = await transaction<Array<{
          id: string;
          resource_revision: number;
          catalog_generation: number | string;
          deleted_at: Date | null;
        }>>`
          SELECT id, resource_revision, catalog_generation, deleted_at
          FROM focowiki.knowledge_bases
          WHERE id = ${input.knowledgeBaseId}
          LIMIT 1 FOR UPDATE
        `;
        const knowledgeBase = knowledgeBases[0];
        if (!knowledgeBase || knowledgeBase.deleted_at) {
          throw new SourceResourceError("RESOURCE_NOT_FOUND");
        }
        if (knowledgeBase.resource_revision !== input.expectedResourceRevision) {
          throw new SourceResourceError("RESOURCE_REVISION_CONFLICT");
        }
        const counts = await transaction<Array<{ file_count: number }>>`
          SELECT count(*)::int AS file_count
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
        const generation = Number(knowledgeBase.catalog_generation) + 1;
        const result = {
          deletionIntentId: input.deletionIntentId,
          affectedDirectoryCount: 0,
          affectedFileCount: counts[0]?.file_count ?? 0
        };
        await insertDeletionIntentAndOperation(transaction, {
          operationId: input.operationId,
          deletionIntentId: input.deletionIntentId,
          knowledgeBaseId: input.knowledgeBaseId,
          kind: "knowledge_base_delete",
          targetKind: "knowledge_base",
          targetId: input.knowledgeBaseId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          expectedResourceRevision: input.expectedResourceRevision,
          generation,
          result
        });
        await transaction`
          UPDATE focowiki.resource_operations
          SET state = 'superseded', completed_at = ${input.deletedAt}, updated_at = ${input.deletedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id <> ${input.operationId}
            AND state IN ('accepted', 'validating', 'processing', 'publishing')
        `;
        await transaction`
          UPDATE focowiki.deletion_intents
          SET state = 'superseded', completed_at = ${input.deletedAt}, updated_at = ${input.deletedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id <> ${input.deletionIntentId}
            AND state IN ('accepted', 'running')
        `;
        await transaction`
          DELETE FROM focowiki.resource_path_reservations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.knowledge_bases
          SET catalog_generation = ${generation}, resource_revision = resource_revision + 1,
              deleted_at = ${input.deletedAt}, updated_at = ${input.deletedAt}
          WHERE id = ${input.knowledgeBaseId} AND deleted_at IS NULL
        `;
        const operation = await readOperationById(transaction, input.operationId);
        return {
          operation: mapOperation(operation), replayed: false,
          deletionIntentId: input.deletionIntentId,
          affectedDirectoryCount: result.affectedDirectoryCount,
          affectedFileCount: result.affectedFileCount
        };
      });
    }
  };
}

async function assertMutableTarget(
  transaction: import("postgres").TransactionSql,
  input: Parameters<SourceResourceRepository["createOperation"]>[0]
): Promise<void> {
  if (input.targetKind === "knowledge_base") {
    const rows = await transaction<Array<{ resource_revision: number; deleted_at: Date | null }>>`
      SELECT resource_revision, deleted_at FROM focowiki.knowledge_bases
      WHERE id = ${input.targetId} AND id = ${input.knowledgeBaseId} LIMIT 1 FOR UPDATE
    `;
    assertRevision(rows[0], input.expectedResourceRevision);
    return;
  }
  const table = input.targetKind === "source_file" ? "source_files" : "source_directories";
  const rows = await transaction<Array<{
    resource_revision: number;
    deleted_at: Date | null;
    deletion_intent_id: string | null;
  }>>`
    SELECT resource_revision, deleted_at, deletion_intent_id
    FROM ${transaction.unsafe(`focowiki.${table}`)}
    WHERE id = ${input.targetId} AND knowledge_base_id = ${input.knowledgeBaseId}
    LIMIT 1 FOR UPDATE
  `;
  assertRevision(rows[0], input.expectedResourceRevision);
  if (rows[0]?.deletion_intent_id) {
    throw new SourceResourceError("RESOURCE_DELETING");
  }
}

async function findOperationReplay(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; idempotencyKey: string; requestFingerprint: string }
): Promise<(OperationRow & { request_fingerprint: string }) | null> {
  const rows = await transaction<(OperationRow & { request_fingerprint: string })[]>`
    SELECT ${transaction.unsafe(OPERATION_COLUMNS)}, request_fingerprint
    FROM focowiki.resource_operations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.request_fingerprint !== input.requestFingerprint) {
    throw new SourceResourceError("IDEMPOTENCY_CONFLICT");
  }
  return row;
}

async function incrementCatalogGeneration(
  transaction: import("postgres").TransactionSql,
  knowledgeBaseId: string
): Promise<number> {
  const rows = await transaction<Array<{ catalog_generation: number | string }>>`
    UPDATE focowiki.knowledge_bases
    SET catalog_generation = catalog_generation + 1, updated_at = now()
    WHERE id = ${knowledgeBaseId} AND deleted_at IS NULL
    RETURNING catalog_generation
  `;
  const generation = Number(rows[0]?.catalog_generation);
  if (!Number.isSafeInteger(generation)) throw new SourceResourceError("RESOURCE_NOT_FOUND");
  return generation;
}

async function insertDeletionIntentAndOperation(
  transaction: import("postgres").TransactionSql,
  input: {
    operationId: string;
    deletionIntentId: string;
    knowledgeBaseId: string;
    kind: "source_file_delete" | "source_directory_delete" | "knowledge_base_delete";
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    targetId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedResourceRevision: number;
    generation: number;
    result: Record<string, unknown>;
  }
): Promise<void> {
  await transaction`
    INSERT INTO focowiki.deletion_intents (
      id, knowledge_base_id, target_kind, target_id, catalog_generation, state
    ) VALUES (
      ${input.deletionIntentId}, ${input.knowledgeBaseId}, ${input.targetKind},
      ${input.targetId}, ${input.generation}, 'accepted'
    )
  `;
  await transaction`
    INSERT INTO focowiki.resource_operations (
      id, knowledge_base_id, operation_kind, state, idempotency_key,
      request_fingerprint, request_json, expected_resource_revision,
      candidate_catalog_generation, result_json
    ) VALUES (
      ${input.operationId}, ${input.knowledgeBaseId}, ${input.kind}, 'accepted',
      ${input.idempotencyKey}, ${input.requestFingerprint}, '{}'::jsonb,
      ${input.expectedResourceRevision}, ${input.generation},
      ${transaction.json(input.result as never)}
    )
  `;
  await transaction`
    INSERT INTO focowiki.resource_operation_targets (
      operation_id, target_kind, target_id, expected_resource_revision
    ) VALUES (
      ${input.operationId}, ${input.targetKind}, ${input.targetId},
      ${input.expectedResourceRevision}
    )
  `;
}

async function readOperationById(
  transaction: import("postgres").TransactionSql,
  operationId: string
): Promise<OperationRow> {
  const rows = await transaction<OperationRow[]>`
    SELECT ${transaction.unsafe(OPERATION_COLUMNS)}
    FROM focowiki.resource_operations WHERE id = ${operationId}
  `;
  return requireRow(rows[0]);
}

async function failCandidateOperation(
  transaction: import("postgres").TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationId: string;
    errorCode: string;
    failedAt: string;
  }
): Promise<ResourceOperationFailureResult> {
  const operations = await transaction<OperationRow[]>`
    UPDATE focowiki.resource_operations
    SET state = 'failed', error_code = ${input.errorCode},
        updated_at = ${input.failedAt}, completed_at = ${input.failedAt}
    WHERE id = ${input.operationId}
      AND knowledge_base_id = ${input.knowledgeBaseId}
      AND state NOT IN ('completed', 'cancelled', 'superseded')
    RETURNING ${transaction.unsafe(OPERATION_COLUMNS)}
  `;
  const operation = operations[0];
  if (!operation) return { operation: null, objectKeys: [] };

  const candidates = await transaction<Array<{
    revision_id: string | null;
    object_key: string | null;
  }>>`
    SELECT candidate_revision_id AS revision_id, candidate_object_key AS object_key
    FROM focowiki.source_files
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_operation_id = ${input.operationId}
    FOR UPDATE
  `;

  await transaction`
    UPDATE focowiki.source_files
    SET candidate_operation_id = NULL, candidate_revision_id = NULL,
        candidate_name = NULL, candidate_relative_path = NULL, candidate_path_key = NULL,
        candidate_directory_id = NULL, candidate_object_key = NULL,
        candidate_content_type = NULL, candidate_size_bytes = NULL,
        candidate_checksum_sha256 = NULL, candidate_metadata_json = NULL,
        candidate_model_suggestions_json = NULL
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_operation_id = ${input.operationId}
  `;
  await transaction`
    UPDATE focowiki.source_directories
    SET candidate_operation_id = NULL, candidate_parent_id = NULL,
        candidate_name = NULL, candidate_relative_path = NULL,
        candidate_path_key = NULL, candidate_depth = NULL, updated_at = ${input.failedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_operation_id = ${input.operationId}
  `;
  const revisionIds = candidates.flatMap((candidate) =>
    candidate.revision_id ? [candidate.revision_id] : []
  );
  if (revisionIds.length > 0) {
    await transaction`
      DELETE FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND id = ANY(${revisionIds})
    `;
  }
  await transaction`
    DELETE FROM focowiki.resource_path_reservations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND operation_id = ${input.operationId}
  `;

  return {
    operation: mapOperation(operation),
    objectKeys: Array.from(new Set(candidates.flatMap((candidate) =>
      candidate.object_key ? [candidate.object_key] : []
    )))
  };
}

async function supersedeCandidateOperation(
  transaction: import("postgres").TransactionSql,
  operationId: string,
  completedAt: string
): Promise<void> {
  await transaction`
    UPDATE focowiki.resource_operations
    SET state = 'superseded', completed_at = ${completedAt}, updated_at = ${completedAt}
    WHERE id = ${operationId}
      AND state IN ('accepted', 'validating', 'processing', 'publishing')
  `;
  await transaction`
    UPDATE focowiki.source_files
    SET candidate_operation_id = NULL, candidate_revision_id = NULL,
        candidate_name = NULL, candidate_relative_path = NULL, candidate_path_key = NULL,
        candidate_directory_id = NULL, candidate_object_key = NULL,
        candidate_content_type = NULL, candidate_size_bytes = NULL,
        candidate_checksum_sha256 = NULL, candidate_metadata_json = NULL,
        candidate_model_suggestions_json = NULL
    WHERE candidate_operation_id = ${operationId}
  `;
  await transaction`
    UPDATE focowiki.source_directories
    SET candidate_operation_id = NULL, candidate_parent_id = NULL,
        candidate_name = NULL, candidate_relative_path = NULL,
        candidate_path_key = NULL, candidate_depth = NULL, updated_at = now()
    WHERE candidate_operation_id = ${operationId}
  `;
  await transaction`
    DELETE FROM focowiki.resource_path_reservations WHERE operation_id = ${operationId}
  `;
}

async function prepareSourceFileOperation(
  transaction: import("postgres").TransactionSql,
  input: {
    operation: OperationRow;
    sourceFileId: string;
    request: Record<string, unknown>;
    now: string;
  }
): Promise<{ operation: OperationRow }> {
  const sources = await transaction<Array<{
    id: string;
    knowledge_base_id: string;
    name: string;
    relative_path: string;
    path_key: string;
    directory_id: string | null;
    resource_revision: number;
    content_revision: number;
    object_key: string;
    content_type: string;
    size_bytes: number | string;
    checksum_sha256: string;
    active_revision_id: string;
    candidate_operation_id: string | null;
    deletion_intent_id: string | null;
    processing_status: SourceResourceFileRecord["processingStatus"];
  }>>`
    SELECT id, knowledge_base_id, name, relative_path, path_key, directory_id,
           resource_revision, content_revision, object_key, content_type, size_bytes,
           checksum_sha256, active_revision_id, candidate_operation_id, deletion_intent_id,
           processing_status
    FROM focowiki.source_files
    WHERE id = ${input.sourceFileId}
      AND knowledge_base_id = ${input.operation.knowledge_base_id}
      AND deleted_at IS NULL
    LIMIT 1
    FOR UPDATE
  `;
  const source = requireRow(sources[0]);
  if (source.deletion_intent_id || source.candidate_operation_id) {
    throw new SourceResourceError("RESOURCE_DELETING");
  }
  if (source.processing_status === "queued" || source.processing_status === "running") {
    throw new SourceResourceError("RESOURCE_BUSY");
  }
  if (
    input.operation.expected_resource_revision !== null &&
    source.resource_revision !== input.operation.expected_resource_revision
  ) {
    throw new SourceResourceError("RESOURCE_REVISION_CONFLICT");
  }

  const targetPath = normalizeSourceRelativePath(
    readRequiredString(input.request.relativePath, source.relative_path)
  );
  const targetDirectoryId = await resolveTargetDirectoryId(transaction, {
    knowledgeBaseId: source.knowledge_base_id,
    directoryPath: targetPath.directoryPath
  });
  const pathChanged = targetPath.pathKey !== source.path_key;
  if (input.operation.operation_kind === "source_file_move" && !pathChanged) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  if (pathChanged) {
    await assertSourceFilePathAvailable(transaction, {
      knowledgeBaseId: source.knowledge_base_id,
      sourceFileId: source.id,
      pathKey: targetPath.pathKey
    });
    await transaction`
      INSERT INTO focowiki.resource_path_reservations (
        knowledge_base_id, resource_kind, path_key, operation_id, target_id
      ) VALUES (
        ${source.knowledge_base_id}, 'source_file', ${targetPath.pathKey},
        ${input.operation.id}, ${source.id}
      )
    `;
  }

  const replacement = input.operation.operation_kind === "source_file_replace";
  const revisionId = replacement ? readRequiredString(input.request.revisionId) : null;
  const objectKey = replacement ? readRequiredString(input.request.objectKey) : null;
  const checksumSha256 = replacement ? readRequiredString(input.request.checksumSha256) : null;
  const contentType = replacement
    ? readRequiredString(input.request.contentType, "text/markdown; charset=utf-8")
    : null;
  const sizeBytes = replacement ? readNonNegativeInteger(input.request.sizeBytes) : null;
  const candidateContentRevision = replacement ? source.content_revision + 1 : source.content_revision;

  if (replacement && revisionId && objectKey && checksumSha256 && contentType && sizeBytes !== null) {
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key, content_type,
        size_bytes, checksum_sha256, metadata_json, processing_status
      ) VALUES (
        ${revisionId}, ${source.knowledge_base_id}, ${source.id}, ${candidateContentRevision},
        ${objectKey}, ${contentType}, ${sizeBytes}, ${checksumSha256}, '{}'::jsonb, 'queued'
      )
    `;
  }

  await transaction`
    UPDATE focowiki.resource_operation_targets
    SET current_json = ${transaction.json({
      relativePath: source.relative_path,
      directoryId: source.directory_id,
      resourceRevision: source.resource_revision,
      contentRevision: source.content_revision,
      activeRevisionId: source.active_revision_id
    } as never)},
        candidate_json = ${transaction.json({
          relativePath: targetPath.relativePath,
          directoryId: targetDirectoryId,
          resourceRevision: source.resource_revision + 1,
          contentRevision: candidateContentRevision,
          ...(revisionId ? { revisionId } : {})
        } as never)}
    WHERE operation_id = ${input.operation.id}
      AND target_kind = 'source_file'
      AND target_id = ${source.id}
  `;

  await transaction`
    UPDATE focowiki.source_files
    SET candidate_operation_id = ${input.operation.id},
        candidate_revision_id = ${revisionId},
        candidate_name = ${targetPath.name},
        candidate_relative_path = ${targetPath.relativePath},
        candidate_path_key = ${targetPath.pathKey},
        candidate_directory_id = ${targetDirectoryId},
        candidate_object_key = ${objectKey},
        candidate_content_type = ${contentType},
        candidate_size_bytes = ${sizeBytes},
        candidate_checksum_sha256 = ${checksumSha256},
        candidate_metadata_json = CASE WHEN ${replacement} THEN '{}'::jsonb ELSE metadata_json END,
        candidate_model_suggestions_json = CASE WHEN ${replacement} THEN NULL ELSE model_suggestions_json END,
        processing_status = CASE WHEN ${replacement} THEN 'queued' ELSE processing_status END,
        processing_stage = CASE WHEN ${replacement} THEN 'upload_storage' ELSE processing_stage END,
        processing_started_at = CASE WHEN ${replacement} THEN NULL ELSE processing_started_at END,
        processing_ended_at = CASE WHEN ${replacement} THEN NULL ELSE processing_ended_at END,
        terminal_failure_stage = CASE WHEN ${replacement} THEN NULL ELSE terminal_failure_stage END,
        terminal_failure_code = CASE WHEN ${replacement} THEN NULL ELSE terminal_failure_code END,
        terminal_failure_message = CASE WHEN ${replacement} THEN NULL ELSE terminal_failure_message END,
        terminal_failure_at = CASE WHEN ${replacement} THEN NULL ELSE terminal_failure_at END,
        terminal_failure_retry_kind = CASE WHEN ${replacement}
          THEN NULL ELSE terminal_failure_retry_kind END,
        terminal_failure_correlation_id = CASE WHEN ${replacement}
          THEN NULL ELSE terminal_failure_correlation_id END
    WHERE id = ${source.id}
      AND candidate_operation_id IS NULL
      AND deleted_at IS NULL
  `;

  const state = replacement ? "processing" : "publishing";
  const operations = await transaction<OperationRow[]>`
    UPDATE focowiki.resource_operations
    SET state = ${state},
        result_json = ${transaction.json({
          sourceFileId: source.id,
          sourceRevisionId: revisionId ?? source.active_revision_id,
          activeRelativePath: source.relative_path,
          candidateRelativePath: targetPath.relativePath,
          candidateResourceRevision: source.resource_revision + 1,
          candidateContentRevision
        } as never)},
        updated_at = ${input.now}
    WHERE id = ${input.operation.id}
      AND state = 'accepted'
    RETURNING ${transaction.unsafe(OPERATION_COLUMNS)}
  `;
  return { operation: requireRow(operations[0]) };
}

async function prepareSourceDirectoryMove(
  transaction: import("postgres").TransactionSql,
  input: {
    operation: OperationRow;
    directoryId: string;
    request: Record<string, unknown>;
    now: string;
  }
): Promise<OperationRow> {
  const directories = await transaction<Array<{
    id: string;
    knowledge_base_id: string;
    parent_id: string | null;
    name: string;
    relative_path: string;
    path_key: string;
    depth: number;
    resource_revision: number;
    candidate_operation_id: string | null;
    deletion_intent_id: string | null;
  }>>`
    SELECT id, knowledge_base_id, parent_id, name, relative_path, path_key, depth,
           resource_revision, candidate_operation_id, deletion_intent_id
    FROM focowiki.source_directories
    WHERE id = ${input.directoryId}
      AND knowledge_base_id = ${input.operation.knowledge_base_id}
      AND deleted_at IS NULL
    LIMIT 1
    FOR UPDATE
  `;
  const directory = requireRow(directories[0]);
  if (directory.deletion_intent_id || directory.candidate_operation_id) {
    throw new SourceResourceError("RESOURCE_DELETING");
  }
  if (
    input.operation.expected_resource_revision !== null &&
    directory.resource_revision !== input.operation.expected_resource_revision
  ) {
    throw new SourceResourceError("RESOURCE_REVISION_CONFLICT");
  }
  const busyDescendants = await transaction<Array<{ busy: boolean }>>`
    WITH RECURSIVE descendants AS (
      SELECT id
      FROM focowiki.source_directories
      WHERE id = ${directory.id}
      UNION ALL
      SELECT child.id
      FROM focowiki.source_directories child
      JOIN descendants parent ON child.parent_id = parent.id
      WHERE child.deleted_at IS NULL
    )
    SELECT EXISTS (
      SELECT 1
      FROM focowiki.source_directories child
      WHERE child.id IN (SELECT id FROM descendants)
        AND child.id <> ${directory.id}
        AND (child.candidate_operation_id IS NOT NULL OR child.deletion_intent_id IS NOT NULL)
      UNION ALL
      SELECT 1
      FROM focowiki.source_files source
      WHERE source.directory_id IN (SELECT id FROM descendants)
        AND source.deleted_at IS NULL
        AND (
          source.processing_status IN ('queued', 'running')
          OR source.candidate_operation_id IS NOT NULL
          OR source.deletion_intent_id IS NOT NULL
        )
    ) AS busy
  `;
  if (busyDescendants[0]?.busy) throw new SourceResourceError("RESOURCE_BUSY");
  const target = normalizeSourceDirectoryPath(readRequiredString(input.request.relativePath));
  if (target.pathKey === directory.path_key || target.pathKey.startsWith(`${directory.path_key}/`)) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  const targetParentId = await resolveTargetDirectoryId(transaction, {
    knowledgeBaseId: directory.knowledge_base_id,
    directoryPath: target.parentPath,
    excludedPathPrefix: directory.path_key
  });

  const conflicts = await transaction<Array<{ exists: boolean }>>`
    WITH RECURSIVE descendants AS (
      SELECT id, path_key, relative_path
      FROM focowiki.source_directories
      WHERE id = ${directory.id}
      UNION ALL
      SELECT child.id, child.path_key, child.relative_path
      FROM descendants
      JOIN focowiki.source_directories child ON child.parent_id = descendants.id
      WHERE child.deleted_at IS NULL
    ),
    candidate_directories AS (
      SELECT id,
             CASE
               WHEN path_key = ${directory.path_key} THEN ${target.pathKey}
               ELSE ${target.pathKey} || substring(path_key from char_length(${directory.path_key}) + 1)
             END AS path_key
      FROM descendants
    ),
    candidate_files AS (
      SELECT source.id,
             ${target.pathKey} || substring(source.path_key from char_length(${directory.path_key}) + 1) AS path_key
      FROM focowiki.source_files source
      WHERE source.directory_id IN (SELECT id FROM descendants)
        AND source.deleted_at IS NULL
    )
    SELECT EXISTS (
      SELECT 1 FROM candidate_directories candidate
      JOIN focowiki.source_directories active
        ON active.knowledge_base_id = ${directory.knowledge_base_id}
       AND active.path_key = candidate.path_key
       AND active.deleted_at IS NULL
       AND active.id NOT IN (SELECT id FROM descendants)
      UNION ALL
      SELECT 1 FROM candidate_files candidate
      JOIN focowiki.source_files active
        ON active.knowledge_base_id = ${directory.knowledge_base_id}
       AND active.path_key = candidate.path_key
       AND active.deleted_at IS NULL
       AND active.id NOT IN (SELECT id FROM candidate_files)
      UNION ALL
      SELECT 1 FROM focowiki.resource_path_reservations reservation
      WHERE reservation.knowledge_base_id = ${directory.knowledge_base_id}
        AND (
          (reservation.resource_kind = 'source_directory'
            AND reservation.path_key IN (SELECT path_key FROM candidate_directories))
          OR (reservation.resource_kind = 'source_file'
            AND reservation.path_key IN (SELECT path_key FROM candidate_files))
        )
    ) AS exists
  `;
  if (conflicts[0]?.exists) throw new SourceResourceError("RESOURCE_PATH_CONFLICT");

  await transaction`
    WITH RECURSIVE descendants AS (
      SELECT id, parent_id, name, relative_path, path_key, depth, resource_revision
      FROM focowiki.source_directories WHERE id = ${directory.id}
      UNION ALL
      SELECT child.id, child.parent_id, child.name, child.relative_path, child.path_key,
             child.depth, child.resource_revision
      FROM descendants
      JOIN focowiki.source_directories child ON child.parent_id = descendants.id
      WHERE child.deleted_at IS NULL
    )
    INSERT INTO focowiki.resource_operation_targets (
      operation_id, target_kind, target_id, expected_resource_revision, sequence_number,
      current_json, candidate_json
    )
    SELECT ${input.operation.id}, 'source_directory', descendant.id,
           descendant.resource_revision, row_number() OVER (ORDER BY descendant.path_key),
           jsonb_build_object('relativePath', descendant.relative_path, 'parentDirectoryId', descendant.parent_id),
           jsonb_build_object(
             'relativePath', CASE
               WHEN descendant.relative_path = ${directory.relative_path} THEN ${target.relativePath}
               ELSE ${target.relativePath} || substring(descendant.relative_path from char_length(${directory.relative_path}) + 1)
             END,
             'parentDirectoryId', CASE WHEN descendant.id = ${directory.id} THEN ${targetParentId} ELSE descendant.parent_id END
           )
    FROM descendants descendant
    ON CONFLICT (operation_id, target_kind, target_id) DO UPDATE
      SET sequence_number = EXCLUDED.sequence_number,
          current_json = EXCLUDED.current_json,
          candidate_json = EXCLUDED.candidate_json
  `;
  await transaction`
    WITH RECURSIVE descendants AS (
      SELECT id, directory_id, relative_path, path_key, resource_revision, content_revision
      FROM focowiki.source_files
      WHERE directory_id = ${directory.id} AND deleted_at IS NULL
      UNION ALL
      SELECT source.id, source.directory_id, source.relative_path, source.path_key,
             source.resource_revision, source.content_revision
      FROM focowiki.source_files source
      JOIN focowiki.source_directories owner ON owner.id = source.directory_id
      WHERE owner.path_key LIKE ${`${directory.path_key}/%`}
        AND owner.deleted_at IS NULL AND source.deleted_at IS NULL
    )
    INSERT INTO focowiki.resource_operation_targets (
      operation_id, target_kind, target_id, expected_resource_revision, sequence_number,
      current_json, candidate_json
    )
    SELECT ${input.operation.id}, 'source_file', descendant.id, descendant.resource_revision,
           1000000000 + row_number() OVER (ORDER BY descendant.path_key),
           jsonb_build_object('relativePath', descendant.relative_path, 'directoryId', descendant.directory_id),
           jsonb_build_object(
             'relativePath', ${target.relativePath} || substring(descendant.relative_path from char_length(${directory.relative_path}) + 1),
             'directoryId', descendant.directory_id,
             'contentRevision', descendant.content_revision
           )
    FROM descendants descendant
    ON CONFLICT (operation_id, target_kind, target_id) DO NOTHING
  `;
  await reserveDirectoryMovePaths(transaction, {
    operationId: input.operation.id,
    knowledgeBaseId: directory.knowledge_base_id,
    directoryId: directory.id,
    sourcePath: directory.path_key,
    targetPath: target.pathKey
  });
  await transaction`
    WITH RECURSIVE descendants AS (
      SELECT id, parent_id, name, relative_path, path_key, depth
      FROM focowiki.source_directories WHERE id = ${directory.id}
      UNION ALL
      SELECT child.id, child.parent_id, child.name, child.relative_path, child.path_key, child.depth
      FROM descendants
      JOIN focowiki.source_directories child ON child.parent_id = descendants.id
      WHERE child.deleted_at IS NULL
    )
    UPDATE focowiki.source_directories candidate
    SET candidate_operation_id = ${input.operation.id},
        candidate_parent_id = CASE WHEN candidate.id = ${directory.id} THEN ${targetParentId} ELSE candidate.parent_id END,
        candidate_name = CASE WHEN candidate.id = ${directory.id} THEN ${target.name} ELSE candidate.name END,
        candidate_relative_path = CASE
          WHEN candidate.relative_path = ${directory.relative_path} THEN ${target.relativePath}
          ELSE ${target.relativePath} || substring(candidate.relative_path from char_length(${directory.relative_path}) + 1)
        END,
        candidate_path_key = CASE
          WHEN candidate.path_key = ${directory.path_key} THEN ${target.pathKey}
          ELSE ${target.pathKey} || substring(candidate.path_key from char_length(${directory.path_key}) + 1)
        END,
        candidate_depth = ${target.depth} + candidate.depth - ${directory.depth}
    WHERE candidate.id IN (SELECT id FROM descendants)
      AND candidate.candidate_operation_id IS NULL
  `;
  await transaction`
    UPDATE focowiki.source_files source
    SET candidate_operation_id = ${input.operation.id},
        candidate_name = source.name,
        candidate_relative_path = ${target.relativePath} || substring(source.relative_path from char_length(${directory.relative_path}) + 1),
        candidate_path_key = ${target.pathKey} || substring(source.path_key from char_length(${directory.path_key}) + 1),
        candidate_directory_id = source.directory_id,
        candidate_metadata_json = source.metadata_json,
        candidate_model_suggestions_json = source.model_suggestions_json
    WHERE source.knowledge_base_id = ${directory.knowledge_base_id}
      AND source.deleted_at IS NULL
      AND source.directory_id IN (
        SELECT id FROM focowiki.source_directories WHERE candidate_operation_id = ${input.operation.id}
      )
      AND source.candidate_operation_id IS NULL
  `;
  const operations = await transaction<OperationRow[]>`
    UPDATE focowiki.resource_operations
    SET state = 'publishing',
        result_json = ${transaction.json({
          sourceDirectoryId: directory.id,
          activeRelativePath: directory.relative_path,
          candidateRelativePath: target.relativePath,
          candidateResourceRevision: directory.resource_revision + 1
        } as never)},
        updated_at = ${input.now}
    WHERE id = ${input.operation.id} AND state = 'accepted'
    RETURNING ${transaction.unsafe(OPERATION_COLUMNS)}
  `;
  return requireRow(operations[0]);
}

async function resolveTargetDirectoryId(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; directoryPath: string; excludedPathPrefix?: string }
): Promise<string | null> {
  if (!input.directoryPath) return null;
  const normalized = normalizeSourceDirectoryPath(input.directoryPath);
  const rows = await transaction<Array<{
    id: string;
    candidate_operation_id: string | null;
    deletion_intent_id: string | null;
  }>>`
    SELECT id, candidate_operation_id, deletion_intent_id
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND path_key = ${normalized.pathKey}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.deletion_intent_id || row.candidate_operation_id) {
    throw new SourceResourceError("RESOURCE_PATH_CONFLICT");
  }
  if (input.excludedPathPrefix && normalized.pathKey.startsWith(`${input.excludedPathPrefix}/`)) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  return row.id;
}

async function assertSourceFilePathAvailable(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; sourceFileId: string; pathKey: string }
): Promise<void> {
  const rows = await transaction<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM focowiki.source_files
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND path_key = ${input.pathKey}
        AND id <> ${input.sourceFileId}
        AND deleted_at IS NULL
      UNION ALL
      SELECT 1 FROM focowiki.resource_path_reservations
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND resource_kind = 'source_file'
        AND path_key = ${input.pathKey}
    ) AS exists
  `;
  if (rows[0]?.exists) throw new SourceResourceError("RESOURCE_PATH_CONFLICT");
}

async function reserveDirectoryMovePaths(
  transaction: import("postgres").TransactionSql,
  input: {
    operationId: string;
    knowledgeBaseId: string;
    directoryId: string;
    sourcePath: string;
    targetPath: string;
  }
): Promise<void> {
  await transaction`
    WITH RECURSIVE descendants AS (
      SELECT id, path_key FROM focowiki.source_directories WHERE id = ${input.directoryId}
      UNION ALL
      SELECT child.id, child.path_key
      FROM descendants JOIN focowiki.source_directories child ON child.parent_id = descendants.id
      WHERE child.deleted_at IS NULL
    )
    INSERT INTO focowiki.resource_path_reservations (
      knowledge_base_id, resource_kind, path_key, operation_id, target_id
    )
    SELECT ${input.knowledgeBaseId}, 'source_directory',
           CASE
             WHEN descendant.path_key = ${input.sourcePath} THEN ${input.targetPath}
             ELSE ${input.targetPath} || substring(descendant.path_key from char_length(${input.sourcePath}) + 1)
           END,
           ${input.operationId}, descendant.id
    FROM descendants descendant
  `;
  await transaction`
    WITH RECURSIVE descendants AS (
      SELECT id FROM focowiki.source_directories WHERE id = ${input.directoryId}
      UNION ALL
      SELECT child.id FROM descendants
      JOIN focowiki.source_directories child ON child.parent_id = descendants.id
      WHERE child.deleted_at IS NULL
    )
    INSERT INTO focowiki.resource_path_reservations (
      knowledge_base_id, resource_kind, path_key, operation_id, target_id
    )
    SELECT ${input.knowledgeBaseId}, 'source_file',
           ${input.targetPath} || substring(source.path_key from char_length(${input.sourcePath}) + 1),
           ${input.operationId}, source.id
    FROM focowiki.source_files source
    WHERE source.directory_id IN (SELECT id FROM descendants)
      AND source.deleted_at IS NULL
  `;
}

async function findEffectiveDirectoryDeletion(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; targetPathKey: string }
): Promise<{
  deletionIntentId: string;
  directoryId: string;
  operation: OperationRow;
} | null> {
  const rows = await transaction<Array<{
    deletion_intent_id: string;
    directory_id: string;
  }>>`
    SELECT intent.id AS deletion_intent_id, directory.id AS directory_id
    FROM focowiki.source_directories directory
    JOIN focowiki.deletion_intents intent
      ON intent.id = directory.deletion_intent_id
     AND intent.state IN ('accepted', 'running')
    WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        directory.path_key = ${input.targetPathKey}
        OR left(${input.targetPathKey}, char_length(directory.path_key) + 1)
          = directory.path_key || '/'
      )
    ORDER BY directory.depth ASC, directory.id ASC
    LIMIT 1
  `;
  const effective = rows[0];
  if (!effective) return null;
  const operations = await transaction<OperationRow[]>`
    SELECT ${transaction.unsafe(QUALIFIED_OPERATION_COLUMNS)}
    FROM focowiki.resource_operations operation
    JOIN focowiki.resource_operation_targets target
      ON target.operation_id = operation.id
     AND target.target_kind = 'source_directory'
     AND target.target_id = ${effective.directory_id}
    WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
      AND operation.operation_kind = 'source_directory_delete'
      AND operation.state IN ('accepted', 'processing', 'publishing', 'completed')
    ORDER BY operation.created_at DESC, operation.id DESC
    LIMIT 1
  `;
  const operation = operations[0];
  return operation
    ? {
        deletionIntentId: effective.deletion_intent_id,
        directoryId: effective.directory_id,
        operation
      }
    : null;
}

async function findEffectiveSourceFileDeletion(
  transaction: import("postgres").TransactionSql,
  input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    sourcePathKey: string;
    deletionIntentId: string | null;
  }
): Promise<{ deletionIntentId: string; operation: OperationRow } | null> {
  if (input.deletionIntentId) {
    const intents = await transaction<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.deletion_intents
      WHERE id = ${input.deletionIntentId}
        AND knowledge_base_id = ${input.knowledgeBaseId}
      LIMIT 1
    `;
    if (intents[0] && ["accepted", "running"].includes(intents[0].state)) {
      const operations = await transaction<OperationRow[]>`
        SELECT ${transaction.unsafe(QUALIFIED_OPERATION_COLUMNS)}
        FROM focowiki.resource_operations operation
        JOIN focowiki.resource_operation_targets target
          ON target.operation_id = operation.id
         AND target.target_kind = 'source_file'
         AND target.target_id = ${input.sourceFileId}
        WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
          AND operation.operation_kind = 'source_file_delete'
          AND operation.state IN ('accepted', 'processing', 'publishing', 'completed')
        ORDER BY operation.created_at DESC, operation.id DESC
        LIMIT 1
      `;
      if (operations[0]) {
        return { deletionIntentId: input.deletionIntentId, operation: operations[0] };
      }
    }
  }

  const directoryDeletion = await findEffectiveDirectoryDeletion(transaction, {
    knowledgeBaseId: input.knowledgeBaseId,
    targetPathKey: input.sourcePathKey
  });
  return directoryDeletion
    ? {
        deletionIntentId: directoryDeletion.deletionIntentId,
        operation: directoryDeletion.operation
      }
    : null;
}

async function supersedeDescendantDeletionIntents(
  transaction: import("postgres").TransactionSql,
  input: {
    knowledgeBaseId: string;
    targetPathKey: string;
    excludeIntentId: string;
    completedAt: string;
  }
): Promise<void> {
  const superseded = await transaction<Array<{ target_id: string }>>`
    UPDATE focowiki.deletion_intents intent
    SET state = 'superseded', completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
    FROM focowiki.source_directories directory
    WHERE intent.id = directory.deletion_intent_id
      AND intent.knowledge_base_id = ${input.knowledgeBaseId}
      AND intent.id <> ${input.excludeIntentId}
      AND intent.target_kind = 'source_directory'
      AND intent.state IN ('accepted', 'running')
      AND directory.path_key COLLATE "C" >= ${`${input.targetPathKey}/`}::text COLLATE "C"
      AND directory.path_key COLLATE "C" < ${`${input.targetPathKey}0`}::text COLLATE "C"
    RETURNING intent.target_id
  `;
  const targetIds = superseded.map((row) => row.target_id);
  if (targetIds.length === 0) return;
  await transaction`
    UPDATE focowiki.resource_operations operation
    SET state = 'superseded', completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
    FROM focowiki.resource_operation_targets target
    WHERE target.operation_id = operation.id
      AND operation.knowledge_base_id = ${input.knowledgeBaseId}
      AND operation.operation_kind = 'source_directory_delete'
      AND operation.state IN ('accepted', 'processing', 'publishing')
      AND target.target_kind = 'source_directory'
      AND target.target_id = ANY(${targetIds})
  `;
}

async function prepareSourceDirectoryDeletionBatch(
  transaction: import("postgres").TransactionSql,
  input: {
    operation: OperationRow;
    directoryId: string;
    now: string;
    batchSize: number;
  }
) {
  const batchSize = Math.min(Math.max(Math.floor(input.batchSize), 1), 5_000);
  const directories = await transaction<Array<{
    knowledge_base_id: string;
    path_key: string;
    deletion_intent_id: string | null;
  }>>`
    SELECT knowledge_base_id, path_key, deletion_intent_id
    FROM focowiki.source_directories
    WHERE id = ${input.directoryId}
      AND knowledge_base_id = ${input.operation.knowledge_base_id}
    LIMIT 1
    FOR UPDATE
  `;
  const directory = requireRow(directories[0]);
  const intents = await transaction<Array<{ id: string; state: string }>>`
    SELECT id, state
    FROM focowiki.deletion_intents
    WHERE knowledge_base_id = ${directory.knowledge_base_id}
      AND target_kind = 'source_directory'
      AND target_id = ${input.directoryId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `;
  const intent = requireRow(intents[0]);
  if (intent.state === "superseded" || intent.state === "cancelled") {
    const superseded = await transaction<OperationRow[]>`
      UPDATE focowiki.resource_operations
      SET state = 'superseded', completed_at = ${input.now}, updated_at = ${input.now}
      WHERE id = ${input.operation.id}
      RETURNING ${transaction.unsafe(OPERATION_COLUMNS)}
    `;
    return operationPreparationResult(requireRow(superseded[0]), null);
  }

  await supersedeCandidateOperationsForDeletion(transaction, {
    knowledgeBaseId: directory.knowledge_base_id,
    pathKey: directory.path_key,
    deletionOperationId: input.operation.id,
    completedAt: input.now,
    batchSize
  });

  await transaction`
    WITH candidates AS (
      SELECT child.id
      FROM focowiki.source_directories child
      LEFT JOIN focowiki.deletion_intents owner ON owner.id = child.deletion_intent_id
      WHERE child.knowledge_base_id = ${directory.knowledge_base_id}
        AND (
          child.path_key = ${directory.path_key}
          OR (
            child.path_key COLLATE "C" >= ${`${directory.path_key}/`}::text COLLATE "C"
            AND child.path_key COLLATE "C" < ${`${directory.path_key}0`}::text COLLATE "C"
          )
        )
        AND (
          child.deletion_intent_id IS NULL
          OR child.deletion_intent_id = ${intent.id}
          OR owner.state = 'superseded'
        )
        AND child.deletion_intent_id IS DISTINCT FROM ${intent.id}
      ORDER BY child.path_key COLLATE "C", child.id
      LIMIT ${batchSize}
      FOR UPDATE OF child SKIP LOCKED
    )
    UPDATE focowiki.source_directories child
    SET deletion_intent_id = ${intent.id}, deleted_at = COALESCE(child.deleted_at, ${input.now}),
        updated_at = ${input.now}
    FROM candidates
    WHERE child.id = candidates.id
  `;

  await transaction`
    WITH candidates AS (
      SELECT source.id
      FROM focowiki.source_files source
      LEFT JOIN focowiki.deletion_intents owner ON owner.id = source.deletion_intent_id
      WHERE source.knowledge_base_id = ${directory.knowledge_base_id}
        AND source.path_key COLLATE "C" >= ${`${directory.path_key}/`}::text COLLATE "C"
        AND source.path_key COLLATE "C" < ${`${directory.path_key}0`}::text COLLATE "C"
        AND (
          source.deletion_intent_id IS NULL
          OR source.deletion_intent_id = ${intent.id}
          OR owner.state = 'superseded'
        )
        AND source.deletion_intent_id IS DISTINCT FROM ${intent.id}
      ORDER BY source.path_key COLLATE "C", source.id
      LIMIT ${batchSize}
      FOR UPDATE OF source SKIP LOCKED
    )
    UPDATE focowiki.source_files source
    SET deletion_intent_id = ${intent.id}, deleted_at = COALESCE(source.deleted_at, ${input.now})
    FROM candidates
    WHERE source.id = candidates.id
  `;

  await rejectUploadEntriesForDirectoryDeletion(transaction, {
    knowledgeBaseId: directory.knowledge_base_id,
    pathKey: directory.path_key,
    now: input.now,
    batchSize
  });

  const remaining = await hasUnmarkedDirectoryDeletionRows(transaction, {
    knowledgeBaseId: directory.knowledge_base_id,
    pathKey: directory.path_key,
    deletionIntentId: intent.id
  });

  const counts = remaining
    ? null
    : await countDirectoryDeletionRows(transaction, {
        knowledgeBaseId: directory.knowledge_base_id,
        deletionIntentId: intent.id
      });
  const result = requireRecord(input.operation.result_json);
  const nextResult = {
    ...result,
    ...(counts
      ? {
          affectedDirectoryCount: counts.directoryCount,
          affectedFileCount: counts.fileCount
        }
      : {})
  };
  await transaction`
    UPDATE focowiki.deletion_intents
    SET state = 'running',
        progress_cursor = ${remaining ? "marking_descendants" : "awaiting_publication"},
        updated_at = ${input.now}
    WHERE id = ${intent.id}
      AND state IN ('accepted', 'running')
  `;
  const operations = await transaction<OperationRow[]>`
    UPDATE focowiki.resource_operations
    SET state = ${remaining ? "processing" : "publishing"},
        result_json = ${transaction.json(nextResult as never)},
        updated_at = ${input.now}
    WHERE id = ${input.operation.id}
      AND state IN ('accepted', 'processing')
    RETURNING ${transaction.unsafe(OPERATION_COLUMNS)}
  `;
  const operation = requireRow(operations[0]);
  return {
    ...operationPreparationResult(operation, null),
    requiresContinuation: remaining,
    directoryDeletion: remaining
      ? null
      : { deletionIntentId: intent.id, directoryId: input.directoryId }
  };
}

async function supersedeCandidateOperationsForDeletion(
  transaction: import("postgres").TransactionSql,
  input: {
    knowledgeBaseId: string;
    pathKey: string;
    deletionOperationId: string;
    completedAt: string;
    batchSize: number;
  }
): Promise<void> {
  const rows = await transaction<Array<{ operation_id: string }>>`
    SELECT DISTINCT candidate_operation_id AS operation_id
    FROM (
      SELECT candidate_operation_id, path_key
      FROM focowiki.source_directories
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
      UNION ALL
      SELECT candidate_operation_id, path_key
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
    ) candidate
    WHERE candidate_operation_id IS NOT NULL
      AND candidate_operation_id <> ${input.deletionOperationId}
      AND (
        path_key = ${input.pathKey}
        OR (
          path_key COLLATE "C" >= ${`${input.pathKey}/`}::text COLLATE "C"
          AND path_key COLLATE "C" < ${`${input.pathKey}0`}::text COLLATE "C"
        )
      )
    ORDER BY operation_id
    LIMIT ${input.batchSize}
  `;
  for (const row of rows) {
    await supersedeCandidateOperation(transaction, row.operation_id, input.completedAt);
  }
}

async function rejectUploadEntriesForDirectoryDeletion(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; pathKey: string; now: string; batchSize: number }
): Promise<void> {
  const rows = await transaction<Array<{ id: string }>>`
    WITH candidates AS (
      SELECT id
      FROM focowiki.upload_session_entries
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND disposition IN ('pending', 'upload_required', 'waiting_reservation')
        AND path_key COLLATE "C" >= ${`${input.pathKey}/`}::text COLLATE "C"
        AND path_key COLLATE "C" < ${`${input.pathKey}0`}::text COLLATE "C"
      ORDER BY path_key COLLATE "C", id
      LIMIT ${input.batchSize}
      FOR UPDATE SKIP LOCKED
    ), updated AS (
      UPDATE focowiki.upload_session_entries entry
      SET disposition = 'rejected_deleting', transfer_state = 'skipped',
          error_code = 'SOURCE_DIRECTORY_DELETING', updated_at = ${input.now}
      FROM candidates
      WHERE entry.id = candidates.id
      RETURNING entry.id
    )
    SELECT id FROM updated
  `;
  const entryIds = rows.map((row) => row.id);
  if (entryIds.length > 0) {
    await transaction`
      DELETE FROM focowiki.source_path_reservations
      WHERE entry_id = ANY(${entryIds})
    `;
  }
}

async function hasUnmarkedDirectoryDeletionRows(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; pathKey: string; deletionIntentId: string }
): Promise<boolean> {
  const rows = await transaction<Array<{ remaining: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM focowiki.source_directories directory
      LEFT JOIN focowiki.deletion_intents owner ON owner.id = directory.deletion_intent_id
      WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          directory.path_key = ${input.pathKey}
          OR (
            directory.path_key COLLATE "C" >= ${`${input.pathKey}/`}::text COLLATE "C"
            AND directory.path_key COLLATE "C" < ${`${input.pathKey}0`}::text COLLATE "C"
          )
        )
        AND directory.deletion_intent_id IS DISTINCT FROM ${input.deletionIntentId}
        AND (directory.deletion_intent_id IS NULL OR owner.state = 'superseded')
      UNION ALL
      SELECT 1
      FROM focowiki.source_files source
      LEFT JOIN focowiki.deletion_intents owner ON owner.id = source.deletion_intent_id
      WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
        AND source.path_key COLLATE "C" >= ${`${input.pathKey}/`}::text COLLATE "C"
        AND source.path_key COLLATE "C" < ${`${input.pathKey}0`}::text COLLATE "C"
        AND source.deletion_intent_id IS DISTINCT FROM ${input.deletionIntentId}
        AND (source.deletion_intent_id IS NULL OR owner.state = 'superseded')
      UNION ALL
      SELECT 1
      FROM focowiki.upload_session_entries entry
      WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
        AND entry.disposition IN ('pending', 'upload_required', 'waiting_reservation')
        AND entry.path_key COLLATE "C" >= ${`${input.pathKey}/`}::text COLLATE "C"
        AND entry.path_key COLLATE "C" < ${`${input.pathKey}0`}::text COLLATE "C"
    ) AS remaining
  `;
  return rows[0]?.remaining ?? false;
}

async function countDirectoryDeletionRows(
  transaction: import("postgres").TransactionSql,
  input: { knowledgeBaseId: string; deletionIntentId: string }
): Promise<{ directoryCount: number; fileCount: number }> {
  const rows = await transaction<Array<{ directory_count: number; file_count: number }>>`
    SELECT
      (SELECT count(*)::int FROM focowiki.source_directories
       WHERE knowledge_base_id = ${input.knowledgeBaseId}
         AND deletion_intent_id = ${input.deletionIntentId}) AS directory_count,
      (SELECT count(*)::int FROM focowiki.source_files
       WHERE knowledge_base_id = ${input.knowledgeBaseId}
         AND deletion_intent_id = ${input.deletionIntentId}) AS file_count
  `;
  return {
    directoryCount: rows[0]?.directory_count ?? 0,
    fileCount: rows[0]?.file_count ?? 0
  };
}

function operationPreparationResult(operation: OperationRow, sourceFileId: string | null) {
  const result = isRecord(operation.result_json) ? operation.result_json : {};
  const sourceRevisionId = readString(result.sourceRevisionId);
  const previousPath = readString(result.activeRelativePath);
  const path = readString(result.candidateRelativePath);
  const resourceRevision = readNumber(result.candidateResourceRevision);
  return {
    operation: mapOperation(operation),
    sourceFileId,
    sourceMutation:
      sourceFileId && sourceRevisionId && previousPath && path && resourceRevision > 0
        ? {
            sourceFileId,
            sourceRevisionId,
            kind: operation.operation_kind === "source_file_replace"
              ? "source_replaced" as const
              : "source_moved" as const,
            previousPath,
            path,
            resourceRevision
          }
        : null,
    directoryMutation:
      !sourceFileId
      && previousPath
      && resourceRevision > 0
      && (operation.operation_kind === "source_directory_move"
        || operation.operation_kind === "source_directory_delete")
        ? {
            kind: operation.operation_kind === "source_directory_move"
              ? "directory_moved" as const
              : "directory_deleted" as const,
            previousPath,
            path,
            resourceRevision,
            deletionIntentId: readString(result.deletionIntentId)
          }
        : null,
    requiresSourceProcessing:
      operation.operation_kind === "source_file_replace" && operation.state === "processing",
    requiresPublication: operation.state === "publishing",
    requiresContinuation: false,
    directoryDeletion: null
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return value;
}

function readRequiredString(value: unknown, fallback?: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  return candidate.trim();
}

function readPendingSourceMutation(value: Record<string, unknown>) {
  const candidate = value.sourceMutation;
  if (!isRecord(candidate)) return null;
  const sourceFileId = readString(candidate.sourceFileId);
  const sourceRevisionId = readString(candidate.sourceRevisionId);
  const previousPath = readString(candidate.previousPath);
  const resourceRevision = readNumber(candidate.resourceRevision);
  if (!sourceFileId || !sourceRevisionId || !previousPath || resourceRevision < 1) {
    return null;
  }
  return {
    sourceFileId,
    sourceRevisionId,
    kind: "source_deleted" as const,
    previousPath,
    path: null,
    resourceRevision
  };
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

function assertRevision(
  row: { resource_revision: number; deleted_at: Date | null } | undefined,
  expected: number | null
): void {
  if (!row || row.deleted_at) throw new SourceResourceError("RESOURCE_NOT_FOUND");
  if (expected !== null && row.resource_revision !== expected) {
    throw new SourceResourceError("RESOURCE_REVISION_CONFLICT");
  }
}

function directoryPage(rows: DirectoryRow[], limit: number) {
  const items = rows.slice(0, limit).map(mapDirectory);
  return { items, nextCursor: rows.length > limit ? items.at(-1)?.id ?? null : null };
}

function sourceFilePage(rows: SourceFileRow[], limit: number) {
  const items = rows.slice(0, limit).map(mapSourceFile);
  return { items, nextCursor: rows.length > limit ? items.at(-1)?.id ?? null : null };
}

function mapDirectory(row: DirectoryRow): SourceDirectoryRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    parentDirectoryId: row.parent_id,
    name: row.name,
    relativePath: row.relative_path,
    depth: row.depth,
    resourceRevision: row.resource_revision,
    directFileCount: row.direct_file_count,
    descendantFileCount: row.descendant_file_count,
    deleting: Boolean(row.deletion_intent_id),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapSourceFile(row: SourceFileRow): SourceResourceFileRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    directoryId: row.directory_id,
    name: row.name,
    relativePath: row.relative_path,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    resourceRevision: row.resource_revision,
    contentRevision: row.content_revision,
    activeRevisionId: row.active_revision_id,
    processingStatus: row.processing_status,
    currentStage: row.processing_stage,
    terminalFailure: mapTerminalFailure(row),
    generatedOutputStatus: row.generated_output_status,
    generatedPath: generatedPagePath(row.relative_path),
    deleting: Boolean(row.deletion_intent_id),
    createdAt: row.created_at.toISOString()
  };
}

function mapTerminalFailure(row: SourceFileRow): SourceFileTerminalFailure | null {
  if (!row.terminal_failure_code) return null;
  if (
    !row.terminal_failure_stage
    || !row.terminal_failure_message
    || !row.terminal_failure_at
    || !row.terminal_failure_retry_kind
    || !row.terminal_failure_correlation_id
  ) {
    throw new Error("Source file terminal failure record is incomplete");
  }
  return {
    stage: row.terminal_failure_stage,
    code: row.terminal_failure_code,
    message: row.terminal_failure_message,
    occurredAt: row.terminal_failure_at.toISOString(),
    retryKind: row.terminal_failure_retry_kind,
    correlationId: row.terminal_failure_correlation_id
  };
}

function mapOperation(row: OperationRow): ResourceOperationRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: row.operation_kind,
    state: row.state,
    expectedResourceRevision: row.expected_resource_revision,
    candidateCatalogGeneration: Number(row.candidate_catalog_generation),
    result: isRecord(row.result_json) ? row.result_json : null,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    targetKind: row.target_kind ?? null,
    targetId: row.target_id ?? null,
    candidateRelativePath: row.candidate_relative_path ?? null
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Database mutation did not return a row.");
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function containsLike(value: string): string {
  return `%${escapeLike(value)}%`;
}

function prefixLike(value: string): string {
  return `${escapeLike(value)}%`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}
