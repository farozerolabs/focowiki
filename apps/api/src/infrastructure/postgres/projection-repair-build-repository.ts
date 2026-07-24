import type {
  ProjectionRepairBuildRepository
} from "../../application/ports/projection-repair-work-repository.js";
import type { ProjectionRecord } from "../../application/ports/projection-record-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ProjectionRow = {
  knowledge_base_id: string;
  projection_kind: ProjectionRecord["projectionKind"];
  record_id: string;
  generation_id: string;
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

type DirectoryEntryRow = {
  record_id: string;
  sort_key: string;
  logical_path: string;
  title: string | null;
  kind: "file" | "directory";
};

export function createPostgresProjectionRepairBuildRepository(
  sql: DatabaseClient
): ProjectionRepairBuildRepository {
  return {
    async stageTreeBatch(input) {
      const limit = boundedLimit(input.limit);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          record_count: number;
          next_cursor: string | null;
          complete: boolean;
        }>>`
          WITH source_page AS MATERIALIZED (
            SELECT record.*
            FROM focowiki.active_projection_records record
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.id = record.knowledge_base_id
             AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
             AND knowledge_base.deleted_at IS NULL
            WHERE record.knowledge_base_id = ${input.task.knowledgeBaseId}
              AND record.projection_kind = 'tree'
              AND record.shard_key = ${input.task.partitionKey}
              AND (
                ${input.cursor}::text IS NULL
                OR record.record_id > ${input.cursor}
              )
            ORDER BY record.record_id
            LIMIT ${limit + 1}
          ),
          source AS MATERIALIZED (
            SELECT *
            FROM source_page
            ORDER BY record_id
            LIMIT ${limit}
          ),
          directory_source AS MATERIALIZED (
            SELECT source.record_id, source.logical_path
            FROM source
            WHERE source.payload_json->>'kind' = 'directory'
              AND source.logical_path IS NOT NULL
          ),
          direct_counts AS MATERIALIZED (
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
            FROM directory_source directory
            LEFT JOIN focowiki.active_projection_records child
              ON child.knowledge_base_id = ${input.task.knowledgeBaseId}
             AND child.projection_kind = 'tree'
             AND child.parent_path = directory.logical_path
            GROUP BY directory.record_id, directory.logical_path
          ),
          descendant_counts AS MATERIALIZED (
            SELECT directory.record_id,
                   count(descendant.record_id)::int AS descendant_file_count
            FROM directory_source directory
            LEFT JOIN focowiki.active_projection_records descendant
              ON descendant.knowledge_base_id = ${input.task.knowledgeBaseId}
             AND descendant.projection_kind = 'tree'
             AND descendant.payload_json->>'kind' = 'file'
             AND descendant.logical_path >= directory.logical_path || '/'
             AND descendant.logical_path < directory.logical_path || '0'
            GROUP BY directory.record_id
          ),
          statistics AS MATERIALIZED (
            SELECT directory.record_id,
                   coalesce(direct.direct_entry_count, 0) AS direct_entry_count,
                   coalesce(direct.direct_directory_count, 0)
                     AS direct_directory_count,
                   coalesce(direct.direct_file_count, 0) AS direct_file_count,
                   coalesce(descendant.descendant_file_count, 0)
                     AS descendant_file_count
            FROM directory_source directory
            LEFT JOIN direct_counts direct USING (record_id)
            LEFT JOIN descendant_counts descendant USING (record_id)
          ),
          prepared AS MATERIALIZED (
            SELECT source.*,
                   CASE WHEN source.payload_json->>'kind' = 'directory' THEN
                     (source.payload_json - 'childCount' - 'directEntryCount'
                        - 'directDirectoryCount' - 'directFileCount'
                        - 'descendantFileCount')
                     || jsonb_build_object(
                       'directEntryCount', coalesce(statistics.direct_entry_count, 0),
                       'directDirectoryCount', coalesce(statistics.direct_directory_count, 0),
                       'directFileCount', coalesce(statistics.direct_file_count, 0),
                       'descendantFileCount', coalesce(statistics.descendant_file_count, 0)
                     )
                   ELSE
                     (source.payload_json - 'childCount' - 'directEntryCount'
                        - 'directDirectoryCount' - 'directFileCount'
                        - 'descendantFileCount')
                     || jsonb_build_object(
                       'directEntryCount', 0,
                       'directDirectoryCount', 0,
                       'directFileCount', 0,
                       'descendantFileCount', 0
                     )
                   END AS repaired_payload
            FROM source
            LEFT JOIN statistics USING (record_id)
          ),
          upserted AS (
            INSERT INTO focowiki.generation_projection_records (
              generation_id, knowledge_base_id, projection_kind, record_id,
              action, shard_key, source_file_id, related_source_file_id,
              logical_path, parent_path, sort_key, title, summary,
              searchable_text, payload_json
            )
            SELECT ${input.task.targetGenerationId}, prepared.knowledge_base_id,
                   prepared.projection_kind, prepared.record_id, 'upsert',
                   prepared.shard_key, prepared.source_file_id,
                   prepared.related_source_file_id, prepared.logical_path,
                   prepared.parent_path, prepared.sort_key, prepared.title,
                   prepared.summary, prepared.searchable_text,
                   prepared.repaired_payload
            FROM prepared
            ON CONFLICT (generation_id, projection_kind, record_id) DO UPDATE
            SET action = 'upsert', shard_key = EXCLUDED.shard_key,
                source_file_id = EXCLUDED.source_file_id,
                related_source_file_id = EXCLUDED.related_source_file_id,
                logical_path = EXCLUDED.logical_path,
                parent_path = EXCLUDED.parent_path,
                sort_key = EXCLUDED.sort_key, title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                searchable_text = EXCLUDED.searchable_text,
                payload_json = EXCLUDED.payload_json
            RETURNING record_id, logical_path, parent_path, payload_json
          ),
          directory_stats AS (
            INSERT INTO focowiki.generation_tree_directory_stats (
              knowledge_base_id, generation_id, path, parent_path,
              direct_entry_count, direct_directory_count, direct_file_count,
              descendant_file_count, updated_at
            )
            SELECT ${input.task.knowledgeBaseId}, ${input.task.targetGenerationId},
                   upserted.logical_path, coalesce(upserted.parent_path, ''),
                   (upserted.payload_json->>'directEntryCount')::int,
                   (upserted.payload_json->>'directDirectoryCount')::int,
                   (upserted.payload_json->>'directFileCount')::int,
                   (upserted.payload_json->>'descendantFileCount')::int,
                   now()
            FROM upserted
            WHERE upserted.payload_json->>'kind' = 'directory'
              AND upserted.logical_path IS NOT NULL
            ON CONFLICT (generation_id, path) DO UPDATE
            SET parent_path = EXCLUDED.parent_path,
                direct_entry_count = EXCLUDED.direct_entry_count,
                direct_directory_count = EXCLUDED.direct_directory_count,
                direct_file_count = EXCLUDED.direct_file_count,
                descendant_file_count = EXCLUDED.descendant_file_count,
                updated_at = EXCLUDED.updated_at
            RETURNING path
          )
          SELECT count(*)::int AS record_count,
                 max(record_id) AS next_cursor,
                 (SELECT count(*) FROM source_page) <= ${limit} AS complete
          FROM upserted
        `;
        return {
          processedRecordCount: Number(rows[0]?.record_count ?? 0),
          nextCursor: rows[0]?.next_cursor ?? input.cursor,
          complete: rows[0]?.complete ?? true
        };
      });
    },

    async listStagedTreePartition(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<ProjectionRow[]>`
        SELECT knowledge_base_id, projection_kind, record_id,
               generation_id, shard_key, source_file_id,
               related_source_file_id, logical_path, parent_path,
               sort_key, title, summary, searchable_text, payload_json
        FROM focowiki.generation_projection_records
        WHERE generation_id = ${input.task.targetGenerationId}
          AND knowledge_base_id = ${input.task.knowledgeBaseId}
          AND projection_kind = 'tree'
          AND shard_key = ${input.task.partitionKey}
          AND action = 'upsert'
        ORDER BY record_id
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw new Error("Projection repair tree partition exceeds the database batch size");
      }
      return rows.map(mapProjection);
    },

    async stageTreeRebaseBatch(input) {
      const limit = boundedLimit(input.limit);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          record_count: number;
          next_cursor: string | null;
          complete: boolean;
        }>>`
          WITH identities_page AS MATERIALIZED (
            SELECT identity.record_id
            FROM (
              SELECT active.record_id
              FROM focowiki.active_projection_records active
              JOIN focowiki.knowledge_bases knowledge_base
                ON knowledge_base.id = active.knowledge_base_id
               AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
               AND knowledge_base.deleted_at IS NULL
              WHERE active.knowledge_base_id = ${input.task.knowledgeBaseId}
                AND active.projection_kind = 'tree'
                AND active.shard_key = ${input.task.partitionKey}
              UNION
              SELECT candidate.record_id
              FROM focowiki.generation_projection_records candidate
              WHERE candidate.generation_id = ${input.task.targetGenerationId}
                AND candidate.knowledge_base_id = ${input.task.knowledgeBaseId}
                AND candidate.projection_kind = 'tree'
                AND candidate.shard_key = ${input.task.partitionKey}
            ) identity
            WHERE ${input.cursor}::text IS NULL
               OR identity.record_id > ${input.cursor}
            ORDER BY identity.record_id
            LIMIT ${limit + 1}
          ),
          identities AS MATERIALIZED (
            SELECT record_id
            FROM identities_page
            ORDER BY record_id
            LIMIT ${limit}
          ),
          source AS MATERIALIZED (
            SELECT identity.record_id,
                   active.knowledge_base_id,
                   active.projection_kind,
                   active.shard_key,
                   active.source_file_id,
                   active.related_source_file_id,
                   active.logical_path,
                   active.parent_path,
                   active.sort_key,
                   active.title,
                   active.summary,
                   active.searchable_text,
                   active.payload_json,
                   candidate.payload_json AS candidate_payload_json,
                   candidate.shard_key AS candidate_shard_key
            FROM identities identity
            LEFT JOIN focowiki.active_projection_records active
              ON active.knowledge_base_id = ${input.task.knowledgeBaseId}
             AND active.projection_kind = 'tree'
             AND active.record_id = identity.record_id
            LEFT JOIN focowiki.generation_projection_records candidate
              ON candidate.generation_id = ${input.task.targetGenerationId}
             AND candidate.knowledge_base_id = ${input.task.knowledgeBaseId}
             AND candidate.projection_kind = 'tree'
             AND candidate.record_id = identity.record_id
          ),
          directory_source AS MATERIALIZED (
            SELECT source.record_id, source.logical_path
            FROM source
            WHERE source.payload_json->>'kind' = 'directory'
              AND source.logical_path IS NOT NULL
          ),
          direct_counts AS MATERIALIZED (
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
            FROM directory_source directory
            LEFT JOIN focowiki.active_projection_records child
              ON child.knowledge_base_id = ${input.task.knowledgeBaseId}
             AND child.projection_kind = 'tree'
             AND child.parent_path = directory.logical_path
            GROUP BY directory.record_id, directory.logical_path
          ),
          descendant_counts AS MATERIALIZED (
            SELECT directory.record_id,
                   count(descendant.record_id)::int AS descendant_file_count
            FROM directory_source directory
            LEFT JOIN focowiki.active_projection_records descendant
              ON descendant.knowledge_base_id = ${input.task.knowledgeBaseId}
             AND descendant.projection_kind = 'tree'
             AND descendant.payload_json->>'kind' = 'file'
             AND descendant.logical_path >= directory.logical_path || '/'
             AND descendant.logical_path < directory.logical_path || '0'
            GROUP BY directory.record_id
          ),
          statistics AS MATERIALIZED (
            SELECT directory.record_id,
                   coalesce(direct.direct_entry_count, 0) AS direct_entry_count,
                   coalesce(direct.direct_directory_count, 0)
                     AS direct_directory_count,
                   coalesce(direct.direct_file_count, 0) AS direct_file_count,
                   coalesce(descendant.descendant_file_count, 0)
                     AS descendant_file_count
            FROM directory_source directory
            LEFT JOIN direct_counts direct USING (record_id)
            LEFT JOIN descendant_counts descendant USING (record_id)
          ),
          prepared AS MATERIALIZED (
            SELECT source.*,
                   CASE
                     WHEN source.payload_json IS NULL
                       THEN coalesce(source.candidate_payload_json, '{}'::jsonb)
                     WHEN source.payload_json->>'kind' = 'directory' THEN
                       (source.payload_json - 'childCount' - 'directEntryCount'
                          - 'directDirectoryCount' - 'directFileCount'
                          - 'descendantFileCount')
                       || jsonb_build_object(
                         'directEntryCount', coalesce(statistics.direct_entry_count, 0),
                         'directDirectoryCount', coalesce(statistics.direct_directory_count, 0),
                         'directFileCount', coalesce(statistics.direct_file_count, 0),
                         'descendantFileCount', coalesce(statistics.descendant_file_count, 0)
                       )
                     ELSE
                       (source.payload_json - 'childCount' - 'directEntryCount'
                          - 'directDirectoryCount' - 'directFileCount'
                          - 'descendantFileCount')
                       || jsonb_build_object(
                         'directEntryCount', 0,
                         'directDirectoryCount', 0,
                         'directFileCount', 0,
                         'descendantFileCount', 0
                       )
                   END AS repaired_payload
            FROM source
            LEFT JOIN statistics USING (record_id)
          ),
          upserted AS (
            INSERT INTO focowiki.generation_projection_records (
              generation_id, knowledge_base_id, projection_kind, record_id,
              action, shard_key, source_file_id, related_source_file_id,
              logical_path, parent_path, sort_key, title, summary,
              searchable_text, payload_json
            )
            SELECT ${input.task.targetGenerationId}, ${input.task.knowledgeBaseId},
                   'tree', prepared.record_id,
                   CASE WHEN prepared.payload_json IS NULL THEN 'delete' ELSE 'upsert' END,
                   coalesce(prepared.shard_key, prepared.candidate_shard_key),
                   prepared.source_file_id, prepared.related_source_file_id,
                   prepared.logical_path, prepared.parent_path, prepared.sort_key,
                   prepared.title, prepared.summary, prepared.searchable_text,
                   prepared.repaired_payload
            FROM prepared
            ON CONFLICT (generation_id, projection_kind, record_id) DO UPDATE
            SET action = EXCLUDED.action,
                shard_key = EXCLUDED.shard_key,
                source_file_id = EXCLUDED.source_file_id,
                related_source_file_id = EXCLUDED.related_source_file_id,
                logical_path = EXCLUDED.logical_path,
                parent_path = EXCLUDED.parent_path,
                sort_key = EXCLUDED.sort_key,
                title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                searchable_text = EXCLUDED.searchable_text,
                payload_json = EXCLUDED.payload_json
            RETURNING record_id, action, logical_path, parent_path, payload_json
          ),
          removed_stats AS (
            DELETE FROM focowiki.generation_tree_directory_stats statistics
            USING upserted
            WHERE upserted.action = 'delete'
              AND upserted.record_id LIKE 'directory:%'
              AND statistics.generation_id = ${input.task.targetGenerationId}
              AND statistics.path = CASE
                WHEN upserted.record_id = 'directory:' THEN 'pages'
                ELSE 'pages/' || substring(
                  upserted.record_id FROM length('directory:') + 1
                )
              END
          ),
          directory_stats AS (
            INSERT INTO focowiki.generation_tree_directory_stats (
              knowledge_base_id, generation_id, path, parent_path,
              direct_entry_count, direct_directory_count, direct_file_count,
              descendant_file_count, updated_at
            )
            SELECT ${input.task.knowledgeBaseId}, ${input.task.targetGenerationId},
                   upserted.logical_path, coalesce(upserted.parent_path, ''),
                   (upserted.payload_json->>'directEntryCount')::int,
                   (upserted.payload_json->>'directDirectoryCount')::int,
                   (upserted.payload_json->>'directFileCount')::int,
                   (upserted.payload_json->>'descendantFileCount')::int,
                   now()
            FROM upserted
            WHERE upserted.action = 'upsert'
              AND upserted.payload_json->>'kind' = 'directory'
              AND upserted.logical_path IS NOT NULL
            ON CONFLICT (generation_id, path) DO UPDATE
            SET parent_path = EXCLUDED.parent_path,
                direct_entry_count = EXCLUDED.direct_entry_count,
                direct_directory_count = EXCLUDED.direct_directory_count,
                direct_file_count = EXCLUDED.direct_file_count,
                descendant_file_count = EXCLUDED.descendant_file_count,
                updated_at = EXCLUDED.updated_at
          )
          SELECT count(*)::int AS record_count,
                 max(record_id) AS next_cursor,
                 (SELECT count(*) FROM identities_page) <= ${limit} AS complete
          FROM upserted
        `;
        return {
          processedRecordCount: Number(rows[0]?.record_count ?? 0),
          nextCursor: rows[0]?.next_cursor ?? input.cursor,
          complete: rows[0]?.complete ?? true
        };
      });
    },

    async listStagedTreeRebaseChanges(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<Array<ProjectionRow & { action: "upsert" | "delete" }>>`
        SELECT knowledge_base_id, projection_kind, record_id,
               generation_id, action, shard_key, source_file_id,
               related_source_file_id, logical_path, parent_path,
               sort_key, title, summary, searchable_text, payload_json
        FROM focowiki.generation_projection_records
        WHERE generation_id = ${input.task.targetGenerationId}
          AND knowledge_base_id = ${input.task.knowledgeBaseId}
          AND projection_kind = 'tree'
          AND shard_key = ${input.task.partitionKey}
        ORDER BY record_id
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw new Error("Projection repair tree catch-up partition exceeds the supported limit");
      }
      return rows.map((row) => ({
        recordId: row.record_id,
        record: row.action === "delete" ? null : mapProjection(row)
      }));
    },

    async listDirectoryEntryPage(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<DirectoryEntryRow[]>`
        SELECT record.record_id, coalesce(record.sort_key, '') AS sort_key,
               record.logical_path, record.title,
               (record.payload_json->>'kind')::text AS kind
        FROM focowiki.active_projection_records record
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.id = record.knowledge_base_id
         AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
         AND knowledge_base.deleted_at IS NULL
        WHERE record.knowledge_base_id = ${input.task.knowledgeBaseId}
          AND record.projection_kind = 'tree'
          AND record.parent_path = ${input.task.partitionKey}
          AND record.logical_path IS NOT NULL
          AND record.payload_json->>'kind' IN ('directory', 'file')
          AND (
            ${input.cursor?.sortKey ?? null}::text IS NULL
            OR coalesce(record.sort_key, '') COLLATE "C"
               > ${input.cursor?.sortKey ?? null}::text COLLATE "C"
            OR (
              coalesce(record.sort_key, '') COLLATE "C"
                = ${input.cursor?.sortKey ?? null}::text COLLATE "C"
              AND record.record_id COLLATE "C"
                > ${input.cursor?.recordId ?? null}::text COLLATE "C"
            )
          )
        ORDER BY coalesce(record.sort_key, '') COLLATE "C",
                 record.record_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        entries: visible.map((row) => ({
          id: row.record_id,
          sortKey: row.sort_key,
          name: row.title ?? row.logical_path.split("/").at(-1) ?? row.logical_path,
          targetPath: row.kind === "directory"
            ? `${row.logical_path}/index.md`
            : row.logical_path,
          kind: row.kind
        })),
        nextCursor: rows.length > limit && last
          ? { sortKey: last.sort_key, recordId: last.record_id }
          : null
      };
    },

    async directoryExists(input) {
      const rows = await sql<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.active_projection_records record
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = record.knowledge_base_id
           AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
           AND knowledge_base.deleted_at IS NULL
          WHERE record.knowledge_base_id = ${input.task.knowledgeBaseId}
            AND record.projection_kind = 'tree'
            AND record.logical_path = ${input.task.partitionKey}
            AND record.payload_json->>'kind' = 'directory'
        ) AS exists
      `;
      return rows[0]?.exists ?? false;
    },

    async resetDirectorySnapshot(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`${input.task.targetGenerationId}\u001f${input.task.partitionKey}`},
              0
            )
          )
        `;
        await transaction`
          DELETE FROM focowiki.generation_directory_navigation_leaves
          WHERE generation_id = ${input.task.targetGenerationId}
            AND knowledge_base_id = ${input.task.knowledgeBaseId}
            AND directory_path = ${input.task.partitionKey}
        `;
        await transaction`
          DELETE FROM focowiki.generation_directory_navigation_summaries
          WHERE generation_id = ${input.task.targetGenerationId}
            AND knowledge_base_id = ${input.task.knowledgeBaseId}
            AND directory_path = ${input.task.partitionKey}
        `;
        await transaction`
          DELETE FROM focowiki.generation_object_refs
          WHERE generation_id = ${input.task.targetGenerationId}
            AND knowledge_base_id = ${input.task.knowledgeBaseId}
            AND (
              (
                ref_kind = 'directory_root'
                AND ref_key = ${`directory-root:${input.task.partitionKey}`}
              )
              OR (
                ref_kind = 'directory_leaf'
                AND logical_path >= ${`${input.task.partitionKey}/index-`}
                AND logical_path < ${`${input.task.partitionKey}/index.`}
              )
            )
        `;
      });
    },

    async upsertDirectoryLeaf(input) {
      const byteCount = Buffer.byteLength(JSON.stringify(input.leaf.entries), "utf8");
      await sql`
        INSERT INTO focowiki.generation_directory_navigation_leaves (
          generation_id, knowledge_base_id, directory_path, id,
          previous_leaf_id, next_leaf_id, entry_count, byte_count,
          first_sort_key, last_sort_key, entries_json, revision, updated_at
        ) VALUES (
          ${input.task.targetGenerationId}, ${input.task.knowledgeBaseId},
          ${input.task.partitionKey}, ${input.leaf.id},
          ${input.leaf.previousLeafId}, ${input.leaf.nextLeafId},
          ${input.leaf.entries.length}, ${byteCount},
          ${input.leaf.entries.at(0)?.sortKey ?? null},
          ${input.leaf.entries.at(-1)?.sortKey ?? null},
          ${sql.json(input.leaf.entries)}, 1, now()
        )
        ON CONFLICT (generation_id, id) DO UPDATE
        SET previous_leaf_id = EXCLUDED.previous_leaf_id,
            next_leaf_id = EXCLUDED.next_leaf_id,
            entry_count = EXCLUDED.entry_count,
            byte_count = EXCLUDED.byte_count,
            first_sort_key = EXCLUDED.first_sort_key,
            last_sort_key = EXCLUDED.last_sort_key,
            entries_json = EXCLUDED.entries_json,
            revision = EXCLUDED.revision,
            updated_at = EXCLUDED.updated_at
      `;
    },

    async completeDirectorySnapshot(input) {
      await sql`
        INSERT INTO focowiki.generation_directory_navigation_summaries (
          generation_id, knowledge_base_id, directory_path,
          entry_count, first_leaf_id, revision, updated_at
        ) VALUES (
          ${input.task.targetGenerationId}, ${input.task.knowledgeBaseId},
          ${input.task.partitionKey}, ${input.entryCount},
          ${input.firstLeafId}, 1, now()
        )
        ON CONFLICT (generation_id, directory_path) DO UPDATE
        SET entry_count = EXCLUDED.entry_count,
            first_leaf_id = EXCLUDED.first_leaf_id,
            revision = EXCLUDED.revision,
            updated_at = EXCLUDED.updated_at
      `;
    },

    async aggregateGraph(input) {
      const rows = await sql<Array<{ node_count: number; edge_count: number }>>`
        WITH aggregate AS MATERIALIZED (
          SELECT count(*) FILTER (
                   WHERE record.projection_kind = 'graph_node'
                 )::int AS node_count,
                 count(*) FILTER (
                   WHERE record.projection_kind = 'graph_edge'
                 )::int AS edge_count
          FROM focowiki.active_projection_records record
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = record.knowledge_base_id
           AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
           AND knowledge_base.deleted_at IS NULL
          WHERE record.knowledge_base_id = ${input.task.knowledgeBaseId}
            AND record.projection_kind IN ('graph_node', 'graph_edge')
        ),
        written AS (
          INSERT INTO focowiki.generation_graph_summaries (
            knowledge_base_id, generation_id, node_count, edge_count,
            graph_index_available, updated_at
          )
          SELECT ${input.task.knowledgeBaseId}, ${input.task.targetGenerationId},
                 aggregate.node_count, aggregate.edge_count,
                 EXISTS (
                   SELECT 1 FROM focowiki.active_object_refs reference
                   WHERE reference.knowledge_base_id = ${input.task.knowledgeBaseId}
                     AND reference.logical_path = '_graph/index.md'
                 ),
                 ${input.updatedAt}
          FROM aggregate
          ON CONFLICT (generation_id) DO UPDATE
          SET node_count = EXCLUDED.node_count,
              edge_count = EXCLUDED.edge_count,
              graph_index_available = EXCLUDED.graph_index_available,
              updated_at = EXCLUDED.updated_at
          RETURNING node_count, edge_count
        )
        SELECT node_count, edge_count FROM written
      `;
      return {
        nodeCount: Number(rows[0]?.node_count ?? 0),
        edgeCount: Number(rows[0]?.edge_count ?? 0)
      };
    },

    async stageGraphBatch(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<Array<{
        record_count: number;
        next_cursor: string | null;
        complete: boolean;
      }>>`
        WITH source_page AS MATERIALIZED (
          SELECT record.*
          FROM focowiki.active_projection_records record
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = record.knowledge_base_id
           AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
           AND knowledge_base.deleted_at IS NULL
          WHERE record.knowledge_base_id = ${input.task.knowledgeBaseId}
            AND record.projection_kind = ${input.projectionKind}
            AND record.shard_key = ${input.shardKey}
            AND (
              ${input.cursor}::text IS NULL
              OR record.record_id > ${input.cursor}
            )
          ORDER BY record.record_id
          LIMIT ${limit + 1}
        ),
        source AS MATERIALIZED (
          SELECT *
          FROM source_page
          ORDER BY record_id
          LIMIT ${limit}
        ),
        upserted AS (
          INSERT INTO focowiki.generation_projection_records (
            generation_id, knowledge_base_id, projection_kind, record_id,
            action, shard_key, source_file_id, related_source_file_id,
            logical_path, parent_path, sort_key, title, summary,
            searchable_text, payload_json
          )
          SELECT ${input.task.targetGenerationId}, source.knowledge_base_id,
                 source.projection_kind, source.record_id, 'upsert',
                 source.shard_key, source.source_file_id,
                 source.related_source_file_id, source.logical_path,
                 source.parent_path, source.sort_key, source.title,
                 source.summary, source.searchable_text, source.payload_json
          FROM source
          ON CONFLICT (generation_id, projection_kind, record_id) DO UPDATE
          SET action = 'upsert',
              shard_key = EXCLUDED.shard_key,
              source_file_id = EXCLUDED.source_file_id,
              related_source_file_id = EXCLUDED.related_source_file_id,
              logical_path = EXCLUDED.logical_path,
              parent_path = EXCLUDED.parent_path,
              sort_key = EXCLUDED.sort_key,
              title = EXCLUDED.title,
              summary = EXCLUDED.summary,
              searchable_text = EXCLUDED.searchable_text,
              payload_json = EXCLUDED.payload_json
          RETURNING record_id
        )
        SELECT count(*)::int AS record_count,
               max(record_id) AS next_cursor,
               (SELECT count(*) FROM source_page) <= ${limit} AS complete
        FROM upserted
      `;
      return {
        processedRecordCount: Number(rows[0]?.record_count ?? 0),
        nextCursor: rows[0]?.next_cursor ?? input.cursor,
        complete: rows[0]?.complete ?? true
      };
    },

    async listStagedGraphPartition(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<ProjectionRow[]>`
        SELECT knowledge_base_id, projection_kind, record_id,
               generation_id, shard_key, source_file_id,
               related_source_file_id, logical_path, parent_path,
               sort_key, title, summary, searchable_text, payload_json
        FROM focowiki.generation_projection_records
        WHERE generation_id = ${input.task.targetGenerationId}
          AND knowledge_base_id = ${input.task.knowledgeBaseId}
          AND projection_kind = ${input.projectionKind}
          AND shard_key = ${input.shardKey}
          AND action = 'upsert'
        ORDER BY record_id
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw new Error("Projection repair graph partition exceeds the supported shard limit");
      }
      return rows.map(mapProjection);
    },

    async stageGraphRebaseBatch(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<Array<{
        record_count: number;
        next_cursor: string | null;
        complete: boolean;
      }>>`
        WITH identities_page AS MATERIALIZED (
          SELECT identity.record_id
          FROM (
            SELECT active.record_id
            FROM focowiki.active_projection_records active
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.id = active.knowledge_base_id
             AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
             AND knowledge_base.deleted_at IS NULL
            WHERE active.knowledge_base_id = ${input.task.knowledgeBaseId}
              AND active.projection_kind = ${input.projectionKind}
              AND active.shard_key = ${input.shardKey}
            UNION
            SELECT candidate.record_id
            FROM focowiki.generation_projection_records candidate
            WHERE candidate.generation_id = ${input.task.targetGenerationId}
              AND candidate.knowledge_base_id = ${input.task.knowledgeBaseId}
              AND candidate.projection_kind = ${input.projectionKind}
              AND candidate.shard_key = ${input.shardKey}
          ) identity
          WHERE ${input.cursor}::text IS NULL
             OR identity.record_id > ${input.cursor}
          ORDER BY identity.record_id
          LIMIT ${limit + 1}
        ),
        identities AS MATERIALIZED (
          SELECT record_id
          FROM identities_page
          ORDER BY record_id
          LIMIT ${limit}
        ),
        prepared AS MATERIALIZED (
          SELECT identity.record_id,
                 active.knowledge_base_id,
                 active.projection_kind,
                 active.shard_key,
                 active.source_file_id,
                 active.related_source_file_id,
                 active.logical_path,
                 active.parent_path,
                 active.sort_key,
                 active.title,
                 active.summary,
                 active.searchable_text,
                 active.payload_json,
                 candidate.payload_json AS candidate_payload_json,
                 candidate.shard_key AS candidate_shard_key
          FROM identities identity
          LEFT JOIN focowiki.active_projection_records active
            ON active.knowledge_base_id = ${input.task.knowledgeBaseId}
           AND active.projection_kind = ${input.projectionKind}
           AND active.record_id = identity.record_id
          LEFT JOIN focowiki.generation_projection_records candidate
            ON candidate.generation_id = ${input.task.targetGenerationId}
           AND candidate.knowledge_base_id = ${input.task.knowledgeBaseId}
           AND candidate.projection_kind = ${input.projectionKind}
           AND candidate.record_id = identity.record_id
        ),
        upserted AS (
          INSERT INTO focowiki.generation_projection_records (
            generation_id, knowledge_base_id, projection_kind, record_id,
            action, shard_key, source_file_id, related_source_file_id,
            logical_path, parent_path, sort_key, title, summary,
            searchable_text, payload_json
          )
          SELECT ${input.task.targetGenerationId}, ${input.task.knowledgeBaseId},
                 ${input.projectionKind}, prepared.record_id,
                 CASE WHEN prepared.payload_json IS NULL THEN 'delete' ELSE 'upsert' END,
                 coalesce(prepared.shard_key, prepared.candidate_shard_key),
                 prepared.source_file_id, prepared.related_source_file_id,
                 prepared.logical_path, prepared.parent_path, prepared.sort_key,
                 prepared.title, prepared.summary, prepared.searchable_text,
                 coalesce(prepared.payload_json, prepared.candidate_payload_json, '{}'::jsonb)
          FROM prepared
          ON CONFLICT (generation_id, projection_kind, record_id) DO UPDATE
          SET action = EXCLUDED.action,
              shard_key = EXCLUDED.shard_key,
              source_file_id = EXCLUDED.source_file_id,
              related_source_file_id = EXCLUDED.related_source_file_id,
              logical_path = EXCLUDED.logical_path,
              parent_path = EXCLUDED.parent_path,
              sort_key = EXCLUDED.sort_key,
              title = EXCLUDED.title,
              summary = EXCLUDED.summary,
              searchable_text = EXCLUDED.searchable_text,
              payload_json = EXCLUDED.payload_json
          RETURNING record_id
        )
        SELECT count(*)::int AS record_count,
               max(record_id) AS next_cursor,
               (SELECT count(*) FROM identities_page) <= ${limit} AS complete
        FROM upserted
      `;
      return {
        processedRecordCount: Number(rows[0]?.record_count ?? 0),
        nextCursor: rows[0]?.next_cursor ?? input.cursor,
        complete: rows[0]?.complete ?? true
      };
    },

    async listStagedGraphRebaseChanges(input) {
      const limit = boundedLimit(input.limit);
      const rows = await sql<Array<ProjectionRow & { action: "upsert" | "delete" }>>`
        SELECT knowledge_base_id, projection_kind, record_id,
               generation_id, action, shard_key, source_file_id,
               related_source_file_id, logical_path, parent_path,
               sort_key, title, summary, searchable_text, payload_json
        FROM focowiki.generation_projection_records
        WHERE generation_id = ${input.task.targetGenerationId}
          AND knowledge_base_id = ${input.task.knowledgeBaseId}
          AND projection_kind = ${input.projectionKind}
          AND shard_key = ${input.shardKey}
        ORDER BY record_id
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw new Error("Projection repair graph catch-up partition exceeds the supported limit");
      }
      return rows.map((row) => ({
        recordId: row.record_id,
        record: row.action === "delete" ? null : mapProjection(row)
      }));
    },

    async inheritSearchProjectionReferences(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.generation_search_projection_refs
          WHERE knowledge_base_id = ${input.task.knowledgeBaseId}
            AND generation_id = ${input.task.targetGenerationId}
        `;
        const rows = await transaction<Array<{ source_file_id: string }>>`
          INSERT INTO focowiki.generation_search_projection_refs (
            knowledge_base_id, generation_id, source_file_id, source_revision_id,
            search_document_id, search_schema_version, tokenizer_contract_version,
            segmentation_version, logical_path, title, summary, source_url,
            metadata_json, created_at, updated_at
          )
          SELECT reference.knowledge_base_id, ${input.task.targetGenerationId},
                 reference.source_file_id, reference.source_revision_id,
                 reference.search_document_id, reference.search_schema_version,
                 reference.tokenizer_contract_version,
                 reference.segmentation_version, reference.logical_path,
                 reference.title, reference.summary, reference.source_url,
                 reference.metadata_json, now(), now()
          FROM focowiki.generation_search_projection_refs reference
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = reference.knowledge_base_id
           AND knowledge_base.active_generation_id = ${input.task.baseGenerationId}
           AND knowledge_base.deleted_at IS NULL
          WHERE reference.knowledge_base_id = ${input.task.knowledgeBaseId}
            AND reference.generation_id = ${input.task.baseGenerationId}
          RETURNING source_file_id
        `;
        return rows.length;
      });
    },

    async readRepairDescriptor(input) {
      const rows = await sql<Array<{
        id: string;
        name: string;
        description: string | null;
        active_generation_id: string;
        resource_revision: number;
        source_file_count: number;
        graph_edge_count: number;
        root_entry_count: number;
      }>>`
        SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description,
               knowledge_base.active_generation_id,
               knowledge_base.resource_revision,
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
                  AND record.payload_json->>'kind' IN ('directory', 'file'))
                 AS root_entry_count
        FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.id = ${input.task.knowledgeBaseId}
          AND knowledge_base.deleted_at IS NULL
          AND knowledge_base.active_generation_id IS NOT NULL
      `;
      const row = rows[0];
      return row
        ? {
            id: row.id,
            name: row.name,
            description: row.description,
            sourceFileCount: Number(row.source_file_count),
            graphEdgeCount: Number(row.graph_edge_count),
            rootEntryCount: Number(row.root_entry_count),
            activeGenerationId: row.active_generation_id,
            resourceRevision: row.resource_revision
          }
        : null;
    }
  };
}

function mapProjection(row: ProjectionRow): ProjectionRecord {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    projectionKind: row.projection_kind,
    recordId: row.record_id,
    lastChangedGenerationId: row.generation_id,
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

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Projection repair database batch size must be between 1 and 10000");
  }
  return value;
}
