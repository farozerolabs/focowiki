import { createHash } from "node:crypto";
import type { DatabaseClient } from "./client.js";

export type HardDeleteTargetKind = "source_file" | "source_directory" | "knowledge_base";

export type HardDeleteRepository = {
  prepareSourceFileObjectDeletions: (input: {
    jobId: string;
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<number>;
  prepareKnowledgeBaseObjectDeletions: (input: {
    jobId: string;
    knowledgeBaseId: string;
  }) => Promise<number>;
  prepareSourceDirectoryObjectDeletions: (input: {
    jobId: string;
    knowledgeBaseId: string;
    deletionIntentId: string;
  }) => Promise<number>;
  purgeSourceDirectoryReleaseData: (input: {
    jobId: string;
    knowledgeBaseId: string;
    deletionIntentId: string;
    batchSize: number;
  }) => Promise<number>;
  clearObjectDeletionTracking: (input: {
    jobId: string;
    batchSize: number;
  }) => Promise<number>;
  listSourceDirectorySourceFileIds: (input: {
    knowledgeBaseId: string;
    deletionIntentId: string;
    cursor: string | null;
    limit: number;
  }) => Promise<{ items: string[]; nextCursor: string | null }>;
  isSourceDirectoryExcludedFromActiveRelease: (input: {
    knowledgeBaseId: string;
    deletionIntentId: string;
  }) => Promise<boolean>;
  isSourceFileExcludedFromActiveRelease: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<boolean>;
  isDeletionIntentRunnable: (input: {
    knowledgeBaseId: string;
    deletionIntentId: string;
  }) => Promise<boolean>;
  completeSourceFileDeletion: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    deletionIntentId: string;
    completedAt: string;
  }) => Promise<void>;
  completeSourceDirectoryDeletion: (input: {
    knowledgeBaseId: string;
    deletionIntentId: string;
    completedAt: string;
  }) => Promise<number>;
  trackObjectDeletions: (input: {
    jobId: string;
    knowledgeBaseId: string;
    sourceFileId?: string | null;
    objectKeys: string[];
  }) => Promise<number>;
  listKnowledgeBaseSourceFileIds: (input: {
    knowledgeBaseId: string;
    cursor?: string | null;
    limit: number;
  }) => Promise<{ items: string[]; nextCursor: string | null }>;
  listPendingObjectKeys: (input: {
    jobId: string;
    limit: number;
  }) => Promise<string[]>;
  markObjectKeysDeleted: (input: {
    jobId: string;
    objectKeys: string[];
    deletedAt: string;
  }) => Promise<number>;
  hasPendingObjectKeys: (input: {
    jobId: string;
  }) => Promise<boolean>;
  recordHardDeleteProgress: (input: {
    jobId: string;
    stageKey: string;
    cursor: Record<string, unknown>;
    updatedAt: string;
  }) => Promise<void>;
  cancelQueuedKnowledgeBaseWork: (input: {
    knowledgeBaseId: string;
    excludeJobId: string;
    cancelledAt: string;
  }) => Promise<number>;
  purgeSourceFileData: (input: {
    jobId: string;
    knowledgeBaseId: string;
    sourceFileId: string;
    batchSize: number;
  }) => Promise<number>;
  purgeKnowledgeBaseData: (input: {
    jobId: string;
    knowledgeBaseId: string;
    batchSize: number;
  }) => Promise<number>;
};

type CountRow = {
  count: string | number;
};

type ObjectKeyRow = {
  object_key: string;
};

