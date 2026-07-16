import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createLargeScaleReadPlanTargets,
  summarizeQueryPlan,
  type QueryPlanSummary
} from "../src/db/query-plan-validation.js";
import { cleanReleaseReadModelGinPendingLists } from
  "../src/infrastructure/postgres/release-search-index-maintenance.js";
import { createPostgresAdminRepositories } from "../src/db/admin-repositories.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const runScale = process.env.FOCOWIKI_RUN_QUERY_SCALE === "1";
const describeScale = databaseUrl && runScale ? describe : describe.skip;
const rowCounts = process.env.FOCOWIKI_QUERY_SCALE_ROWS
  ? process.env.FOCOWIKI_QUERY_SCALE_ROWS.split(",").map((value) => Number(value.trim()))
  : [10_000, 100_000];
const KNOWLEDGE_BASE_ID = "kb-plan";
const RELEASE_ID = "release-plan";
const LARGE_RELATIONS = new Set([
  "bundle_file_search_documents",
  "knowledge_file_tree_nodes",
  "knowledge_graph_edges",
  "knowledge_graph_search_documents",
  "resource_operations",
  "source_file_events",
  "source_files"
]);

describeScale("large release read-model query plans", () => {
  const sql = postgres(databaseUrl!, { max: 2, onnotice: () => undefined });

  beforeAll(async () => {
    const database = await sql<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (database[0]?.name !== "focowiki_change_test") {
      throw new Error("Large query validation requires the dedicated focowiki_change_test database");
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  }, 180_000);

  it.each(rowCounts)(
    "uses bounded indexed plans across %i durable records",
    async (rowCount) => {
      await cleanup();
      await seed(rowCount);
      const repositories = createPostgresAdminRepositories(sql);
      const fileSearch = await repositories.files?.searchBundleFiles?.({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        releaseId: RELEASE_ID,
        query: "example generic",
        scope: "all",
        fileKind: "page",
        limit: 10,
        cursor: null
      });
      const graphSearch = await repositories.files?.searchBundleGraphFiles?.({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        releaseId: RELEASE_ID,
        query: "example relationship",
        scope: "all",
        fileKind: "page",
        graphDepth: 1,
        graphFanout: 10,
        limit: 10,
        cursor: null
      });
      expect(fileSearch?.items.length).toBeGreaterThan(0);
      expect(graphSearch?.items.length).toBeGreaterThan(0);
      const baselineRssBytes = process.memoryUsage().rss;
      const plans: Record<string, QueryPlanSummary> = {};
      const largeSequentialScans: Record<string, string[]> = {};

      for (const target of createLargeScaleReadPlanTargets()) {
        const rows = await sql.unsafe<Array<Record<string, unknown>>>(
          buildExplainAnalyzeSql(target.sql)
        );
        const summary = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
        plans[target.name] = summary;

        const sequentialScans = summary.sequentialScanRelations.filter((relation) =>
          LARGE_RELATIONS.has(relation)
        );
        if (sequentialScans.length > 0) {
          largeSequentialScans[target.name] = sequentialScans;
        }
        expect(summary.executionTimeMs ?? 0, `${target.name} exceeded the uncached query budget`).toBeLessThan(1_000);
      }

      const peakRssBytes = process.memoryUsage().rss;
      expect(peakRssBytes - baselineRssBytes).toBeLessThan(256 * 1024 * 1024);
      const slowestPlans = Object.entries(plans)
        .map(([name, plan]) => ({
          name,
          executionTimeMs: plan.executionTimeMs,
          indexNames: plan.indexNames,
          sequentialScanRelations: plan.sequentialScanRelations
        }))
        .sort((left, right) => (right.executionTimeMs ?? 0) - (left.executionTimeMs ?? 0))
        .slice(0, 8);
      const criticalPlans = Object.fromEntries(
        [
          "knowledge-file-search-first-page",
          "knowledge-file-search-no-result",
          "knowledge-graph-search-first-page",
          "knowledge-hybrid-search-first-page",
          "knowledge-tree-search-name",
          "release-read-summary"
        ].map((name) => [name, plans[name]])
      );
      console.info("Large read-model query-plan evidence", JSON.stringify({
        rowCount,
        peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes),
        largeSequentialScans,
        slowestPlans,
        criticalPlans
      }));
      expect(largeSequentialScans).toEqual({});
    },
    600_000
  );

  async function seed(rowCount: number): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`SET CONSTRAINTS ALL DEFERRED`;
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name, description, catalog_generation)
        VALUES (${KNOWLEDGE_BASE_ID}, 'Plan docs', 'Synthetic query-plan validation', 1)
      `;
      await transaction`
        INSERT INTO focowiki.releases (
          id, knowledge_base_id, bundle_root_key, generated_at, published_at,
          file_count, manifest_checksum_sha256, catalog_generation
        ) VALUES (
          ${RELEASE_ID}, ${KNOWLEDGE_BASE_ID}, 'query-plan/', now(), now(),
          ${rowCount}, repeat('a', 64), 1
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_release_id = ${RELEASE_ID}
        WHERE id = ${KNOWLEDGE_BASE_ID}
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          processing_started_at, processing_ended_at, generated_output_status,
          generated_bundle_file_path, graph_relationship_count,
          model_invocation_status, model_invocation_model_name,
          model_invocation_started_at, model_invocation_ended_at,
          publication_dirty_at, publication_visible_at, created_at,
          name, relative_path, path_key, active_revision_id,
          resource_revision, content_revision
        )
        SELECT
          CASE WHEN item = 1 THEN 'source-file-plan'
               ELSE 'source-file-scale-' || lpad(item::text, 6, '0') END,
          ${KNOWLEDGE_BASE_ID},
          'query-plan/source-' || lpad(item::text, 6, '0') || '.md',
          'text/markdown; charset=utf-8', 256,
          md5(item::text) || md5(item::text),
          'completed', 'release_activation',
          '2026-06-01T00:00:00Z'::timestamptz + item * interval '1 millisecond',
          '2026-06-01T00:00:01Z'::timestamptz + item * interval '1 millisecond',
          'visible',
          'pages/guides/example-' || lpad(item::text, 6, '0') || '.md',
          2, 'completed', 'generic-model',
          '2026-06-01T00:00:00Z'::timestamptz + item * interval '1 millisecond',
          '2026-06-01T00:00:01Z'::timestamptz + item * interval '1 millisecond',
          '2026-06-01T00:00:01Z'::timestamptz + item * interval '1 millisecond',
          '2026-06-01T00:00:02Z'::timestamptz + item * interval '1 millisecond',
          '2026-06-01T00:00:00Z'::timestamptz + item * interval '1 millisecond',
          'example-' || lpad(item::text, 6, '0') || '.md',
          'guides/example-' || lpad(item::text, 6, '0') || '.md',
          'guides/example-' || lpad(item::text, 6, '0') || '.md',
          'source-revision-scale-' || lpad(item::text, 6, '0'),
          1, 1
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        )
        SELECT
          'source-revision-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID},
          CASE WHEN item = 1 THEN 'source-file-plan'
               ELSE 'source-file-scale-' || lpad(item::text, 6, '0') END,
          1, 'query-plan/revision-' || lpad(item::text, 6, '0') || '.md',
          'text/markdown; charset=utf-8', 256,
          md5(item::text) || md5(item::text), 'completed'
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.bundle_files (
          id, knowledge_base_id, release_id, source_file_id, file_kind,
          logical_path, object_key, content_type, size_bytes, checksum_sha256,
          okf_type, title, description, navigation_only
        )
        SELECT
          CASE WHEN item = 1 THEN 'knowledge-file-plan'
               ELSE 'bundle-file-scale-' || lpad(item::text, 6, '0') END,
          ${KNOWLEDGE_BASE_ID}, ${RELEASE_ID},
          CASE WHEN item = 1 THEN 'source-file-plan'
               ELSE 'source-file-scale-' || lpad(item::text, 6, '0') END,
          'page',
          'pages/guides/example-' || lpad(item::text, 6, '0') || '.md',
          'query-plan/generated/example-' || lpad(item::text, 6, '0') || '.md',
          'text/markdown; charset=utf-8', 256,
          md5(item::text) || md5(item::text),
          'Document', 'Example ' || item::text,
          'Generic synthetic document ' || item::text, false
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.bundle_file_search_documents (
          bundle_file_id, knowledge_base_id, release_id, source_file_id,
          file_kind, logical_path, path_text, title_text, description_text,
          metadata_text, search_text
        )
        SELECT
          file.id, file.knowledge_base_id, file.release_id, file.source_file_id,
          file.file_kind, file.logical_path, lower(file.logical_path),
          lower(coalesce(file.title, '')), lower(coalesce(file.description, '')),
          'generic topic',
          lower(file.logical_path || ' ' || coalesce(file.title, '') || ' ' || coalesce(file.description, '') || ' generic topic ' || repeat('bounded detail ', 50))
        FROM focowiki.bundle_files file
        WHERE file.knowledge_base_id = ${KNOWLEDGE_BASE_ID}
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_file_tree_nodes (
          id, knowledge_base_id, release_id, path, name, node_type,
          depth, sort_key, child_count, direct_file_count, descendant_file_count
        ) VALUES (
          'tree-root-plan', ${KNOWLEDGE_BASE_ID}, ${RELEASE_ID},
          'pages', 'pages', 'directory', 0, '0:pages', ${rowCount}, ${rowCount}, ${rowCount}
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_file_tree_nodes (
          id, knowledge_base_id, release_id, parent_id, path, name, node_type,
          file_id, depth, sort_key
        )
        SELECT
          'tree-node-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID}, ${RELEASE_ID}, 'tree-root-plan',
          'pages/guides/example-' || lpad(item::text, 6, '0') || '.md',
          'example-' || lpad(item::text, 6, '0') || '.md', 'file',
          CASE WHEN item = 1 THEN 'knowledge-file-plan'
               ELSE 'bundle-file-scale-' || lpad(item::text, 6, '0') END,
          2, '1:example-' || lpad(item::text, 6, '0') || '.md'
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_graph_nodes (
          id, knowledge_base_id, release_id, file_id, source_file_id,
          path, title, summary, profile_text
        )
        SELECT
          CASE WHEN item = 1 THEN 'graph-node-plan'
               ELSE 'graph-node-scale-' || lpad(item::text, 6, '0') END,
          ${KNOWLEDGE_BASE_ID}, ${RELEASE_ID},
          CASE WHEN item = 1 THEN 'knowledge-file-plan'
               ELSE 'bundle-file-scale-' || lpad(item::text, 6, '0') END,
          CASE WHEN item = 1 THEN 'source-file-plan'
               ELSE 'source-file-scale-' || lpad(item::text, 6, '0') END,
          'pages/guides/example-' || lpad(item::text, 6, '0') || '.md',
          'Example ' || item::text, 'Generic relationship subject',
          'example generic relationship subject'
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_graph_edges (
          id, knowledge_base_id, release_id, from_node_id, to_node_id,
          from_file_id, to_file_id, relation_type, direction, confidence,
          weight, quality_status, reason, created_by
        )
        SELECT
          CASE WHEN item = 1 THEN 'graph-edge-plan'
               ELSE 'graph-edge-scale-' || lpad(item::text, 6, '0') END,
          ${KNOWLEDGE_BASE_ID}, ${RELEASE_ID},
          CASE WHEN item = 1 THEN 'graph-node-plan'
               ELSE 'graph-node-scale-' || lpad(item::text, 6, '0') END,
          CASE WHEN item = ${rowCount} THEN 'graph-node-plan'
               ELSE 'graph-node-scale-' || lpad((item + 1)::text, 6, '0') END,
          CASE WHEN item = 1 THEN 'knowledge-file-plan'
               ELSE 'bundle-file-scale-' || lpad(item::text, 6, '0') END,
          CASE WHEN item = ${rowCount} THEN 'knowledge-file-plan'
               ELSE 'bundle-file-scale-' || lpad((item + 1)::text, 6, '0') END,
          'related', 'directed', 0.8, 0.8, 'accepted',
          'The files describe connected generic subjects.', 'deterministic'
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_graph_search_documents (
          id, knowledge_base_id, release_id, edge_id, file_id, path,
          anchor_type, title, summary, search_text, matched_field_text,
          neighbor_text, relationship_count
        )
        SELECT
          'graph-search-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID}, ${RELEASE_ID},
          CASE WHEN item = 1 THEN 'graph-edge-plan'
               ELSE 'graph-edge-scale-' || lpad(item::text, 6, '0') END,
          CASE WHEN item = 1 THEN 'knowledge-file-plan'
               ELSE 'bundle-file-scale-' || lpad(item::text, 6, '0') END,
          'pages/guides/example-' || lpad(item::text, 6, '0') || '.md',
          'edge', 'Example ' || item::text, 'Generic relationship subject',
          'example generic relationship subject related ' || repeat('bounded detail ', 50),
          'generic relationship', 'example neighbor ' || repeat('bounded context ', 20), 2
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.resource_operations (
          id, knowledge_base_id, operation_kind, state, idempotency_key,
          request_fingerprint, candidate_catalog_generation, completed_at
        )
        SELECT
          'operation-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID}, 'source_file_move', 'completed',
          'idempotency-scale-' || lpad(item::text, 6, '0'),
          md5(item::text), 1, now()
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.resource_operation_targets (
          operation_id, target_kind, target_id, sequence_number
        )
        SELECT
          'operation-scale-' || lpad(item::text, 6, '0'),
          'source_file',
          CASE WHEN item = 1 THEN 'source-file-plan'
               ELSE 'source-file-scale-' || lpad(item::text, 6, '0') END,
          0
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.source_file_events (
          id, knowledge_base_id, source_file_id, stage_key, message_key,
          started_at, ended_at, severity, created_at
        )
        SELECT
          'source-event-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID}, 'source-file-plan',
          'release_activation', 'release_activation',
          '2026-01-01T00:00:00Z'::timestamptz + item * interval '1 millisecond',
          '2026-01-01T00:00:01Z'::timestamptz + item * interval '1 millisecond',
          'info',
          '2026-01-01T00:00:00Z'::timestamptz + item * interval '1 millisecond'
        FROM generate_series(1, ${rowCount}) item
      `;
      await transaction`
        INSERT INTO focowiki.release_read_summaries (
          release_id, knowledge_base_id, searchable_file_count, tree_node_count,
          graph_document_count, graph_relationship_count, graph_node_count, graph_edge_count
        ) VALUES (
          ${RELEASE_ID}, ${KNOWLEDGE_BASE_ID}, ${rowCount}, ${rowCount},
          ${rowCount}, ${rowCount}, ${rowCount}, ${rowCount}
        )
      `;
    });

    await cleanReleaseReadModelGinPendingLists(sql);

    await sql.unsafe(`
      ANALYZE focowiki.source_files;
      ANALYZE focowiki.source_file_events;
      ANALYZE focowiki.resource_operations;
      ANALYZE focowiki.resource_operation_targets;
      ANALYZE focowiki.bundle_files;
      ANALYZE focowiki.bundle_file_search_documents;
      ANALYZE focowiki.knowledge_file_tree_nodes;
      ANALYZE focowiki.knowledge_graph_nodes;
      ANALYZE focowiki.knowledge_graph_edges;
      ANALYZE focowiki.knowledge_graph_search_documents;
      ANALYZE focowiki.release_read_summaries;
    `);
  }

  async function cleanup(): Promise<void> {
    await sql.unsafe("TRUNCATE TABLE focowiki.knowledge_bases CASCADE");
  }
});
