import type { PublicationValidationRepository } from "../../application/ports/publication-validation-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { REQUIRED_GENERATED_NAVIGATION_RESOURCES } from "../../okf/generated-graph-resources.js";

export function createPostgresPublicationValidationRepository(
  sql: DatabaseClient
): PublicationValidationRepository {
  return {
    async validateChangedClosure(input) {
      if (!Number.isSafeInteger(input.issueLimit) || input.issueLimit <= 0) {
        throw new Error("issueLimit must be a positive integer");
      }
      return sql<Array<{ code: string; message: string; reference: string | null }>>`
        WITH candidate_generation AS MATERIALIZED (
          SELECT predecessor_generation_id, generation_kind
          FROM focowiki.publication_generations
          WHERE id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        ),
        generation_lineage AS MATERIALIZED (
          WITH RECURSIVE lineage(generation_id, predecessor_generation_id, depth) AS (
            SELECT id, predecessor_generation_id, 0
            FROM focowiki.publication_generations
            WHERE id = ${input.generationId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
            UNION ALL
            SELECT generation.id, generation.predecessor_generation_id,
                   lineage.depth + 1
            FROM lineage
            JOIN focowiki.publication_generations generation
              ON generation.id = lineage.predecessor_generation_id
             AND generation.knowledge_base_id = ${input.knowledgeBaseId}
          )
          SELECT generation_id, depth FROM lineage
        ),
        candidate_projection_targets AS MATERIALIZED (
          SELECT DISTINCT projection_kind, record_id
          FROM focowiki.generation_projection_records
          WHERE generation_id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND projection_kind IN ('tree', 'graph_node', 'graph_edge')
        ),
        predecessor_projection_candidates AS MATERIALIZED (
          SELECT record.projection_kind, record.record_id, record.action,
                 record.logical_path, record.parent_path, record.payload_json,
                 lineage.depth, 0 AS source_priority
          FROM generation_lineage lineage
          JOIN focowiki.generation_projection_records record
            ON record.generation_id = lineage.generation_id
           AND record.knowledge_base_id = ${input.knowledgeBaseId}
          JOIN candidate_projection_targets target
            ON target.projection_kind = record.projection_kind
           AND target.record_id = record.record_id
          WHERE lineage.depth > 0
          UNION ALL
          SELECT active.projection_kind, active.record_id, 'upsert',
                 active.logical_path, active.parent_path, active.payload_json,
                 lineage.depth, 1
          FROM generation_lineage lineage
          JOIN focowiki.active_projection_records active
            ON active.last_changed_generation_id = lineage.generation_id
           AND active.knowledge_base_id = ${input.knowledgeBaseId}
          JOIN candidate_projection_targets target
            ON target.projection_kind = active.projection_kind
           AND target.record_id = active.record_id
          WHERE lineage.depth > 0
        ),
        predecessor_projection_records AS MATERIALIZED (
          SELECT DISTINCT ON (projection_kind, record_id)
                 projection_kind, record_id, action,
                 logical_path, parent_path, payload_json
          FROM predecessor_projection_candidates
          ORDER BY projection_kind, record_id, depth, source_priority
        ),
        predecessor_object_ref_candidates AS MATERIALIZED (
          SELECT reference.ref_kind, reference.ref_key, reference.action,
                 reference.logical_path, lineage.depth, 0 AS source_priority
          FROM generation_lineage lineage
          JOIN focowiki.generation_object_refs reference
            ON reference.generation_id = lineage.generation_id
           AND reference.knowledge_base_id = ${input.knowledgeBaseId}
          WHERE lineage.depth > 0
            AND reference.logical_path = ANY(
              ${REQUIRED_GENERATED_NAVIGATION_RESOURCES.map((resource) => resource.path)}::text[]
            )
          UNION ALL
          SELECT active.ref_kind, active.ref_key, 'upsert', active.logical_path,
                 lineage.depth, 1
          FROM generation_lineage lineage
          JOIN focowiki.active_object_refs active
            ON active.last_changed_generation_id = lineage.generation_id
           AND active.knowledge_base_id = ${input.knowledgeBaseId}
          WHERE lineage.depth > 0
            AND active.logical_path = ANY(
              ${REQUIRED_GENERATED_NAVIGATION_RESOURCES.map((resource) => resource.path)}::text[]
            )
        ),
        predecessor_object_refs AS MATERIALIZED (
          SELECT DISTINCT ON (ref_kind, ref_key)
                 ref_kind, ref_key, action, logical_path
          FROM predecessor_object_ref_candidates
          ORDER BY ref_kind, ref_key, depth, source_priority
        ),
        changed_tree AS MATERIALIZED (
          SELECT candidate.record_id, candidate.action,
                 candidate.logical_path AS next_path,
                 candidate.parent_path AS next_parent_path,
                 candidate.payload_json->>'kind' AS next_kind,
                 previous.logical_path AS previous_path,
                 previous.parent_path AS previous_parent_path,
                 previous.payload_json->>'kind' AS previous_kind
          FROM focowiki.generation_projection_records candidate
          LEFT JOIN predecessor_projection_records previous
            ON previous.projection_kind = candidate.projection_kind
           AND previous.record_id = candidate.record_id
           AND previous.action = 'upsert'
          WHERE candidate.generation_id = ${input.generationId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.projection_kind = 'tree'
        ),
        changed_directory_paths AS MATERIALIZED (
          SELECT next_path AS path
          FROM changed_tree
          WHERE action = 'upsert' AND next_kind = 'directory'
            AND next_path IS NOT NULL
          UNION
          SELECT next_parent_path
          FROM changed_tree
          WHERE action = 'upsert' AND next_parent_path IS NOT NULL
            AND next_parent_path <> ''
          UNION
          SELECT previous_parent_path
          FROM changed_tree
          WHERE previous_parent_path IS NOT NULL AND previous_parent_path <> ''
          UNION
          SELECT directory_path
          FROM focowiki.generation_directory_navigation_changes
          WHERE generation_id = ${input.generationId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        ),
        predecessor_directory_candidates AS MATERIALIZED (
          SELECT changed.path, record.record_id, record.action,
                 record.logical_path, record.payload_json,
                 lineage.depth, 0 AS source_priority
          FROM changed_directory_paths changed
          JOIN generation_lineage lineage
            ON lineage.depth > 0
          JOIN focowiki.generation_projection_records record
            ON record.generation_id = lineage.generation_id
           AND record.knowledge_base_id = ${input.knowledgeBaseId}
           AND record.projection_kind = 'tree'
           AND record.record_id = CASE
             WHEN changed.path = 'pages' THEN 'directory:'
             ELSE 'directory:' || substring(
               changed.path FROM length('pages/') + 1
             )
           END
          UNION ALL
          SELECT changed.path, active.record_id, 'upsert',
                 active.logical_path, active.payload_json,
                 lineage.depth, 1
          FROM changed_directory_paths changed
          JOIN generation_lineage lineage
            ON lineage.depth > 0
          JOIN focowiki.active_projection_records active
            ON active.last_changed_generation_id = lineage.generation_id
           AND active.knowledge_base_id = ${input.knowledgeBaseId}
           AND active.projection_kind = 'tree'
           AND active.record_id = CASE
             WHEN changed.path = 'pages' THEN 'directory:'
             ELSE 'directory:' || substring(
               changed.path FROM length('pages/') + 1
             )
           END
        ),
        predecessor_directory_records AS MATERIALIZED (
          SELECT DISTINCT ON (path)
                 path, record_id, action, logical_path, payload_json
          FROM predecessor_directory_candidates
          ORDER BY path, depth, source_priority
        ),
        visible_changed_directories AS MATERIALIZED (
          SELECT changed.path
          FROM changed_directory_paths changed
          WHERE changed.path = 'pages'
             OR EXISTS (
               SELECT 1 FROM changed_tree candidate
               WHERE candidate.action = 'upsert'
                 AND candidate.next_kind = 'directory'
                 AND candidate.next_path = changed.path
             )
             OR EXISTS (
               SELECT 1
               FROM predecessor_directory_records previous
               WHERE previous.path = changed.path
                 AND previous.action = 'upsert'
                 AND previous.logical_path = changed.path
                 AND previous.payload_json->>'kind' = 'directory'
                 AND NOT EXISTS (
                   SELECT 1 FROM changed_tree candidate
                   WHERE candidate.record_id = previous.record_id
                     AND (
                       candidate.action = 'delete'
                       OR candidate.next_kind <> 'directory'
                       OR candidate.next_path IS DISTINCT FROM previous.logical_path
                     )
                 )
             )
        ),
        effective_navigation AS MATERIALIZED (
          SELECT DISTINCT ON (summary.directory_path)
                 summary.generation_id AS owner_generation_id,
                 summary.directory_path, summary.entry_count, summary.first_leaf_id
          FROM generation_lineage lineage
          JOIN focowiki.generation_directory_navigation_summaries summary
            ON summary.generation_id = lineage.generation_id
           AND summary.knowledge_base_id = ${input.knowledgeBaseId}
          WHERE summary.directory_path IN (
             SELECT path FROM visible_changed_directories
           )
          ORDER BY summary.directory_path, lineage.depth
        ),
        effective_tree_statistics AS MATERIALIZED (
          SELECT statistics.path, statistics.direct_entry_count,
                 statistics.direct_directory_count, statistics.direct_file_count,
                 statistics.descendant_file_count
          FROM focowiki.generation_tree_directory_stats statistics
          WHERE statistics.generation_id = ${input.generationId}
            AND statistics.knowledge_base_id = ${input.knowledgeBaseId}
            AND statistics.path IN (
              SELECT path FROM visible_changed_directories
            )
          UNION ALL
          SELECT predecessor.path, predecessor.direct_entry_count,
                 predecessor.direct_directory_count, predecessor.direct_file_count,
                 predecessor.descendant_file_count
          FROM candidate_generation generation
          JOIN focowiki.generation_tree_directory_stats predecessor
            ON predecessor.generation_id = generation.predecessor_generation_id
           AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
           AND predecessor.path IN (
             SELECT path FROM visible_changed_directories
           )
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.generation_tree_directory_stats candidate
            WHERE candidate.generation_id = ${input.generationId}
              AND candidate.path = predecessor.path
          )
        ),
        expected_tree_statistics AS MATERIALIZED (
          SELECT directory.path,
                 CASE WHEN generation.generation_kind = 'projection_repair'
                   THEN coalesce(sum(CASE
                     WHEN tree.action = 'upsert' AND tree.next_kind = 'directory'
                      AND tree.next_parent_path = directory.path THEN 1 ELSE 0
                   END), 0)
                   ELSE coalesce(predecessor.direct_directory_count, 0)
                     + coalesce(sum(
                       CASE WHEN tree.previous_kind = 'directory'
                                  AND tree.previous_parent_path = directory.path
                         THEN -1 ELSE 0 END
                       + CASE WHEN tree.action = 'upsert' AND tree.next_kind = 'directory'
                                  AND tree.next_parent_path = directory.path
                         THEN 1 ELSE 0 END
                     ), 0)
                 END AS direct_directory_count,
                 CASE WHEN generation.generation_kind = 'projection_repair'
                   THEN coalesce(sum(CASE
                     WHEN tree.action = 'upsert' AND tree.next_kind = 'file'
                      AND tree.next_parent_path = directory.path THEN 1 ELSE 0
                   END), 0)
                   ELSE coalesce(predecessor.direct_file_count, 0)
                     + coalesce(sum(
                       CASE WHEN tree.previous_kind = 'file'
                                  AND tree.previous_parent_path = directory.path
                         THEN -1 ELSE 0 END
                       + CASE WHEN tree.action = 'upsert' AND tree.next_kind = 'file'
                                  AND tree.next_parent_path = directory.path
                         THEN 1 ELSE 0 END
                     ), 0)
                 END AS direct_file_count,
                 CASE WHEN generation.generation_kind = 'projection_repair'
                   THEN coalesce(sum(CASE
                     WHEN tree.action = 'upsert' AND tree.next_kind = 'file'
                      AND left(tree.next_path, length(directory.path) + 1)
                        = directory.path || '/' THEN 1 ELSE 0
                   END), 0)
                   ELSE coalesce(predecessor.descendant_file_count, 0)
                     + coalesce(sum(
                       CASE WHEN tree.previous_kind = 'file'
                                  AND left(tree.previous_path, length(directory.path) + 1)
                                    = directory.path || '/'
                         THEN -1 ELSE 0 END
                       + CASE WHEN tree.action = 'upsert' AND tree.next_kind = 'file'
                                  AND left(tree.next_path, length(directory.path) + 1)
                                    = directory.path || '/'
                         THEN 1 ELSE 0 END
                     ), 0)
                 END AS descendant_file_count
          FROM visible_changed_directories directory
          CROSS JOIN candidate_generation generation
          LEFT JOIN focowiki.generation_tree_directory_stats predecessor
            ON predecessor.generation_id = generation.predecessor_generation_id
           AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
           AND predecessor.path = directory.path
          LEFT JOIN changed_tree tree ON true
          GROUP BY directory.path, generation.generation_kind,
                   predecessor.direct_directory_count,
                   predecessor.direct_file_count, predecessor.descendant_file_count
        ),
        graph_delta AS MATERIALIZED (
          SELECT candidate.projection_kind,
                 coalesce(sum(CASE
                   WHEN candidate.action = 'upsert' AND previous.record_id IS NULL THEN 1
                   WHEN candidate.action = 'delete' AND previous.record_id IS NOT NULL THEN -1
                   ELSE 0
                 END), 0) AS count_delta
          FROM focowiki.generation_projection_records candidate
          LEFT JOIN predecessor_projection_records previous
            ON previous.projection_kind = candidate.projection_kind
           AND previous.record_id = candidate.record_id
           AND previous.action = 'upsert'
          WHERE candidate.generation_id = ${input.generationId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.projection_kind IN ('graph_node', 'graph_edge')
          GROUP BY candidate.projection_kind
        ),
        repair_graph_expectation AS MATERIALIZED (
          SELECT CASE
                   WHEN 'graph' = ANY(repair.required_projection_kinds)
                     THEN (
                       SELECT count(*)
                       FROM focowiki.generation_projection_records candidate
                       WHERE candidate.generation_id = ${input.generationId}
                         AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
                         AND candidate.projection_kind = 'graph_node'
                         AND candidate.action = 'upsert'
                     )
                   ELSE predecessor.node_count
                 END AS node_count,
                 CASE
                   WHEN 'graph' = ANY(repair.required_projection_kinds)
                     THEN (
                       SELECT count(*)
                       FROM focowiki.generation_projection_records candidate
                       WHERE candidate.generation_id = ${input.generationId}
                         AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
                         AND candidate.projection_kind = 'graph_edge'
                         AND candidate.action = 'upsert'
                     )
                   ELSE predecessor.edge_count
                 END AS edge_count
          FROM focowiki.knowledge_base_projection_repairs repair
          JOIN candidate_generation generation
            ON generation.generation_kind = 'projection_repair'
          LEFT JOIN focowiki.generation_graph_summaries predecessor
            ON predecessor.generation_id = generation.predecessor_generation_id
           AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
          WHERE repair.knowledge_base_id = ${input.knowledgeBaseId}
            AND repair.target_generation_id = ${input.generationId}
            AND repair.state = 'running'
          ORDER BY repair.repair_version DESC
          LIMIT 1
        ),
        expected_graph_summary AS MATERIALIZED (
          SELECT CASE WHEN generation.generation_kind = 'projection_repair'
                   THEN repair.node_count
                   ELSE coalesce(predecessor.node_count, 0)
                     + coalesce((SELECT count_delta FROM graph_delta
                                 WHERE projection_kind = 'graph_node'), 0)
                 END AS node_count,
                 CASE WHEN generation.generation_kind = 'projection_repair'
                   THEN repair.edge_count
                   ELSE coalesce(predecessor.edge_count, 0)
                     + coalesce((SELECT count_delta FROM graph_delta
                                 WHERE projection_kind = 'graph_edge'), 0)
                 END AS edge_count
          FROM candidate_generation generation
          LEFT JOIN focowiki.generation_graph_summaries predecessor
            ON predecessor.generation_id = generation.predecessor_generation_id
           AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
          LEFT JOIN repair_graph_expectation repair ON true
        ),
        changed_navigation_directories AS MATERIALIZED (
          SELECT DISTINCT change.directory_path
          FROM focowiki.generation_directory_navigation_changes change
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
        ),
        removed_navigation_leaves AS MATERIALIZED (
          SELECT DISTINCT change.directory_path, removed.leaf_id
          FROM focowiki.generation_directory_navigation_changes change
          CROSS JOIN LATERAL unnest(change.removed_leaf_ids) removed(leaf_id)
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
        ),
        changed_navigation_leaves AS MATERIALIZED (
          SELECT DISTINCT change.directory_path, touched.leaf_id,
                 'upsert'::text AS expected_action
          FROM focowiki.generation_directory_navigation_changes change
          CROSS JOIN LATERAL unnest(change.touched_leaf_ids) touched(leaf_id)
          WHERE change.generation_id = ${input.generationId}
            AND change.knowledge_base_id = ${input.knowledgeBaseId}
            AND NOT EXISTS (
              SELECT 1
              FROM removed_navigation_leaves removed
              WHERE removed.directory_path = change.directory_path
                AND removed.leaf_id = touched.leaf_id
            )
          UNION ALL
          SELECT removed.directory_path, removed.leaf_id, 'delete'::text
          FROM removed_navigation_leaves removed
        ),
        issues AS (
          SELECT 'IMPACT_INCOMPLETE'::text AS code,
                 'A publication impact is incomplete.'::text AS message,
                 impact.id AS reference
          FROM focowiki.publication_impacts impact
          WHERE impact.knowledge_base_id = ${input.knowledgeBaseId}
            AND impact.generation_id = ${input.generationId}
            AND impact.status <> 'completed'

          UNION ALL

          SELECT 'OBJECT_REFERENCE_INVALID',
                 'A changed object reference has no immutable object.',
                 reference.ref_kind || ':' || reference.ref_key
          FROM focowiki.generation_object_refs reference
          LEFT JOIN focowiki.immutable_objects object
            ON object.checksum_sha256 = reference.checksum_sha256
           AND object.format_version = reference.format_version
          WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
            AND reference.generation_id = ${input.generationId}
            AND reference.action = 'upsert'
            AND (
              object.checksum_sha256 IS NULL
              OR object.lifecycle_state <> 'active'
            )

          UNION ALL

          SELECT 'PROJECTION_PATH_MISSING',
                 'A changed projection record has no direct logical path.',
                 record.projection_kind || ':' || record.record_id
          FROM focowiki.generation_projection_records record
          WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
            AND record.generation_id = ${input.generationId}
            AND record.action = 'upsert'
            AND record.logical_path IS NULL

          UNION ALL

          SELECT 'ROOT_REFERENCE_MISSING',
                 'A required root file is unavailable.',
                 required.path
          FROM unnest(
            ${REQUIRED_GENERATED_NAVIGATION_RESOURCES.map((resource) => resource.path)}::text[],
            ${REQUIRED_GENERATED_NAVIGATION_RESOURCES.map((resource) => resource.refKind)}::text[]
          ) AS required(path, ref_kind)
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.generation_object_refs candidate
            WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
              AND candidate.generation_id = ${input.generationId}
              AND candidate.ref_kind = required.ref_kind
              AND candidate.logical_path = required.path
              AND candidate.action = 'upsert'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM predecessor_object_refs previous
            WHERE previous.ref_kind = required.ref_kind
              AND previous.logical_path = required.path
              AND previous.action = 'upsert'
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.generation_object_refs candidate_delete
                WHERE candidate_delete.knowledge_base_id = ${input.knowledgeBaseId}
                  AND candidate_delete.generation_id = ${input.generationId}
                  AND candidate_delete.ref_kind = previous.ref_kind
                  AND candidate_delete.ref_key = previous.ref_key
                  AND candidate_delete.action = 'delete'
              )
          )

          UNION ALL

          SELECT 'DIRECTORY_NAVIGATION_MISSING',
                 'A visible directory has no candidate navigation descriptor.',
                 directory.path
          FROM visible_changed_directories directory
          LEFT JOIN effective_navigation navigation
            ON navigation.directory_path = directory.path
          WHERE navigation.directory_path IS NULL

          UNION ALL

          SELECT 'DIRECTORY_NAVIGATION_COUNT_MISMATCH',
                 'A directory navigation count does not match its visible entries.',
                 directory.path
          FROM expected_tree_statistics directory
          JOIN effective_navigation navigation
            ON navigation.directory_path = directory.path
          WHERE navigation.entry_count <>
            directory.direct_directory_count + directory.direct_file_count

          UNION ALL

          SELECT 'DIRECTORY_NAVIGATION_LINK_INVALID',
                 'A directory navigation leaf chain is incomplete.',
                 navigation.directory_path
          FROM effective_navigation navigation
          WHERE navigation.entry_count <> (
              SELECT coalesce(sum(leaf.entry_count), 0)
              FROM focowiki.generation_directory_navigation_leaves leaf
              WHERE leaf.generation_id = navigation.owner_generation_id
                AND leaf.directory_path = navigation.directory_path
            )
             OR (navigation.entry_count = 0 AND navigation.first_leaf_id IS NOT NULL)
             OR (navigation.entry_count > 0 AND NOT EXISTS (
               SELECT 1
               FROM focowiki.generation_directory_navigation_leaves first_leaf
               WHERE first_leaf.generation_id = navigation.owner_generation_id
                 AND first_leaf.directory_path = navigation.directory_path
                 AND first_leaf.id = navigation.first_leaf_id
                 AND first_leaf.previous_leaf_id IS NULL
             ))
             OR EXISTS (
               SELECT 1
               FROM focowiki.generation_directory_navigation_leaves leaf
               LEFT JOIN focowiki.generation_directory_navigation_leaves next_leaf
                 ON next_leaf.generation_id = leaf.generation_id
                AND next_leaf.directory_path = leaf.directory_path
                AND next_leaf.id = leaf.next_leaf_id
               WHERE leaf.generation_id = navigation.owner_generation_id
                 AND leaf.directory_path = navigation.directory_path
                 AND leaf.next_leaf_id IS NOT NULL
                 AND (next_leaf.id IS NULL OR next_leaf.previous_leaf_id <> leaf.id)
             )

          UNION ALL

          SELECT 'DIRECTORY_STATISTICS_MISSING',
                 'A visible directory has no typed statistics.',
                 directory.path
          FROM visible_changed_directories directory
          LEFT JOIN effective_tree_statistics statistics
            ON statistics.path = directory.path
          WHERE statistics.path IS NULL

          UNION ALL

          SELECT 'DIRECTORY_STATISTICS_MISMATCH',
                 'Directory statistics do not match visible entries.',
                 directory.path
          FROM expected_tree_statistics directory
          JOIN effective_tree_statistics statistics
            ON statistics.path = directory.path
          WHERE statistics.direct_entry_count <>
                  directory.direct_directory_count + directory.direct_file_count
             OR statistics.direct_directory_count <> directory.direct_directory_count
             OR statistics.direct_file_count <> directory.direct_file_count
             OR statistics.descendant_file_count <> directory.descendant_file_count

          UNION ALL

          SELECT 'GRAPH_SUMMARY_MISMATCH',
                 'The candidate graph summary does not match its graph projections.',
                 ${input.generationId}
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.generation_graph_summaries summary
            WHERE summary.generation_id = ${input.generationId}
              AND summary.knowledge_base_id = ${input.knowledgeBaseId}
              AND summary.node_count = (SELECT node_count FROM expected_graph_summary)
              AND summary.edge_count = (SELECT edge_count FROM expected_graph_summary)
              AND summary.graph_index_available = true
          )

          UNION ALL

          SELECT 'DIRECTORY_REFERENCE_MISSING',
                 'A changed directory navigation object reference is unavailable.',
                 directory.directory_path
          FROM changed_navigation_directories directory
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.generation_object_refs root_reference
            WHERE root_reference.generation_id = ${input.generationId}
              AND root_reference.ref_kind = 'directory_root'
              AND root_reference.ref_key = 'directory-root:' || directory.directory_path
              AND root_reference.action = 'upsert'
          )

          UNION ALL

          SELECT 'DIRECTORY_REFERENCE_MISSING',
                 'A changed directory navigation object reference is unavailable.',
                 leaf.directory_path || ':' || leaf.leaf_id
          FROM changed_navigation_leaves leaf
          WHERE NOT EXISTS (
            SELECT 1
            FROM focowiki.generation_object_refs leaf_reference
            WHERE leaf_reference.generation_id = ${input.generationId}
              AND leaf_reference.ref_kind = 'directory_leaf'
              AND leaf_reference.ref_key =
                'directory-leaf:' || leaf.directory_path || ':' || leaf.leaf_id
              AND leaf_reference.action = leaf.expected_action
            )
        )
        SELECT code, message, reference
        FROM issues
        ORDER BY code, reference
        LIMIT ${input.issueLimit}
      `;
    }
  };
}