export function createPostgresHardDeleteRepository(sql: DatabaseClient): HardDeleteRepository {
  return {
    async prepareSourceFileObjectDeletions(input) {
      const rows = await sql<CountRow[]>`
        WITH active_release AS (
          SELECT active_release_id
          FROM focowiki.knowledge_bases
          WHERE id = ${input.knowledgeBaseId}
        ),
        affected_releases AS MATERIALIZED (
          SELECT DISTINCT bundle.release_id
          FROM focowiki.bundle_files bundle
          LEFT JOIN active_release active ON true
          WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
            AND bundle.source_file_id = ${input.sourceFileId}
            AND bundle.release_id <> COALESCE(active.active_release_id, '')
        ),
        objects AS (
          SELECT source.object_key, source.id AS source_file_id
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.id = ${input.sourceFileId}
          UNION
          SELECT revision.object_key, revision.source_file_id
          FROM focowiki.source_revisions revision
          WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
            AND revision.source_file_id = ${input.sourceFileId}
          UNION
          SELECT bundle.object_key, bundle.source_file_id
          FROM focowiki.bundle_files bundle
          WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
            AND (
              bundle.source_file_id = ${input.sourceFileId}
              OR bundle.release_id IN (SELECT release_id FROM affected_releases)
            )
        ),
        inserted AS (
          INSERT INTO focowiki.hard_delete_object_deletions (
            id,
            job_id,
            knowledge_base_id,
            source_file_id,
            object_key
          )
          SELECT
            'hard-delete-object-' || md5(${input.jobId} || ':' || objects.object_key),
            ${input.jobId},
            ${input.knowledgeBaseId},
            objects.source_file_id,
            objects.object_key
          FROM objects
          WHERE objects.object_key <> ''
          ON CONFLICT (job_id, object_key) DO NOTHING
          RETURNING id
        )
        SELECT count(*) AS count
        FROM inserted
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async listKnowledgeBaseSourceFileIds(input) {
      const limit = normalizeBatchSize(input.limit);
      const rows = await sql<Array<{ id: string }>>`
        SELECT id
        FROM focowiki.source_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (${input.cursor ?? null}::text IS NULL OR id > ${input.cursor ?? null})
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map((row) => row.id);
      return {
        items,
        nextCursor: rows.length > limit ? (items[items.length - 1] ?? null) : null
      };
    },
    async prepareKnowledgeBaseObjectDeletions(input) {
      const rows = await sql<CountRow[]>`
        WITH objects AS (
          SELECT source.object_key, source.id AS source_file_id
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          UNION
          SELECT revision.object_key, revision.source_file_id
          FROM focowiki.source_revisions revision
          WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
          UNION
          SELECT bundle.object_key, bundle.source_file_id
          FROM focowiki.bundle_files bundle
          WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
        ),
        inserted AS (
          INSERT INTO focowiki.hard_delete_object_deletions (
            id,
            job_id,
            knowledge_base_id,
            source_file_id,
            object_key
          )
          SELECT
            'hard-delete-object-' || md5(${input.jobId} || ':' || objects.object_key),
            ${input.jobId},
            ${input.knowledgeBaseId},
            objects.source_file_id,
            objects.object_key
          FROM objects
          WHERE objects.object_key <> ''
          ON CONFLICT (job_id, object_key) DO NOTHING
          RETURNING id
        )
        SELECT count(*) AS count
        FROM inserted
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async prepareSourceDirectoryObjectDeletions(input) {
      const rows = await sql<CountRow[]>`
        WITH active_release AS (
          SELECT active_release_id
          FROM focowiki.knowledge_bases
          WHERE id = ${input.knowledgeBaseId}
        ),
        affected_sources AS MATERIALIZED (
          SELECT id FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND deletion_intent_id = ${input.deletionIntentId}
        ),
        affected_directories AS MATERIALIZED (
          SELECT id FROM focowiki.source_directories
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND deletion_intent_id = ${input.deletionIntentId}
        ),
        affected_releases AS MATERIALIZED (
          SELECT DISTINCT snapshot.release_id
          FROM focowiki.release_source_directories snapshot
          LEFT JOIN active_release active ON true
          WHERE snapshot.knowledge_base_id = ${input.knowledgeBaseId}
            AND snapshot.source_directory_id IN (SELECT id FROM affected_directories)
            AND snapshot.release_id <> COALESCE(active.active_release_id, '')
        ),
        objects AS (
          SELECT source.object_key, source.id AS source_file_id
          FROM focowiki.source_files source
          WHERE source.id IN (SELECT id FROM affected_sources)
          UNION
          SELECT revision.object_key, revision.source_file_id
          FROM focowiki.source_revisions revision
          WHERE revision.source_file_id IN (SELECT id FROM affected_sources)
          UNION
          SELECT bundle.object_key, bundle.source_file_id
          FROM focowiki.bundle_files bundle
          WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
            AND (
              bundle.source_file_id IN (SELECT id FROM affected_sources)
              OR bundle.release_id IN (SELECT release_id FROM affected_releases)
            )
        ),
        inserted AS (
          INSERT INTO focowiki.hard_delete_object_deletions (
            id, job_id, knowledge_base_id, source_file_id, object_key
          )
          SELECT 'hard-delete-object-' || md5(${input.jobId} || ':' || objects.object_key),
                 ${input.jobId}, ${input.knowledgeBaseId}, objects.source_file_id,
                 objects.object_key
          FROM objects
          WHERE objects.object_key <> ''
          ON CONFLICT (job_id, object_key) DO NOTHING
          RETURNING id
        )
        SELECT count(*) AS count FROM inserted
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async purgeSourceDirectoryReleaseData(input) {
      const batchSize = normalizeBatchSize(input.batchSize);
      const deleted = await deleteUntilEmpty(async () => {
        const rows = await sql<CountRow[]>`
          WITH active_release AS (
            SELECT active_release_id
            FROM focowiki.knowledge_bases
            WHERE id = ${input.knowledgeBaseId}
          ),
          affected_directories AS MATERIALIZED (
            SELECT id
            FROM focowiki.source_directories
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND deletion_intent_id = ${input.deletionIntentId}
          ),
          target_releases AS MATERIALIZED (
            SELECT DISTINCT snapshot.release_id
            FROM focowiki.release_source_directories snapshot
            LEFT JOIN active_release active ON true
            WHERE snapshot.knowledge_base_id = ${input.knowledgeBaseId}
              AND snapshot.source_directory_id IN (SELECT id FROM affected_directories)
              AND snapshot.release_id <> COALESCE(active.active_release_id, '')
            ORDER BY snapshot.release_id ASC
            LIMIT ${batchSize}
          ),
          removed_bundle AS (
            DELETE FROM focowiki.bundle_files bundle
            USING target_releases target
            WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
              AND bundle.release_id = target.release_id
            RETURNING bundle.id
          ),
          removed_publication_jobs AS (
            DELETE FROM focowiki.publication_jobs publication
            USING target_releases target
            WHERE publication.knowledge_base_id = ${input.knowledgeBaseId}
              AND publication.release_id = target.release_id
            RETURNING publication.id
          ),
          removed_releases AS (
            DELETE FROM focowiki.releases release_row
            USING target_releases target
            WHERE release_row.knowledge_base_id = ${input.knowledgeBaseId}
              AND release_row.id = target.release_id
            RETURNING release_row.id
          )
          SELECT (
            (SELECT count(*) FROM removed_bundle)
            + (SELECT count(*) FROM removed_publication_jobs)
            + (SELECT count(*) FROM removed_releases)
          ) AS count
        `;
        return readDeletedCount(rows);
      });
      await recordDatabaseProgress(sql, {
        jobId: input.jobId,
        stageKey: "source_directory_historical_releases",
        deletedCount: deleted
      });
      return deleted;
    },
    async clearObjectDeletionTracking(input) {
      return deleteJobObjectTracking(sql, input, normalizeBatchSize(input.batchSize));
    },
    async listSourceDirectorySourceFileIds(input) {
      const limit = normalizeBatchSize(input.limit);
      const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM focowiki.source_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND deletion_intent_id = ${input.deletionIntentId}
          AND (${input.cursor}::text IS NULL OR id > ${input.cursor})
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map((row) => row.id);
      return { items, nextCursor: rows.length > limit ? items.at(-1) ?? null : null };
    },
    async isSourceDirectoryExcludedFromActiveRelease(input) {
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.knowledge_bases knowledge_base
          JOIN focowiki.bundle_files bundle
            ON bundle.release_id = knowledge_base.active_release_id
           AND bundle.knowledge_base_id = knowledge_base.id
          JOIN focowiki.source_files source ON source.id = bundle.source_file_id
          WHERE knowledge_base.id = ${input.knowledgeBaseId}
            AND source.deletion_intent_id = ${input.deletionIntentId}
        ) AS present
      `;
      return !(rows[0]?.present ?? false);
    },
    async isSourceFileExcludedFromActiveRelease(input) {
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.knowledge_bases knowledge_base
          JOIN focowiki.bundle_files bundle
            ON bundle.release_id = knowledge_base.active_release_id
           AND bundle.knowledge_base_id = knowledge_base.id
          WHERE knowledge_base.id = ${input.knowledgeBaseId}
            AND bundle.source_file_id = ${input.sourceFileId}
        ) AS present
      `;
      return !(rows[0]?.present ?? false);
    },
    async isDeletionIntentRunnable(input) {
      const rows = await sql<Array<{ runnable: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.deletion_intents intent
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = intent.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE intent.id = ${input.deletionIntentId}
            AND intent.knowledge_base_id = ${input.knowledgeBaseId}
            AND intent.state IN ('accepted', 'running')
        ) AS runnable
      `;
      return rows[0]?.runnable ?? false;
    },
    async completeSourceFileDeletion(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.deletion_intents
          SET state = 'completed', completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
          WHERE id = ${input.deletionIntentId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.resource_operations operation
          SET state = 'completed', completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
          FROM focowiki.resource_operation_targets target
          WHERE target.operation_id = operation.id
            AND operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.operation_kind = 'source_file_delete'
            AND target.target_kind = 'source_file'
            AND target.target_id = ${input.sourceFileId}
        `;
      });
    },
    async completeSourceDirectoryDeletion(input) {
      return sql.begin(async (transaction) => {
        const intents = await transaction<Array<{ target_id: string }>>`
          SELECT target_id
          FROM focowiki.deletion_intents
          WHERE id = ${input.deletionIntentId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          LIMIT 1
          FOR UPDATE
        `;
        const targetDirectoryId = intents[0]?.target_id;
        if (!targetDirectoryId) {
          return 0;
        }
        await transaction`
          DELETE FROM focowiki.upload_session_entries entry
          USING focowiki.source_directories directory
          WHERE entry.source_directory_id = directory.id
            AND directory.knowledge_base_id = ${input.knowledgeBaseId}
            AND directory.deletion_intent_id = ${input.deletionIntentId}
        `;
        const removed = await transaction<CountRow[]>`
          WITH removed AS (
            DELETE FROM focowiki.source_directories
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND deletion_intent_id = ${input.deletionIntentId}
            RETURNING id
          )
          SELECT count(*) AS count FROM removed
        `;
        await transaction`
          UPDATE focowiki.deletion_intents
          SET state = 'completed', completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
          WHERE id = ${input.deletionIntentId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.resource_operations operation
          SET state = 'completed', completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
          FROM focowiki.resource_operation_targets target
          WHERE target.operation_id = operation.id
            AND operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.operation_kind = 'source_directory_delete'
            AND target.target_kind = 'source_directory'
            AND target.target_id = ${targetDirectoryId}
        `;
        return Number(removed[0]?.count ?? 0);
      });
    },
    async trackObjectDeletions(input) {
      const objectKeys = uniqueStrings(input.objectKeys).filter((key) => key.length > 0);

      if (objectKeys.length === 0) {
        return 0;
      }

      const rows = await sql<CountRow[]>`
        WITH inserted AS (
          INSERT INTO focowiki.hard_delete_object_deletions ${sql(
            objectKeys.map((objectKey) => ({
              id: `hard-delete-object-${hashObjectDeletionId(input.jobId, objectKey)}`,
              job_id: input.jobId,
              knowledge_base_id: input.knowledgeBaseId,
              source_file_id: input.sourceFileId ?? null,
              object_key: objectKey
            })),
            "id",
            "job_id",
            "knowledge_base_id",
            "source_file_id",
            "object_key"
          )}
          ON CONFLICT (job_id, object_key) DO NOTHING
          RETURNING id
        )
        SELECT count(*) AS count
        FROM inserted
      `;

      return Number(rows[0]?.count ?? 0);
    },
    async listPendingObjectKeys(input) {
      if (input.limit <= 0) {
        return [];
      }

      const rows = await sql<ObjectKeyRow[]>`
        SELECT object_key
        FROM focowiki.hard_delete_object_deletions
        WHERE job_id = ${input.jobId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT ${input.limit}
      `;
      return rows.map((row) => row.object_key);
    },
    async markObjectKeysDeleted(input) {
      if (input.objectKeys.length === 0) {
        return 0;
      }

      const rows = await sql<CountRow[]>`
        WITH updated AS (
          UPDATE focowiki.hard_delete_object_deletions
          SET deleted_at = ${input.deletedAt}
          WHERE job_id = ${input.jobId}
            AND object_key = ANY(${uniqueStrings(input.objectKeys)})
            AND deleted_at IS NULL
          RETURNING id
        )
        SELECT count(*) AS count
        FROM updated
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async hasPendingObjectKeys(input) {
      const rows = await sql<Array<{ id: string }>>`
        SELECT id
        FROM focowiki.hard_delete_object_deletions
        WHERE job_id = ${input.jobId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      return rows.length > 0;
    },
    async recordHardDeleteProgress(input) {
      await sql`
        UPDATE focowiki.worker_jobs
        SET
          hard_delete_stage = ${input.stageKey},
          hard_delete_cursor_json = ${sql.json(input.cursor as never)},
          hard_delete_progress_at = ${input.updatedAt},
          updated_at = now()
        WHERE id = ${input.jobId}
          AND kind = 'hard_delete'
      `;
    },
    async cancelQueuedKnowledgeBaseWork(input) {
      const rows = await sql<CountRow[]>`
        WITH updated AS (
          UPDATE focowiki.worker_jobs
          SET
            status = 'cancelled',
            locked_by = NULL,
            locked_at = NULL,
            heartbeat_at = NULL,
            completed_at = ${input.cancelledAt},
            failed_at = NULL,
            last_error_code = 'KNOWLEDGE_BASE_DELETED',
            last_error_message = 'Knowledge base was deleted before queued work started.',
            updated_at = now()
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id <> ${input.excludeJobId}
            AND status = 'queued'
            AND (
              kind IN ('source_file_processing', 'publication')
              OR (
                kind = 'hard_delete'
                AND COALESCE(payload_json->>'targetKind', '') <> 'knowledge_base'
              )
            )
          RETURNING id
        )
        SELECT count(*) AS count
        FROM updated
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async purgeSourceFileData(input) {
      const batchSize = normalizeBatchSize(input.batchSize);
      let deleted = 0;
      const runStage = async (stageKey: string, operation: () => Promise<number>) => {
        const stageDeleted = await operation();
        deleted += stageDeleted;
        await recordDatabaseProgress(sql, {
          jobId: input.jobId,
          stageKey,
          deletedCount: stageDeleted
        });
      };

      await runStage("source_file_object_tracking", () =>
        deleteSourceFileObjectTracking(sql, input, batchSize)
      );
      await runStage("source_file_markdown_links", () =>
        deleteSourceFileMarkdownLinks(sql, input, batchSize)
      );
      await runStage("source_file_historical_releases", () =>
        deleteSourceFileHistoricalReleaseData(sql, input, batchSize)
      );
      await runStage("source_file_knowledge_graph_search_documents", () =>
        deleteSourceFileKnowledgeGraphSearchDocuments(sql, input, batchSize)
      );
      await runStage("source_file_knowledge_graph_edges", () =>
        deleteSourceFileKnowledgeGraphEdges(sql, input, batchSize)
      );
      await runStage("source_file_knowledge_graph_nodes", () =>
        deleteSourceFileKnowledgeGraphNodes(sql, input, batchSize)
      );
      await runStage("source_file_knowledge_tree_entries", () =>
        deleteSourceFileKnowledgeTreeEntries(sql, input, batchSize)
      );
      await runStage("source_file_graph_edges", () =>
        deleteSourceFileGraphEdges(sql, input, batchSize)
      );
      await runStage("source_file_graph_jobs", () =>
        deleteSourceFileGraphJobs(sql, input, batchSize)
      );
      await runStage("source_file_graph_nodes", () =>
        deleteSourceFileGraphNodes(sql, input, batchSize)
      );
      await runStage("source_file_bundle_files", () =>
        deleteSourceFileBundleFiles(sql, input, batchSize)
      );
      await runStage("source_file_model_invocations", () =>
        deleteSourceFileModelInvocations(sql, input, batchSize)
      );
      await runStage("source_file_events", () => deleteSourceFileEvents(sql, input, batchSize));
      await runStage("source_file_retry_attempts", () =>
        deleteSourceFileRetryAttempts(sql, input, batchSize)
      );
      await runStage("source_file_worker_jobs", () =>
        deleteSourceFileWorkerJobs(sql, input, batchSize)
      );
      await runStage("source_file_upload_entries", () =>
        deleteSourceFileUploadEntries(sql, input, batchSize)
      );
      await runStage("source_file_row", () => deleteSourceFileRow(sql, input));
      await runStage("job_object_tracking", () =>
        deleteJobObjectTracking(sql, { jobId: input.jobId }, batchSize)
      );

      return deleted;
    },
    async purgeKnowledgeBaseData(input) {
      const batchSize = normalizeBatchSize(input.batchSize);
      let deleted = 0;
      const runStage = async (stageKey: string, operation: () => Promise<number>) => {
        const stageDeleted = await operation();
        deleted += stageDeleted;
        await recordDatabaseProgress(sql, {
          jobId: input.jobId,
          stageKey,
          deletedCount: stageDeleted
        });
      };

      await sql`
        UPDATE focowiki.knowledge_bases
        SET active_release_id = NULL
        WHERE id = ${input.knowledgeBaseId}
      `;
      await runStage("knowledge_base_object_tracking", () =>
        deleteKnowledgeBaseObjectTracking(sql, input, batchSize)
      );
      await runStage("knowledge_base_knowledge_graph_insights", () =>
        deleteKnowledgeBaseKnowledgeGraphInsights(sql, input, batchSize)
      );
      await runStage("knowledge_base_knowledge_graph_search_documents", () =>
        deleteKnowledgeBaseKnowledgeGraphSearchDocuments(sql, input, batchSize)
      );
      await runStage("knowledge_base_knowledge_graph_edges", () =>
        deleteKnowledgeBaseKnowledgeGraphEdges(sql, input, batchSize)
      );
      await runStage("knowledge_base_knowledge_graph_nodes", () =>
        deleteKnowledgeBaseKnowledgeGraphNodes(sql, input, batchSize)
      );
      await runStage("knowledge_base_knowledge_tree_entries", () =>
        deleteKnowledgeBaseKnowledgeTreeEntries(sql, input, batchSize)
      );
      await runStage("knowledge_base_graph_edges", () =>
        deleteKnowledgeBaseGraphEdges(sql, input, batchSize)
      );
      await runStage("knowledge_base_graph_jobs", () =>
        deleteKnowledgeBaseGraphJobs(sql, input, batchSize)
      );
      await runStage("knowledge_base_graph_nodes", () =>
        deleteKnowledgeBaseGraphNodes(sql, input, batchSize)
      );
      await runStage("knowledge_base_publication_jobs", () =>
        deleteKnowledgeBasePublicationJobs(sql, input, batchSize)
      );
      await runStage("knowledge_base_model_invocations", () =>
        deleteKnowledgeBaseModelInvocations(sql, input, batchSize)
      );
      await runStage("knowledge_base_events", () =>
        deleteKnowledgeBaseEvents(sql, input, batchSize)
      );
      await runStage("knowledge_base_retry_attempts", () =>
        deleteKnowledgeBaseRetryAttempts(sql, input, batchSize)
      );
      await runStage("knowledge_base_markdown_links", () =>
        deleteKnowledgeBaseMarkdownLinks(sql, input, batchSize)
      );
      await runStage("knowledge_base_bundle_files", () =>
        deleteKnowledgeBaseBundleFiles(sql, input, batchSize)
      );
      await runStage("knowledge_base_releases", () =>
        deleteKnowledgeBaseReleases(sql, input, batchSize)
      );
      await runStage("knowledge_base_worker_jobs", () =>
        deleteKnowledgeBaseWorkerJobs(sql, input, batchSize)
      );
      await runStage("knowledge_base_worker_queue_summaries", () =>
        deleteKnowledgeBaseWorkerQueueSummaries(sql, input)
      );
      await runStage("knowledge_base_source_files", () =>
        deleteKnowledgeBaseSourceFiles(sql, input, batchSize)
      );
      await runStage("knowledge_base_row", () => deleteKnowledgeBaseRow(sql, input));

      return deleted;
    }
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function hashObjectDeletionId(jobId: string, objectKey: string): string {
  return createHash("md5").update(`${jobId}:${objectKey}`).digest("hex");
}

type SourceFilePurgeInput = {
  jobId: string;
  knowledgeBaseId: string;
  sourceFileId: string;
};

type KnowledgeBasePurgeInput = {
  jobId: string;
  knowledgeBaseId: string;
};

function normalizeBatchSize(batchSize: number): number {
  return Math.max(1, Math.floor(batchSize));
}

function readDeletedCount(rows: CountRow[]): number {
  return Number(rows[0]?.count ?? 0);
}

async function deleteUntilEmpty(operation: () => Promise<number>): Promise<number> {
  let total = 0;

  for (;;) {
    const deleted = await operation();
    total += deleted;

    if (deleted === 0) {
      return total;
    }
  }
}

async function deleteJobObjectTracking(
  sql: DatabaseClient,
  input: { jobId: string },
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.hard_delete_object_deletions
        WHERE job_id = ${input.jobId}
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.hard_delete_object_deletions object_deletion
        USING target
        WHERE object_deletion.id = target.id
        RETURNING object_deletion.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileObjectTracking(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.hard_delete_object_deletions
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.hard_delete_object_deletions object_deletion
        USING target
        WHERE object_deletion.id = target.id
        RETURNING object_deletion.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileHistoricalReleaseData(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH active_release AS (
        SELECT active_release_id
        FROM focowiki.knowledge_bases
        WHERE id = ${input.knowledgeBaseId}
      ),
      affected_releases AS MATERIALIZED (
        SELECT DISTINCT bundle.release_id
        FROM focowiki.bundle_files bundle
        LEFT JOIN active_release active ON true
        WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
          AND bundle.source_file_id = ${input.sourceFileId}
          AND bundle.release_id <> COALESCE(active.active_release_id, '')
        ORDER BY bundle.release_id ASC
        LIMIT ${batchSize}
      ),
      removed_bundle AS (
        DELETE FROM focowiki.bundle_files bundle
        USING affected_releases release
        WHERE bundle.knowledge_base_id = ${input.knowledgeBaseId}
          AND bundle.release_id = release.release_id
        RETURNING bundle.id
      ),
      removed_publication_jobs AS (
        DELETE FROM focowiki.publication_jobs job
        USING affected_releases release
        WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.release_id = release.release_id
        RETURNING job.id
      ),
      removed_release AS (
        DELETE FROM focowiki.releases release_row
        USING affected_releases release
        WHERE release_row.knowledge_base_id = ${input.knowledgeBaseId}
          AND release_row.id = release.release_id
        RETURNING release_row.id
      )
      SELECT
        (
          (SELECT count(*) FROM removed_bundle)
          + (SELECT count(*) FROM removed_publication_jobs)
          + (SELECT count(*) FROM removed_release)
        ) AS count
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileMarkdownLinks(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT release_id, from_path, to_path, label
        FROM focowiki.release_markdown_links
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY release_id, from_path COLLATE "C", to_path COLLATE "C", label COLLATE "C"
        LIMIT ${batchSize}
      ), removed AS (
        DELETE FROM focowiki.release_markdown_links link
        USING target
        WHERE link.release_id = target.release_id
          AND link.from_path = target.from_path
          AND link.to_path = target.to_path
          AND link.label = target.label
        RETURNING link.release_id
      )
      SELECT count(*) AS count FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileKnowledgeGraphSearchDocuments(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH source_files AS MATERIALIZED (
        SELECT id
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
      ),
      source_nodes AS MATERIALIZED (
        SELECT id
        FROM focowiki.knowledge_graph_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            source_file_id = ${input.sourceFileId}
            OR file_id IN (SELECT id FROM source_files)
          )
      ),
      source_edges AS MATERIALIZED (
        SELECT id
        FROM focowiki.knowledge_graph_edges
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            from_file_id IN (SELECT id FROM source_files)
            OR to_file_id IN (SELECT id FROM source_files)
          )
      ),
      target AS (
        SELECT id
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            file_id IN (SELECT id FROM source_files)
            OR node_id IN (SELECT id FROM source_nodes)
            OR edge_id IN (SELECT id FROM source_edges)
          )
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_search_documents document
        USING target
        WHERE document.id = target.id
        RETURNING document.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileKnowledgeGraphEdges(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH source_files AS MATERIALIZED (
        SELECT id
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
      ),
      target AS (
        SELECT id
        FROM focowiki.knowledge_graph_edges
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            from_file_id IN (SELECT id FROM source_files)
            OR to_file_id IN (SELECT id FROM source_files)
          )
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_edges edge
        USING target
        WHERE edge.id = target.id
        RETURNING edge.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileKnowledgeGraphNodes(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH source_files AS MATERIALIZED (
        SELECT id
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
      ),
      target AS (
        SELECT id
        FROM focowiki.knowledge_graph_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            source_file_id = ${input.sourceFileId}
            OR file_id IN (SELECT id FROM source_files)
          )
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_nodes node
        USING target
        WHERE node.id = target.id
        RETURNING node.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileKnowledgeTreeEntries(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT entry.id
        FROM focowiki.knowledge_file_tree_nodes entry
        JOIN focowiki.bundle_files file
          ON file.id = entry.file_id
        WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
          AND file.source_file_id = ${input.sourceFileId}
        ORDER BY entry.id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_file_tree_nodes entry
        USING target
        WHERE entry.id = target.id
        RETURNING entry.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileGraphEdges(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_graph_edges
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            from_source_file_id = ${input.sourceFileId}
            OR to_source_file_id = ${input.sourceFileId}
          )
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_graph_edges edge
        USING target
        WHERE edge.id = target.id
        RETURNING edge.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileGraphJobs(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteRowsBySourceFileId(sql, {
    table: "source_file_graph_jobs",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    batchSize
  });
}

async function deleteSourceFileGraphNodes(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT source_file_id
        FROM focowiki.source_file_graph_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY source_file_id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_graph_nodes node
        USING target
        WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
          AND node.source_file_id = target.source_file_id
        RETURNING node.source_file_id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileBundleFiles(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteRowsBySourceFileId(sql, {
    table: "bundle_files",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    batchSize
  });
}

async function deleteSourceFileModelInvocations(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteRowsBySourceFileId(sql, {
    table: "model_invocations",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    batchSize
  });
}

async function deleteSourceFileEvents(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteRowsBySourceFileId(sql, {
    table: "source_file_events",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    batchSize
  });
}

async function deleteSourceFileRetryAttempts(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteRowsBySourceFileId(sql, {
    table: "source_file_retry_attempts",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    batchSize
  });
}

async function deleteSourceFileWorkerJobs(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteSourceFileWorkerJobRows(sql, {
    jobId: input.jobId,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    batchSize
  });
}

async function deleteSourceFileUploadEntries(
  sql: DatabaseClient,
  input: SourceFilePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id FROM focowiki.upload_session_entries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC LIMIT ${batchSize}
      ), removed AS (
        DELETE FROM focowiki.upload_session_entries entry
        USING target WHERE entry.id = target.id RETURNING entry.id
      )
      SELECT count(*) AS count FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteRowsBySourceFileId(
  sql: DatabaseClient,
  input: {
    table:
      | "source_file_graph_jobs"
      | "bundle_files"
      | "model_invocations"
      | "source_file_events"
      | "source_file_retry_attempts";
    knowledgeBaseId: string;
    sourceFileId: string;
    batchSize: number;
  }
): Promise<number> {
  if (input.table === "source_file_graph_jobs") {
    return deleteSourceFileGraphJobsRows(sql, input);
  }
  if (input.table === "bundle_files") {
    return deleteSourceFileBundleFileRows(sql, input);
  }
  if (input.table === "model_invocations") {
    return deleteSourceFileModelInvocationRows(sql, input);
  }
  if (input.table === "source_file_events") {
    return deleteSourceFileEventRows(sql, input);
  }
  return deleteSourceFileRetryAttemptRows(sql, input);
}

async function deleteSourceFileGraphJobsRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_graph_jobs
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_graph_jobs job
        USING target
        WHERE job.id = target.id
        RETURNING job.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileBundleFileRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.bundle_files file
        USING target
        WHERE file.id = target.id
        RETURNING file.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileModelInvocationRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.model_invocations
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.model_invocations invocation
        USING target
        WHERE invocation.id = target.id
        RETURNING invocation.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileEventRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_events
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_events event_row
        USING target
        WHERE event_row.id = target.id
        RETURNING event_row.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileRetryAttemptRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_retry_attempts
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_retry_attempts retry
        USING target
        WHERE retry.id = target.id
        RETURNING retry.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileWorkerJobRows(
  sql: DatabaseClient,
  input: {
    jobId: string;
    knowledgeBaseId: string;
    sourceFileId: string;
    batchSize: number;
  }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.worker_jobs
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
          AND id <> ${input.jobId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.worker_jobs job
        USING target
        WHERE job.id = target.id
        RETURNING job.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteSourceFileRow(
  sql: DatabaseClient,
  input: SourceFilePurgeInput
): Promise<number> {
  const rows = await sql<CountRow[]>`
    WITH removed AS (
      DELETE FROM focowiki.source_files
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND id = ${input.sourceFileId}
      RETURNING id
    )
    SELECT count(*) AS count
    FROM removed
  `;
  return readDeletedCount(rows);
}

async function deleteKnowledgeBaseObjectTracking(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.hard_delete_object_deletions
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.hard_delete_object_deletions object_deletion
        USING target
        WHERE object_deletion.id = target.id
        RETURNING object_deletion.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseKnowledgeGraphInsights(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "knowledge_graph_insights",
    alias: "insight",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseKnowledgeGraphSearchDocuments(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "knowledge_graph_search_documents",
    alias: "document",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseKnowledgeGraphEdges(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "knowledge_graph_edges",
    alias: "edge",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseKnowledgeGraphNodes(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "knowledge_graph_nodes",
    alias: "node",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseKnowledgeTreeEntries(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "knowledge_file_tree_nodes",
    alias: "entry",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseGraphEdges(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "source_file_graph_edges",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseGraphJobs(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "source_file_graph_jobs",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseGraphNodes(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT source_file_id
        FROM focowiki.source_file_graph_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY source_file_id ASC
        LIMIT ${batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_graph_nodes node
        USING target
        WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
          AND node.source_file_id = target.source_file_id
        RETURNING node.source_file_id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBasePublicationJobs(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "publication_jobs",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseModelInvocations(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "model_invocations",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseEvents(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "source_file_events",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseRetryAttempts(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "source_file_retry_attempts",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseBundleFiles(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "bundle_files",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseMarkdownLinks(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT release_id, from_path, to_path, label
        FROM focowiki.release_markdown_links
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY release_id, from_path COLLATE "C", to_path COLLATE "C", label COLLATE "C"
        LIMIT ${batchSize}
      ), removed AS (
        DELETE FROM focowiki.release_markdown_links link
        USING target
        WHERE link.release_id = target.release_id
          AND link.from_path = target.from_path
          AND link.to_path = target.to_path
          AND link.label = target.label
        RETURNING link.release_id
      )
      SELECT count(*) AS count FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseReleases(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "releases",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseWorkerJobs(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "worker_jobs",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseSourceFiles(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput,
  batchSize: number
): Promise<number> {
  return deleteKnowledgeBaseIdRows(sql, {
    table: "source_files",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize
  });
}

async function deleteKnowledgeBaseIdRows(
  sql: DatabaseClient,
  input: {
    table:
      | "source_file_graph_edges"
      | "source_file_graph_jobs"
      | "publication_jobs"
      | "model_invocations"
      | "source_file_events"
      | "source_file_retry_attempts"
      | "bundle_files"
      | "releases"
      | "worker_jobs"
      | "source_files";
    knowledgeBaseId: string;
    batchSize: number;
  }
): Promise<number> {
  if (input.table === "source_file_graph_edges") {
    return deleteKnowledgeBaseGraphEdgeRows(sql, input);
  }
  if (input.table === "source_file_graph_jobs") {
    return deleteKnowledgeBaseGraphJobRows(sql, input);
  }
  if (input.table === "publication_jobs") {
    return deleteKnowledgeBasePublicationJobRows(sql, input);
  }
  if (input.table === "model_invocations") {
    return deleteKnowledgeBaseModelInvocationRows(sql, input);
  }
  if (input.table === "source_file_events") {
    return deleteKnowledgeBaseEventRows(sql, input);
  }
  if (input.table === "source_file_retry_attempts") {
    return deleteKnowledgeBaseRetryAttemptRows(sql, input);
  }
  if (input.table === "bundle_files") {
    return deleteKnowledgeBaseBundleFileRows(sql, input);
  }
  if (input.table === "releases") {
    return deleteKnowledgeBaseReleaseRows(sql, input);
  }
  if (input.table === "worker_jobs") {
    return deleteKnowledgeBaseWorkerJobRows(sql, input);
  }
  return deleteKnowledgeBaseSourceFileRows(sql, input);
}

async function deleteKnowledgeBaseGraphEdgeRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "source_file_graph_edges",
    alias: "edge",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseGraphJobRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "source_file_graph_jobs",
    alias: "job",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBasePublicationJobRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "publication_jobs",
    alias: "job",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseModelInvocationRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "model_invocations",
    alias: "invocation",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseEventRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "source_file_events",
    alias: "event",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseRetryAttemptRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "source_file_retry_attempts",
    alias: "retry",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseBundleFileRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "bundle_files",
    alias: "file",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseReleaseRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "releases",
    alias: "release",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseWorkerJobRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "worker_jobs",
    alias: "job",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseSourceFileRows(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return deleteKnowledgeBaseRowsById(sql, {
    tableName: "source_files",
    alias: "source_file",
    knowledgeBaseId: input.knowledgeBaseId,
    batchSize: input.batchSize
  });
}

async function deleteKnowledgeBaseRowsById(
  sql: DatabaseClient,
  input: {
    tableName:
      | "knowledge_graph_insights"
      | "knowledge_graph_search_documents"
      | "knowledge_graph_edges"
      | "knowledge_graph_nodes"
      | "knowledge_file_tree_nodes"
      | "source_file_graph_edges"
      | "source_file_graph_jobs"
      | "publication_jobs"
      | "model_invocations"
      | "source_file_events"
      | "source_file_retry_attempts"
      | "bundle_files"
      | "releases"
      | "worker_jobs"
      | "source_files";
    alias: string;
    knowledgeBaseId: string;
    batchSize: number;
  }
): Promise<number> {
  if (input.tableName === "knowledge_graph_insights") {
    return deleteKnowledgeBaseKnowledgeGraphInsightRowsById(sql, input);
  }
  if (input.tableName === "knowledge_graph_search_documents") {
    return deleteKnowledgeBaseKnowledgeGraphSearchDocumentRowsById(sql, input);
  }
  if (input.tableName === "knowledge_graph_edges") {
    return deleteKnowledgeBaseKnowledgeGraphEdgeRowsById(sql, input);
  }
  if (input.tableName === "knowledge_graph_nodes") {
    return deleteKnowledgeBaseKnowledgeGraphNodeRowsById(sql, input);
  }
  if (input.tableName === "knowledge_file_tree_nodes") {
    return deleteKnowledgeBaseKnowledgeTreeEntryRowsById(sql, input);
  }
  if (input.tableName === "source_file_graph_edges") {
    return deleteKnowledgeBaseGraphEdgeRowsById(sql, input);
  }
  if (input.tableName === "source_file_graph_jobs") {
    return deleteKnowledgeBaseGraphJobRowsById(sql, input);
  }
  if (input.tableName === "publication_jobs") {
    return deleteKnowledgeBasePublicationJobRowsById(sql, input);
  }
  if (input.tableName === "model_invocations") {
    return deleteKnowledgeBaseModelInvocationRowsById(sql, input);
  }
  if (input.tableName === "source_file_events") {
    return deleteKnowledgeBaseEventRowsById(sql, input);
  }
  if (input.tableName === "source_file_retry_attempts") {
    return deleteKnowledgeBaseRetryAttemptRowsById(sql, input);
  }
  if (input.tableName === "bundle_files") {
    return deleteKnowledgeBaseBundleFileRowsById(sql, input);
  }
  if (input.tableName === "releases") {
    return deleteKnowledgeBaseReleaseRowsById(sql, input);
  }
  if (input.tableName === "worker_jobs") {
    return deleteKnowledgeBaseWorkerJobRowsById(sql, input);
  }
  return deleteKnowledgeBaseSourceFileRowsById(sql, input);
}

async function deleteKnowledgeBaseKnowledgeGraphInsightRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.knowledge_graph_insights
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_insights insight
        USING target
        WHERE insight.id = target.id
        RETURNING insight.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseKnowledgeGraphSearchDocumentRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_search_documents document
        USING target
        WHERE document.id = target.id
        RETURNING document.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseKnowledgeGraphEdgeRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.knowledge_graph_edges
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_edges edge
        USING target
        WHERE edge.id = target.id
        RETURNING edge.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseKnowledgeGraphNodeRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.knowledge_graph_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_graph_nodes node
        USING target
        WHERE node.id = target.id
        RETURNING node.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseKnowledgeTreeEntryRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.knowledge_file_tree_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.knowledge_file_tree_nodes entry
        USING target
        WHERE entry.id = target.id
        RETURNING entry.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseGraphEdgeRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_graph_edges
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_graph_edges edge
        USING target
        WHERE edge.id = target.id
        RETURNING edge.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseGraphJobRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_graph_jobs
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_graph_jobs job
        USING target
        WHERE job.id = target.id
        RETURNING job.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBasePublicationJobRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.publication_jobs
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.publication_jobs job
        USING target
        WHERE job.id = target.id
        RETURNING job.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseModelInvocationRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.model_invocations
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.model_invocations invocation
        USING target
        WHERE invocation.id = target.id
        RETURNING invocation.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseEventRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_events
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_events event_row
        USING target
        WHERE event_row.id = target.id
        RETURNING event_row.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseRetryAttemptRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_file_retry_attempts
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_file_retry_attempts retry
        USING target
        WHERE retry.id = target.id
        RETURNING retry.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseBundleFileRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.bundle_files file
        USING target
        WHERE file.id = target.id
        RETURNING file.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseReleaseRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.releases
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.releases release_row
        USING target
        WHERE release_row.id = target.id
        RETURNING release_row.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseWorkerJobRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.worker_jobs
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.worker_jobs job
        USING target
        WHERE job.id = target.id
        RETURNING job.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseSourceFileRowsById(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; batchSize: number }
): Promise<number> {
  return await deleteUntilEmpty(async () => {
    const rows = await sql<CountRow[]>`
      WITH target AS (
        SELECT id
        FROM focowiki.source_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        ORDER BY id ASC
        LIMIT ${input.batchSize}
      ),
      removed AS (
        DELETE FROM focowiki.source_files source_file
        USING target
        WHERE source_file.id = target.id
        RETURNING source_file.id
      )
      SELECT count(*) AS count
      FROM removed
    `;
    return readDeletedCount(rows);
  });
}

async function deleteKnowledgeBaseWorkerQueueSummaries(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput
): Promise<number> {
  const rows = await sql<CountRow[]>`
    WITH removed AS (
      DELETE FROM focowiki.worker_queue_summaries
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
      RETURNING knowledge_base_id
    )
    SELECT count(*) AS count
    FROM removed
  `;
  return readDeletedCount(rows);
}

async function deleteKnowledgeBaseRow(
  sql: DatabaseClient,
  input: KnowledgeBasePurgeInput
): Promise<number> {
  const rows = await sql<CountRow[]>`
    WITH removed AS (
      DELETE FROM focowiki.knowledge_bases
      WHERE id = ${input.knowledgeBaseId}
      RETURNING id
    )
    SELECT count(*) AS count
    FROM removed
  `;
  return readDeletedCount(rows);
}

async function recordDatabaseProgress(
  sql: DatabaseClient,
  input: {
    jobId: string;
    stageKey: string;
    deletedCount: number;
  }
): Promise<void> {
  await sql`
    UPDATE focowiki.worker_jobs
    SET
      hard_delete_stage = ${input.stageKey},
      hard_delete_cursor_json = ${sql.json({
        deletedCount: input.deletedCount
      } as never)},
      hard_delete_progress_at = now(),
      updated_at = now()
    WHERE id = ${input.jobId}
      AND kind = 'hard_delete'
  `;
}
