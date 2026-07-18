import type {
  CleanupCheckpoint,
  CleanupTarget,
  GenerationCleanupRepository
} from "../../application/ports/generation-cleanup-repository.js";
import type { DatabaseClient } from "../../db/client.js";

export function createPostgresGenerationCleanupRepository(
  sql: DatabaseClient
): GenerationCleanupRepository {
  return {
    async getCheckpoint(jobId) {
      const rows = await sql<Array<{
        phase: CleanupCheckpoint["phase"];
        discovery_cursor: string | null;
        discovery_completed: boolean;
      }>>`
        SELECT phase, discovery_cursor, discovery_completed
        FROM focowiki.cleanup_checkpoints
        WHERE job_id = ${jobId}
        LIMIT 1
      `;
      const row = rows[0];
      return row
        ? {
            phase: row.phase,
            discoveryCursor: row.discovery_cursor,
            discoveryCompleted: row.discovery_completed
          }
        : null;
    },

    async saveCheckpoint(input) {
      await sql`
        INSERT INTO focowiki.cleanup_checkpoints (
          job_id, knowledge_base_id, target_kind, target_id, deletion_intent_id,
          phase, discovery_cursor, discovery_completed, created_at, updated_at
        ) VALUES (
          ${input.jobId}, ${input.target.knowledgeBaseId}, ${input.target.kind},
          ${targetId(input.target)}, ${input.target.deletionIntentId},
          ${input.checkpoint.phase}, ${input.checkpoint.discoveryCursor},
          ${input.checkpoint.discoveryCompleted}, ${input.updatedAt}, ${input.updatedAt}
        )
        ON CONFLICT (job_id) DO UPDATE
        SET phase = EXCLUDED.phase,
            discovery_cursor = EXCLUDED.discovery_cursor,
            discovery_completed = EXCLUDED.discovery_completed,
            updated_at = EXCLUDED.updated_at
      `;
    },

    async isReady(input) {
      if (input.target.kind === "knowledge_base") {
        const rows = await sql<Array<{ ready: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.id = ${input.target.knowledgeBaseId}
              AND knowledge_base.deleted_at IS NOT NULL
          ) AND NOT EXISTS (
            SELECT 1 FROM focowiki.role_jobs job
            WHERE job.knowledge_base_id = ${input.target.knowledgeBaseId}
              AND job.id <> ${input.jobId}
              AND job.status = 'running'
          ) AS ready
        `;
        return rows[0]?.ready ?? false;
      }

      const sourcePredicate = input.target.kind === "source_file"
        ? sql`source.id = ${input.target.sourceFileId}`
        : sql`source.deletion_intent_id = ${input.target.deletionIntentId}`;
      const rows = await sql<Array<{ ready: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM focowiki.deletion_intents intent
          WHERE intent.id = ${input.target.deletionIntentId}
            AND intent.knowledge_base_id = ${input.target.knowledgeBaseId}
            AND intent.state = 'completed'
        ) AND NOT EXISTS (
          SELECT 1
          FROM focowiki.source_files source
          JOIN focowiki.active_object_refs reference
            ON reference.knowledge_base_id = source.knowledge_base_id
           AND reference.source_file_id = source.id
          WHERE source.knowledge_base_id = ${input.target.knowledgeBaseId}
            AND ${sourcePredicate}
        ) AND NOT EXISTS (
          SELECT 1
          FROM focowiki.source_files source
          JOIN focowiki.active_projection_records record
            ON record.knowledge_base_id = source.knowledge_base_id
           AND (record.source_file_id = source.id OR record.related_source_file_id = source.id)
          WHERE source.knowledge_base_id = ${input.target.knowledgeBaseId}
            AND ${sourcePredicate}
        ) AS ready
      `;
      return rows[0]?.ready ?? false;
    },

    async discoverSourceObjectKeys(input) {
      const limit = normalizeLimit(input.limit);
      const sourcePredicate = input.target.kind === "source_file"
        ? sql`source.id = ${input.target.sourceFileId}`
        : sql`source.deletion_intent_id = ${input.target.deletionIntentId}`;
      const rows = await sql<Array<{ object_key: string }>>`
        WITH source_objects AS (
          SELECT source.object_key
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${input.target.knowledgeBaseId}
            AND ${sourcePredicate}
          UNION
          SELECT revision.object_key
          FROM focowiki.source_revisions revision
          JOIN focowiki.source_files source ON source.id = revision.source_file_id
          WHERE source.knowledge_base_id = ${input.target.knowledgeBaseId}
            AND ${sourcePredicate}
        )
        SELECT object_key
        FROM source_objects
        WHERE (${input.cursor}::text IS NULL OR object_key > ${input.cursor})
        ORDER BY object_key
        LIMIT ${limit + 1}
      `;
      const page = rows.slice(0, limit).map((row) => row.object_key);
      return {
        objectKeys: page,
        nextCursor: rows.length > limit ? (page.at(-1) ?? null) : null
      };
    },

    async trackObjectKeys(input) {
      if (input.objectKeys.length === 0) return;
      await sql`
        INSERT INTO focowiki.cleanup_object_deletions (
          job_id, knowledge_base_id, object_key, created_at, updated_at
        )
        SELECT ${input.jobId}, ${input.knowledgeBaseId}, object_key, ${input.createdAt}, ${input.createdAt}
        FROM unnest(${input.objectKeys}::text[]) AS object_key
        ON CONFLICT (job_id, object_key) DO NOTHING
      `;
    },

    async listPendingObjectKeys(input) {
      const rows = await sql<Array<{ object_key: string }>>`
        SELECT object_key
        FROM focowiki.cleanup_object_deletions
        WHERE job_id = ${input.jobId} AND status = 'pending'
        ORDER BY object_key
        LIMIT ${normalizeLimit(input.limit)}
      `;
      return rows.map((row) => row.object_key);
    },

    async markObjectKeysDeleted(input) {
      if (input.objectKeys.length === 0) return;
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.cleanup_object_deletions
          SET status = 'deleted', deleted_at = ${input.deletedAt}, updated_at = ${input.deletedAt}
          WHERE job_id = ${input.jobId} AND object_key = ANY(${input.objectKeys})
        `;
        await transaction`
          DELETE FROM focowiki.immutable_objects object
          WHERE object.object_key = ANY(${input.objectKeys})
            AND object.lifecycle_state = 'deleting'
            AND object.deletion_job_id = ${input.jobId}
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.generation_object_refs reference
              WHERE reference.checksum_sha256 = object.checksum_sha256
                AND reference.format_version = object.format_version
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.active_object_refs reference
              WHERE reference.checksum_sha256 = object.checksum_sha256
                AND reference.format_version = object.format_version
            )
        `;
      });
    },

    async purgeTargetBatch(input) {
      if (input.target.kind === "knowledge_base") {
        return sql.begin(async (transaction) => {
          await transaction`
            INSERT INTO focowiki.cleanup_object_deletions (
              job_id, knowledge_base_id, object_key, created_at, updated_at
            )
            SELECT DISTINCT ${input.jobId}, ${input.target.knowledgeBaseId},
                            object.object_key,
                            ${input.purgedAt}::timestamptz,
                            ${input.purgedAt}::timestamptz
            FROM focowiki.immutable_objects object
            JOIN (
              SELECT reference.checksum_sha256, reference.format_version
              FROM focowiki.active_object_refs reference
              WHERE reference.knowledge_base_id = ${input.target.knowledgeBaseId}
              UNION
              SELECT reference.checksum_sha256, reference.format_version
              FROM focowiki.generation_object_refs reference
              WHERE reference.knowledge_base_id = ${input.target.knowledgeBaseId}
            ) reference
              ON reference.checksum_sha256 = object.checksum_sha256
             AND reference.format_version = object.format_version
            ON CONFLICT (job_id, object_key) DO NOTHING
          `;
          await transaction`
            DELETE FROM focowiki.active_object_refs
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
          `;
          await transaction`
            DELETE FROM focowiki.generation_object_refs
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
          `;
          await transaction`
            UPDATE focowiki.immutable_objects object
            SET lifecycle_state = 'deleting', deletion_job_id = ${input.jobId}
            WHERE object.lifecycle_state = 'active'
              AND EXISTS (
                SELECT 1 FROM focowiki.cleanup_object_deletions candidate
                WHERE candidate.job_id = ${input.jobId}
                  AND candidate.status = 'pending'
                  AND candidate.object_key = object.object_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.generation_object_refs reference
                WHERE reference.checksum_sha256 = object.checksum_sha256
                  AND reference.format_version = object.format_version
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.active_object_refs reference
                WHERE reference.checksum_sha256 = object.checksum_sha256
                  AND reference.format_version = object.format_version
              )
          `;
          await transaction`
            DELETE FROM focowiki.cleanup_object_deletions candidate
            WHERE candidate.job_id = ${input.jobId}
              AND candidate.status = 'pending'
              AND EXISTS (
                SELECT 1 FROM focowiki.immutable_objects object
                WHERE object.object_key = candidate.object_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.immutable_objects object
                WHERE object.object_key = candidate.object_key
                  AND object.lifecycle_state = 'deleting'
                  AND object.deletion_job_id = ${input.jobId}
              )
          `;
          const pending = await transaction<Array<{ count: number }>>`
            SELECT count(*)::int AS count
            FROM focowiki.cleanup_object_deletions
            WHERE job_id = ${input.jobId} AND status = 'pending'
          `;
          const hasMore = (pending[0]?.count ?? 0) > 0;
          const deleted = hasMore
            ? []
            : await transaction<Array<{ id: string }>>`
                DELETE FROM focowiki.knowledge_bases
                WHERE id = ${input.target.knowledgeBaseId} AND deleted_at IS NOT NULL
                RETURNING id
              `;
          return {
            deletedRows: deleted.length,
            hasMore
          };
        });
      }

      const sourceIds = await listCleanupSourceIds(sql, input.target, normalizeLimit(input.limit));
      if (sourceIds.length > 0) {
        await purgeSourceIds(sql, input.target.knowledgeBaseId, sourceIds, input.jobId);
      }
      if (input.target.kind === "source_directory" && sourceIds.length === 0) {
        await sql.begin(async (transaction) => {
          const directories = await transaction<Array<{ id: string }>>`
            SELECT id
            FROM focowiki.source_directories
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
              AND deletion_intent_id = ${input.target.deletionIntentId}
            ORDER BY depth DESC, id
            LIMIT ${normalizeLimit(input.limit)}
            FOR UPDATE
          `;
          const directoryIds = directories.map((directory) => directory.id);
          if (directoryIds.length === 0) return;
          await transaction`
            UPDATE focowiki.upload_session_entries
            SET source_directory_id = NULL, updated_at = ${input.purgedAt}
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
              AND source_directory_id = ANY(${directoryIds})
          `;
          await transaction`
            DELETE FROM focowiki.source_directories
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
              AND id = ANY(${directoryIds})
          `;
        });
      }
      const remaining = await hasCleanupRows(sql, input.target);
      return { deletedRows: sourceIds.length, hasMore: remaining };
    },

    async complete(input) {
      await sql.begin(async (transaction) => {
        if (input.target.kind === "knowledge_base") {
          await transaction`
            DELETE FROM focowiki.cleanup_checkpoints
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
          `;
          await transaction`
            DELETE FROM focowiki.cleanup_object_deletions
            WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
          `;
        } else {
          await transaction`
            DELETE FROM focowiki.cleanup_checkpoints
            WHERE job_id = ${input.jobId}
          `;
          await transaction`
            DELETE FROM focowiki.cleanup_object_deletions WHERE job_id = ${input.jobId}
          `;
        }
        if (input.target.kind !== "knowledge_base") {
          await transaction`
            DELETE FROM focowiki.deletion_intents
            WHERE id = ${input.target.deletionIntentId}
              AND knowledge_base_id = ${input.target.knowledgeBaseId}
              AND state = 'completed'
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.source_files
                WHERE deletion_intent_id = ${input.target.deletionIntentId}
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.source_directories
                WHERE deletion_intent_id = ${input.target.deletionIntentId}
              )
          `;
        }
      });
    },

    async claimUnreferencedImmutableObjects(input) {
      const limit = normalizeLimit(input.limit);
      const rows = await sql.begin(async (transaction) => transaction<Array<{
          checksum_sha256: string;
          format_version: number;
          object_key: string;
          cursor_key: string;
        }>>`
          WITH candidates AS MATERIALIZED (
            SELECT object.checksum_sha256, object.format_version,
                   object.checksum_sha256 || ':' || lpad(object.format_version::text, 10, '0') AS cursor_key
            FROM focowiki.immutable_objects object
            WHERE object.lifecycle_state = 'active'
              AND object.created_at < ${input.olderThan}
              AND (${input.cursor}::text IS NULL OR
                   object.checksum_sha256 || ':' || lpad(object.format_version::text, 10, '0') > ${input.cursor})
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.generation_object_refs reference
                WHERE reference.checksum_sha256 = object.checksum_sha256
                  AND reference.format_version = object.format_version
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.active_object_refs reference
                WHERE reference.checksum_sha256 = object.checksum_sha256
                  AND reference.format_version = object.format_version
              )
            ORDER BY cursor_key
            LIMIT ${limit + 1}
            FOR UPDATE SKIP LOCKED
          ), page AS (
            SELECT * FROM candidates ORDER BY cursor_key LIMIT ${limit}
          )
          UPDATE focowiki.immutable_objects object
          SET lifecycle_state = 'deleting', deletion_job_id = ${input.jobId}
          FROM page
          WHERE object.checksum_sha256 = page.checksum_sha256
            AND object.format_version = page.format_version
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.generation_object_refs reference
              WHERE reference.checksum_sha256 = object.checksum_sha256
                AND reference.format_version = object.format_version
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.active_object_refs reference
              WHERE reference.checksum_sha256 = object.checksum_sha256
                AND reference.format_version = object.format_version
            )
          RETURNING object.checksum_sha256, object.format_version, object.object_key,
                    page.cursor_key
        `);
      const page = rows.slice(0, limit);
      return {
        objects: page.map((row) => ({
          checksumSha256: row.checksum_sha256,
          formatVersion: row.format_version,
          objectKey: row.object_key
        })),
        nextCursor: rows.length > limit ? (page.at(-1)?.cursor_key ?? null) : null
      };
    },

    async completeImmutableObjectDeletions(input) {
      if (input.objects.length === 0) return 0;
      let deleted = 0;
      await sql.begin(async (transaction) => {
        for (const object of input.objects) {
          const rows = await transaction<Array<{ checksum_sha256: string }>>`
            DELETE FROM focowiki.immutable_objects candidate
            WHERE candidate.checksum_sha256 = ${object.checksumSha256}
              AND candidate.format_version = ${object.formatVersion}
              AND candidate.lifecycle_state = 'deleting'
              AND candidate.deletion_job_id = ${input.jobId}
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.generation_object_refs reference
                WHERE reference.checksum_sha256 = candidate.checksum_sha256
                  AND reference.format_version = candidate.format_version
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.active_object_refs reference
                WHERE reference.checksum_sha256 = candidate.checksum_sha256
                  AND reference.format_version = candidate.format_version
              )
            RETURNING checksum_sha256
          `;
          deleted += rows.length;
        }
      });
      return deleted;
    },

    async listClaimedImmutableObjects(input) {
      const rows = await sql<Array<{
        checksum_sha256: string;
        format_version: number;
        object_key: string;
      }>>`
        SELECT checksum_sha256, format_version, object_key
        FROM focowiki.immutable_objects
        WHERE lifecycle_state = 'deleting' AND deletion_job_id = ${input.jobId}
        ORDER BY checksum_sha256, format_version
        LIMIT ${normalizeLimit(input.limit)}
      `;
      return rows.map((row) => ({
        checksumSha256: row.checksum_sha256,
        formatVersion: row.format_version,
        objectKey: row.object_key
      }));
    },

    async deleteExpiredGenerations(input) {
      const rows = await sql<Array<{ id: string }>>`
        DELETE FROM focowiki.publication_generations generation
        WHERE generation.id IN (
          SELECT candidate.id
          FROM focowiki.publication_generations candidate
          WHERE candidate.state IN ('failed', 'superseded')
            AND candidate.updated_at < ${input.olderThan}
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.active_generation_id = candidate.id
            )
          ORDER BY candidate.updated_at, candidate.id
          LIMIT ${normalizeLimit(input.limit)}
        )
        RETURNING generation.id
      `;
      return rows.length;
    }
  };
}

function targetId(target: CleanupTarget): string {
  if (target.kind === "source_file") return target.sourceFileId;
  if (target.kind === "source_directory") return target.sourceDirectoryId;
  return target.knowledgeBaseId;
}

async function listCleanupSourceIds(
  sql: DatabaseClient,
  target: Exclude<CleanupTarget, { kind: "knowledge_base" }>,
  limit: number
): Promise<string[]> {
  const predicate = target.kind === "source_file"
    ? sql`id = ${target.sourceFileId}`
    : sql`deletion_intent_id = ${target.deletionIntentId}`;
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM focowiki.source_files
    WHERE knowledge_base_id = ${target.knowledgeBaseId} AND ${predicate}
    ORDER BY id LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

async function purgeSourceIds(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  sourceIds: string[],
  cleanupJobId: string
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${knowledgeBaseId} AND (from_source_file_id = ANY(${sourceIds}) OR to_source_file_id = ANY(${sourceIds}))`;
    await transaction`DELETE FROM focowiki.source_file_events WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds})`;
    await transaction`DELETE FROM focowiki.source_file_graph_jobs WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds})`;
    await transaction`DELETE FROM focowiki.source_file_graph_nodes WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds})`;
    await transaction`DELETE FROM focowiki.source_file_retry_attempts WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds})`;
    await transaction`DELETE FROM focowiki.model_invocations WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds})`;
    await transaction`DELETE FROM focowiki.source_dispatch_markers WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds})`;
    await transaction`DELETE FROM focowiki.role_jobs WHERE knowledge_base_id = ${knowledgeBaseId} AND source_file_id = ANY(${sourceIds}) AND id <> ${cleanupJobId}`;
    await transaction`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ANY(${sourceIds})`;
  });
}

async function hasCleanupRows(
  sql: DatabaseClient,
  target: Exclude<CleanupTarget, { kind: "knowledge_base" }>
): Promise<boolean> {
  if (target.kind === "source_file") {
    const rows = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM focowiki.source_files WHERE knowledge_base_id = ${target.knowledgeBaseId} AND id = ${target.sourceFileId}) AS exists
    `;
    return rows[0]?.exists ?? false;
  }
  const rows = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM focowiki.source_files WHERE knowledge_base_id = ${target.knowledgeBaseId} AND deletion_intent_id = ${target.deletionIntentId}
      UNION ALL
      SELECT 1 FROM focowiki.source_directories WHERE knowledge_base_id = ${target.knowledgeBaseId} AND deletion_intent_id = ${target.deletionIntentId}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Cleanup limit must be positive");
  return Math.min(value, 1_000);
}
