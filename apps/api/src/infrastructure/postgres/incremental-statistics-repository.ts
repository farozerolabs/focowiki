import type {
  IncrementalStatisticsReconciliationClaim,
  IncrementalStatisticsRepository
} from "../../application/ports/incremental-statistics-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ClaimRow = {
  knowledge_base_id: string;
  reconciliation_lease_owner: string;
  reconciliation_lease_token: string;
};

type ReconcileRow = {
  changed: boolean;
  source_file_count: number;
  source_directory_count: number;
  graph_node_count: number;
  graph_edge_count: number;
  active_projection_record_count: number;
  active_generated_object_count: number;
};

export function createPostgresIncrementalStatisticsRepository(
  sql: DatabaseClient
): IncrementalStatisticsRepository {
  return {
    async claimForReconciliation(input) {
      const rows = await sql<ClaimRow[]>`
        WITH candidate AS MATERIALIZED (
          SELECT stats.knowledge_base_id
          FROM focowiki.knowledge_base_incremental_stats stats
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = stats.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          LEFT JOIN focowiki.knowledge_base_optimization_migrations migration
            ON migration.knowledge_base_id = stats.knowledge_base_id
          WHERE (stats.reconciled_at IS NULL OR stats.reconciled_at <= ${input.reconciledBefore})
            AND (
              stats.reconciliation_lease_expires_at IS NULL
              OR stats.reconciliation_lease_expires_at <= ${input.now}
            )
            AND (migration.knowledge_base_id IS NULL OR migration.state = 'optimized_active')
          ORDER BY stats.reconciled_at NULLS FIRST, stats.knowledge_base_id
          LIMIT 1
          FOR UPDATE OF stats SKIP LOCKED
        )
        UPDATE focowiki.knowledge_base_incremental_stats stats
        SET reconciliation_lease_owner = ${input.workerId},
            reconciliation_lease_token = ${input.leaseToken},
            reconciliation_lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        FROM candidate
        WHERE stats.knowledge_base_id = candidate.knowledge_base_id
        RETURNING stats.knowledge_base_id,
                  stats.reconciliation_lease_owner,
                  stats.reconciliation_lease_token
      `;
      return rows[0] ? mapClaim(rows[0]) : null;
    },

    async reconcile(input) {
      return sql.begin(async (transaction) => {
        const owned = await transaction<Array<{
          source_file_count: number;
          source_directory_count: number;
          graph_node_count: number;
          graph_edge_count: number;
          active_projection_record_count: number;
          active_generated_object_count: number;
        }>>`
          SELECT source_file_count, source_directory_count,
                 graph_node_count, graph_edge_count,
                 active_projection_record_count, active_generated_object_count
          FROM focowiki.knowledge_base_incremental_stats
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND reconciliation_lease_owner = ${input.workerId}
            AND reconciliation_lease_token = ${input.leaseToken}
          FOR UPDATE
        `;
        const current = owned[0];
        if (!current) throw new Error("Incremental statistics reconciliation lease is not owned");

        const rows = await transaction<ReconcileRow[]>`
          WITH exact AS MATERIALIZED (
            SELECT
              (SELECT count(*) FROM focowiki.source_files source
               WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                 AND source.deleted_at IS NULL) AS source_file_count,
              (SELECT count(*) FROM focowiki.source_directories directory
               WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
                 AND directory.deleted_at IS NULL) AS source_directory_count,
              (SELECT count(*) FROM focowiki.source_file_graph_nodes node
               WHERE node.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_node_count,
              (SELECT count(*) FROM focowiki.source_file_graph_edges edge
               WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
                 AND edge.status = 'accepted') AS graph_edge_count,
              (SELECT count(*) FROM focowiki.active_projection_records projection
               WHERE projection.knowledge_base_id = ${input.knowledgeBaseId})
                AS active_projection_record_count,
              (SELECT count(*) FROM focowiki.active_object_refs reference
               WHERE reference.knowledge_base_id = ${input.knowledgeBaseId})
                AS active_generated_object_count
          ), sharded AS MATERIALIZED (
            SELECT coalesce(sum(source_file_count), 0)::bigint AS source_file_count,
                   coalesce(sum(source_directory_count), 0)::bigint AS source_directory_count,
                   coalesce(sum(graph_node_count), 0)::bigint AS graph_node_count,
                   coalesce(sum(graph_edge_count), 0)::bigint AS graph_edge_count,
                   coalesce(sum(active_projection_record_count), 0)::bigint
                     AS active_projection_record_count,
                   coalesce(sum(active_generated_object_count), 0)::bigint
                     AS active_generated_object_count
            FROM focowiki.knowledge_base_incremental_stat_shards
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
          ), corrected AS (
            INSERT INTO focowiki.knowledge_base_incremental_stat_shards (
              knowledge_base_id, counter_shard, source_file_count,
              source_directory_count, graph_node_count, graph_edge_count,
              active_projection_record_count, active_generated_object_count,
              stats_revision, updated_at
            )
            SELECT ${input.knowledgeBaseId}, 0,
                   exact.source_file_count - sharded.source_file_count,
                   exact.source_directory_count - sharded.source_directory_count,
                   exact.graph_node_count - sharded.graph_node_count,
                   exact.graph_edge_count - sharded.graph_edge_count,
                   exact.active_projection_record_count
                     - sharded.active_projection_record_count,
                   exact.active_generated_object_count
                     - sharded.active_generated_object_count,
                   1, ${input.reconciledAt}
            FROM exact CROSS JOIN sharded
            ON CONFLICT (knowledge_base_id, counter_shard) DO UPDATE
            SET source_file_count =
                  focowiki.knowledge_base_incremental_stat_shards.source_file_count
                    + EXCLUDED.source_file_count,
                source_directory_count =
                  focowiki.knowledge_base_incremental_stat_shards.source_directory_count
                    + EXCLUDED.source_directory_count,
                graph_node_count =
                  focowiki.knowledge_base_incremental_stat_shards.graph_node_count
                    + EXCLUDED.graph_node_count,
                graph_edge_count =
                  focowiki.knowledge_base_incremental_stat_shards.graph_edge_count
                    + EXCLUDED.graph_edge_count,
                active_projection_record_count =
                  focowiki.knowledge_base_incremental_stat_shards.active_projection_record_count
                    + EXCLUDED.active_projection_record_count,
                active_generated_object_count =
                  focowiki.knowledge_base_incremental_stat_shards.active_generated_object_count
                    + EXCLUDED.active_generated_object_count,
                stats_revision =
                  focowiki.knowledge_base_incremental_stat_shards.stats_revision + 1,
                updated_at = EXCLUDED.updated_at
            RETURNING knowledge_base_id
          )
          SELECT (
                   exact.source_file_count IS DISTINCT FROM sharded.source_file_count
                   OR exact.source_directory_count IS DISTINCT FROM sharded.source_directory_count
                   OR exact.graph_node_count IS DISTINCT FROM sharded.graph_node_count
                   OR exact.graph_edge_count IS DISTINCT FROM sharded.graph_edge_count
                   OR exact.active_projection_record_count
                        IS DISTINCT FROM sharded.active_projection_record_count
                   OR exact.active_generated_object_count
                        IS DISTINCT FROM sharded.active_generated_object_count
                   OR exact.source_file_count IS DISTINCT FROM ${current.source_file_count}
                   OR exact.source_directory_count IS DISTINCT FROM ${current.source_directory_count}
                   OR exact.graph_node_count IS DISTINCT FROM ${current.graph_node_count}
                   OR exact.graph_edge_count IS DISTINCT FROM ${current.graph_edge_count}
                   OR exact.active_projection_record_count
                        IS DISTINCT FROM ${current.active_projection_record_count}
                   OR exact.active_generated_object_count
                        IS DISTINCT FROM ${current.active_generated_object_count}
                 ) AS changed,
                 exact.source_file_count, exact.source_directory_count,
                 exact.graph_node_count, exact.graph_edge_count,
                 exact.active_projection_record_count,
                 exact.active_generated_object_count
          FROM exact CROSS JOIN sharded CROSS JOIN corrected
        `;
        const reconciled = rows[0];
        if (!reconciled) throw new Error("Incremental statistics reconciliation failed");
        await transaction`
          UPDATE focowiki.knowledge_base_incremental_stats
          SET source_file_count = ${reconciled.source_file_count},
              source_directory_count = ${reconciled.source_directory_count},
              graph_node_count = ${reconciled.graph_node_count},
              graph_edge_count = ${reconciled.graph_edge_count},
              active_projection_record_count = ${reconciled.active_projection_record_count},
              active_generated_object_count = ${reconciled.active_generated_object_count},
              stats_revision = stats_revision + 1,
              reconciled_at = ${input.reconciledAt},
              reconciliation_lease_owner = NULL,
              reconciliation_lease_token = NULL,
              reconciliation_lease_expires_at = NULL,
              updated_at = ${input.reconciledAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND reconciliation_lease_owner = ${input.workerId}
            AND reconciliation_lease_token = ${input.leaseToken}
        `;
        return { changed: reconciled.changed };
      });
    },

    async release(input) {
      await sql`
        UPDATE focowiki.knowledge_base_incremental_stats
        SET reconciliation_lease_owner = NULL,
            reconciliation_lease_token = NULL,
            reconciliation_lease_expires_at = NULL,
            updated_at = now()
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND reconciliation_lease_owner = ${input.workerId}
          AND reconciliation_lease_token = ${input.leaseToken}
      `;
    }
  };
}

function mapClaim(row: ClaimRow): IncrementalStatisticsReconciliationClaim {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    workerId: row.reconciliation_lease_owner,
    leaseToken: row.reconciliation_lease_token
  };
}
