import type {
  ProjectionRepairJob,
  ProjectionRepairRepository
} from "../../application/ports/projection-repair-repository.js";
import type { ProjectionRecord } from "../../application/ports/projection-record-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type RepairRow = {
  knowledge_base_id: string;
  repair_version: number;
  base_generation_id: string;
  target_generation_id: string | null;
  state: string;
  checkpoint_json: SerializableJson;
  attempt_count: number;
  lease_token: string | null;
};

type DescriptorRow = {
  id: string;
  name: string;
  description: string | null;
  source_file_count: number;
  graph_edge_count: number;
  root_entry_count: number;
};

type ProjectionRow = {
  knowledge_base_id: string;
  projection_kind: "tree";
  record_id: string;
  last_changed_generation_id: string;
  shard_key: string;
  source_file_id: string | null;
  related_source_file_id: string | null;
  logical_path: string | null;
  parent_path: string | null;
  sort_key: string | null;
  title: string | null;
  summary: string | null;
  searchable_text: string | null;
  payload_json: SerializableJson;
};

export function createPostgresProjectionRepairRepository(
  sql: DatabaseClient
): ProjectionRepairRepository {
  return {
    async bootstrap(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        INSERT INTO focowiki.knowledge_base_projection_repairs (
          knowledge_base_id, repair_version, base_generation_id,
          state, next_attempt_at, created_at, updated_at
        )
        SELECT knowledge_base.id, ${input.repairVersion}, knowledge_base.active_generation_id,
               'pending', ${input.bootstrappedAt}, ${input.bootstrappedAt}, ${input.bootstrappedAt}
        FROM focowiki.knowledge_bases knowledge_base
        JOIN focowiki.publication_generations generation
          ON generation.id = knowledge_base.active_generation_id
         AND generation.knowledge_base_id = knowledge_base.id
         AND generation.state = 'active'
        WHERE knowledge_base.deleted_at IS NULL
        ON CONFLICT (knowledge_base_id, repair_version) DO NOTHING
        RETURNING knowledge_base_id
      `;
      return rows.length;
    },

    async claim(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<RepairRow[]>`
          SELECT repair.*
          FROM focowiki.knowledge_base_projection_repairs repair
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = repair.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
           AND knowledge_base.active_generation_id IS NOT NULL
          WHERE repair.repair_version = ${input.repairVersion}
            AND (
              (repair.state IN ('pending', 'retry') AND repair.next_attempt_at <= ${input.claimedAt})
              OR (
                repair.state = 'running'
                AND (
                  repair.lease_token = ${input.leaseToken}
                  OR repair.lease_expires_at <= ${input.claimedAt}
                )
              )
            )
          ORDER BY repair.next_attempt_at, repair.knowledge_base_id
          LIMIT 1
          FOR UPDATE OF repair SKIP LOCKED
        `;
        const selected = rows[0];
        if (!selected) return null;
        const knowledgeBases = await transaction<Array<{
          active_generation_id: string;
        }>>`
          SELECT active_generation_id
          FROM focowiki.knowledge_bases
          WHERE id = ${selected.knowledge_base_id}
            AND deleted_at IS NULL
            AND active_generation_id IS NOT NULL
          FOR UPDATE
        `;
        const activeGenerationId = knowledgeBases[0]?.active_generation_id;
        if (!activeGenerationId) return null;

        const canResume = selected.state === "running"
          && selected.base_generation_id === activeGenerationId
          && selected.target_generation_id !== null
          && await targetCanResume(transaction, selected.target_generation_id);
        const targetGenerationId = canResume
          ? selected.target_generation_id!
          : input.targetGenerationId;
        if (!canResume) {
          if (selected.target_generation_id) {
            await transaction`
              UPDATE focowiki.publication_generations
              SET state = 'superseded', updated_at = ${input.claimedAt}
              WHERE id = ${selected.target_generation_id}
                AND state IN ('open', 'frozen', 'building', 'validating')
            `;
          }
          await transaction`
            INSERT INTO focowiki.publication_generations (
              id, knowledge_base_id, predecessor_generation_id, state,
              format_version, generation_kind, frozen_at, created_at, updated_at
            ) VALUES (
              ${targetGenerationId}, ${selected.knowledge_base_id}, ${activeGenerationId},
              'building', 2, 'projection_repair', ${input.claimedAt},
              ${input.claimedAt}, ${input.claimedAt}
            )
          `;
        }

        const checkpoint = canResume ? readCheckpoint(selected.checkpoint_json) : emptyCheckpoint();
        const attemptCount = selected.attempt_count + (canResume ? 0 : 1);
        await transaction`
          UPDATE focowiki.knowledge_base_projection_repairs
          SET base_generation_id = ${activeGenerationId},
              target_generation_id = ${targetGenerationId}, state = 'running',
              checkpoint_json = ${transaction.json(checkpoint)},
              lease_token = ${input.leaseToken}, lease_expires_at = ${input.leaseExpiresAt},
              attempt_count = ${attemptCount}, last_error_code = NULL,
              last_error_message = NULL, updated_at = ${input.claimedAt}
          WHERE knowledge_base_id = ${selected.knowledge_base_id}
            AND repair_version = ${input.repairVersion}
        `;
        const descriptors = await transaction<DescriptorRow[]>`
          SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description,
                 (SELECT count(*)::int FROM focowiki.active_object_refs reference
                  WHERE reference.knowledge_base_id = knowledge_base.id
                    AND reference.ref_kind = 'page') AS source_file_count,
                 (SELECT count(*)::int FROM focowiki.active_projection_records record
                  WHERE record.knowledge_base_id = knowledge_base.id
                    AND record.projection_kind = 'graph_edge') AS graph_edge_count,
                 (SELECT count(*)::int FROM focowiki.active_projection_records record
                  WHERE record.knowledge_base_id = knowledge_base.id
                    AND record.projection_kind = 'tree'
                    AND record.parent_path = 'pages'
                    AND record.payload_json->>'kind' IN ('directory', 'file')) AS root_entry_count
          FROM focowiki.knowledge_bases knowledge_base
          WHERE knowledge_base.id = ${selected.knowledge_base_id}
        `;
        const descriptor = descriptors[0];
        if (!descriptor) return null;
        return {
          knowledgeBaseId: selected.knowledge_base_id,
          repairVersion: input.repairVersion,
          baseGenerationId: activeGenerationId,
          targetGenerationId,
          checkpoint,
          attemptCount,
          descriptor: {
            id: descriptor.id,
            name: descriptor.name,
            description: descriptor.description,
            sourceFileCount: Number(descriptor.source_file_count),
            graphEdgeCount: Number(descriptor.graph_edge_count),
            rootEntryCount: Number(descriptor.root_entry_count)
          }
        } satisfies ProjectionRepairJob;
      });
    },

    async listTreePage(input) {
      const rows = await sql<ProjectionRow[]>`
        WITH page AS MATERIALIZED (
          SELECT record.*
          FROM focowiki.active_projection_records record
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = record.knowledge_base_id
           AND knowledge_base.active_generation_id = ${input.job.baseGenerationId}
           AND knowledge_base.deleted_at IS NULL
          WHERE record.knowledge_base_id = ${input.job.knowledgeBaseId}
            AND record.projection_kind = 'tree'
            AND (${input.job.checkpoint.treeCursor}::text IS NULL
                 OR record.record_id > ${input.job.checkpoint.treeCursor})
            AND EXISTS (
              SELECT 1 FROM focowiki.knowledge_base_projection_repairs repair
              WHERE repair.knowledge_base_id = ${input.job.knowledgeBaseId}
                AND repair.repair_version = ${input.job.repairVersion}
                AND repair.target_generation_id = ${input.job.targetGenerationId}
                AND repair.state = 'running'
                AND repair.lease_token = ${input.leaseToken}
                AND repair.lease_expires_at > now()
            )
          ORDER BY record.record_id
          LIMIT ${boundedRepairLimit(input.limit)}
        ),
        directory_page AS MATERIALIZED (
          SELECT record_id, knowledge_base_id, logical_path
          FROM page
          WHERE payload_json->>'kind' = 'directory'
            AND logical_path IS NOT NULL
        ),
        direct_statistics AS (
          SELECT directory.record_id,
                 count(child.record_id) FILTER (
                   WHERE child.payload_json->>'kind' IN ('directory', 'file')
                 )::int AS direct_entry_count,
                 count(child.record_id) FILTER (
                   WHERE child.payload_json->>'kind' = 'directory'
                 )::int AS direct_directory_count,
                 count(child.record_id) FILTER (
                   WHERE child.payload_json->>'kind' = 'file'
                 )::int AS direct_file_count
          FROM directory_page directory
          LEFT JOIN focowiki.active_projection_records child
            ON child.knowledge_base_id = directory.knowledge_base_id
           AND child.projection_kind = 'tree'
           AND child.parent_path = directory.logical_path
          GROUP BY directory.record_id
        ),
        descendant_statistics AS (
          SELECT directory.record_id,
                 count(descendant.record_id) FILTER (
                   WHERE descendant.payload_json->>'kind' = 'file'
                 )::int AS descendant_file_count
          FROM directory_page directory
          LEFT JOIN focowiki.active_projection_records descendant
            ON descendant.knowledge_base_id = directory.knowledge_base_id
           AND descendant.projection_kind = 'tree'
           AND descendant.logical_path >= directory.logical_path || '/'
           AND descendant.logical_path < directory.logical_path || '0'
          GROUP BY directory.record_id
        )
        SELECT page.knowledge_base_id, page.projection_kind, page.record_id,
               page.last_changed_generation_id, page.shard_key, page.source_file_id,
               page.related_source_file_id, page.logical_path, page.parent_path,
               page.sort_key, page.title, page.summary, page.searchable_text,
               CASE WHEN page.payload_json->>'kind' = 'directory' THEN
                 (page.payload_json - 'childCount' - 'directEntryCount'
                    - 'directDirectoryCount' - 'directFileCount' - 'descendantFileCount')
                 || jsonb_build_object(
                   'directEntryCount', coalesce(direct.direct_entry_count, 0),
                   'directDirectoryCount', coalesce(direct.direct_directory_count, 0),
                   'directFileCount', coalesce(direct.direct_file_count, 0),
                   'descendantFileCount', coalesce(descendant.descendant_file_count, 0)
                 )
               ELSE
                 (page.payload_json - 'childCount' - 'directEntryCount'
                    - 'directDirectoryCount' - 'directFileCount' - 'descendantFileCount')
                 || jsonb_build_object(
                   'directEntryCount', 0, 'directDirectoryCount', 0,
                   'directFileCount', 0, 'descendantFileCount', 0
                 )
               END AS payload_json
        FROM page
        LEFT JOIN direct_statistics direct USING (record_id)
        LEFT JOIN descendant_statistics descendant USING (record_id)
        ORDER BY page.record_id
      `;
      return rows.map(mapProjection);
    },

    async advanceTreeCheckpoint(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.knowledge_base_projection_repairs
        SET checkpoint_json = ${sql.json({
          treeCursor: input.treeCursor,
          treeComplete: input.treeComplete
        })}, updated_at = ${input.updatedAt}
        WHERE knowledge_base_id = ${input.job.knowledgeBaseId}
          AND repair_version = ${input.job.repairVersion}
          AND target_generation_id = ${input.job.targetGenerationId}
          AND state = 'running' AND lease_token = ${input.leaseToken}
          AND lease_expires_at > ${input.updatedAt}
        RETURNING knowledge_base_id
      `;
      return rows.length === 1;
    },

    async complete(input) {
      const rows = await sql<Array<{ knowledge_base_id: string }>>`
        UPDATE focowiki.knowledge_base_projection_repairs
        SET state = 'completed', lease_token = NULL, lease_expires_at = NULL,
            completed_at = ${input.completedAt}, updated_at = ${input.completedAt}
        WHERE knowledge_base_id = ${input.job.knowledgeBaseId}
          AND repair_version = ${input.job.repairVersion}
          AND target_generation_id = ${input.job.targetGenerationId}
          AND state = 'running' AND lease_token = ${input.leaseToken}
          AND lease_expires_at > ${input.completedAt}
        RETURNING knowledge_base_id
      `;
      return rows.length === 1;
    },

    async retryFromLatest(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.publication_generations
          SET state = 'superseded', updated_at = ${input.failedAt}
          WHERE id = ${input.job.targetGenerationId}
            AND state IN ('open', 'frozen', 'building', 'validating')
        `;
        const nextState = input.job.attemptCount >= input.maxAttempts ? "failed" : "retry";
        await transaction`
          UPDATE focowiki.knowledge_base_projection_repairs repair
          SET state = ${nextState},
              base_generation_id = knowledge_base.active_generation_id,
              target_generation_id = NULL, checkpoint_json = '{}'::jsonb,
              lease_token = NULL, lease_expires_at = NULL,
              next_attempt_at = ${input.retryAt}, last_error_code = ${input.errorCode},
              last_error_message = NULL, updated_at = ${input.failedAt}
          FROM focowiki.knowledge_bases knowledge_base
          WHERE repair.knowledge_base_id = ${input.job.knowledgeBaseId}
            AND repair.repair_version = ${input.job.repairVersion}
            AND repair.state = 'running'
            AND repair.lease_token = ${input.leaseToken}
            AND knowledge_base.id = repair.knowledge_base_id
            AND knowledge_base.active_generation_id IS NOT NULL
        `;
      });
    }
  };
}

async function targetCanResume(
  sql: TransactionSql,
  generationId: string
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM focowiki.publication_generations
    WHERE id = ${generationId}
      AND generation_kind = 'projection_repair'
      AND state IN ('building', 'validating')
  `;
  return rows.length === 1;
}

function emptyCheckpoint() {
  return { treeCursor: null, treeComplete: false };
}

function readCheckpoint(value: SerializableJson) {
  if (!value || Array.isArray(value) || typeof value !== "object") return emptyCheckpoint();
  const record = value as Record<string, SerializableJson>;
  return {
    treeCursor: typeof record.treeCursor === "string" ? record.treeCursor : null,
    treeComplete: record.treeComplete === true
  };
}

function mapProjection(row: ProjectionRow): ProjectionRecord {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    projectionKind: row.projection_kind,
    recordId: row.record_id,
    lastChangedGenerationId: row.last_changed_generation_id,
    shardKey: row.shard_key,
    sourceFileId: row.source_file_id,
    relatedSourceFileId: row.related_source_file_id,
    logicalPath: row.logical_path,
    parentPath: row.parent_path,
    sortKey: row.sort_key,
    title: row.title,
    summary: row.summary,
    searchableText: row.searchable_text,
    payload: row.payload_json
  };
}

function boundedRepairLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Projection repair limit must be between 1 and 1000");
  }
  return value;
}
