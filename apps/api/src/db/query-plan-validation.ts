export type QueryPlanTargetName =
  | "knowledge-base-card-search"
  | "source-file-list"
  | "source-file-list-filename-filter"
  | "source-file-list-status-stage-filter"
  | "source-file-list-time-filter"
  | "source-file-list-error-filter"
  | "source-file-list-model-filter"
  | "source-file-list-action-filter"
  | "source-file-event-page"
  | "source-resource-list-filter"
  | "resource-operation-page"
  | "worker-job-source-cancellation"
  | "knowledge-tree-page"
  | "knowledge-tree-search-name"
  | "knowledge-tree-search-path"
  | "knowledge-tree-search-next-page"
  | "knowledge-tree-search-ancestors"
  | "knowledge-file-content"
  | "knowledge-file-search-first-page"
  | "knowledge-file-search-next-page"
  | "knowledge-file-search-multi-term"
  | "knowledge-file-search-no-result"
  | "knowledge-file-search-kind-filter"
  | "knowledge-file-search-cache-hit"
  | "release-read-summary"
  | "knowledge-graph-search-first-page"
  | "knowledge-graph-search-edge-match"
  | "knowledge-graph-search-multi-term"
  | "knowledge-hybrid-search-first-page"
  | "graph-expand-file-neighborhood"
  | "graph-expand-edge-seed"
  | "graph-expand-query-seed"
  | "source-file-graph-summary"
  | "hard-delete-source-knowledge-graph-search-documents"
  | "hard-delete-source-knowledge-graph-edges"
  | "hard-delete-source-knowledge-tree-entries"
  | "hard-delete-source-bundle-files"
  | "hard-delete-source-worker-jobs"
  | "hard-delete-knowledge-base-graph-search-documents"
  | "hard-delete-knowledge-base-graph-edges"
  | "hard-delete-knowledge-base-tree-entries"
  | "hard-delete-knowledge-base-bundle-files"
  | "hard-delete-knowledge-base-source-files"
  | "hard-delete-knowledge-base-worker-jobs"
  | "release-validation-source-page"
  | "release-validation-tree-reachability"
  | "release-validation-concept-type"
  | "release-validation-generated-target"
  | "release-validation-continuation-chain"
  | "release-validation-index-coverage";

export type QueryPlanTarget = {
  name: QueryPlanTargetName;
  description: string;
  sql: string;
};

export type QueryPlanSummary = {
  nodeTypes: string[];
  relationNames: string[];
  indexNames: string[];
  sequentialScanRelations: string[];
  hasSequentialScan: boolean;
  actualRows: number;
  rowsRemovedByFilter: number;
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
};

type JsonPlanNode = {
  "Node Type"?: unknown;
  "Relation Name"?: unknown;
  "Index Name"?: unknown;
  "Shared Hit Blocks"?: unknown;
  "Shared Read Blocks"?: unknown;
  "Actual Rows"?: unknown;
  "Rows Removed by Filter"?: unknown;
  Plans?: unknown;
};

type JsonExplainRecord = {
  Plan?: unknown;
  "Planning Time"?: unknown;
  "Execution Time"?: unknown;
};

export function buildExplainAnalyzeSql(sql: string): string {
  const normalized = sql.trim().replace(/;+\s*$/, "");

  if (!normalized) {
    throw new Error("Query plan SQL must not be empty");
  }

  if (normalized.includes(";")) {
    throw new Error("Query plan SQL must contain one statement");
  }

  return `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${normalized}`;
}

export function summarizeQueryPlan(planJson: unknown): QueryPlanSummary {
  const record = readExplainRecord(planJson);
  const nodeTypes = new Set<string>();
  const relationNames = new Set<string>();
  const indexNames = new Set<string>();
  const sequentialScanRelations = new Set<string>();
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  let actualRows = 0;
  let rowsRemovedByFilter = 0;

  collectPlanNode(record.Plan, (node) => {
    const nodeType = readString(node["Node Type"]);
    const relationName = readString(node["Relation Name"]);
    const indexName = readString(node["Index Name"]);

    if (nodeType) {
      nodeTypes.add(nodeType);
    }

    if (relationName) {
      relationNames.add(relationName);
      if (nodeType === "Seq Scan") {
        sequentialScanRelations.add(relationName);
      }
    }

    if (indexName) {
      indexNames.add(indexName);
    }

    sharedHitBlocks += readNumber(node["Shared Hit Blocks"]) ?? 0;
    sharedReadBlocks += readNumber(node["Shared Read Blocks"]) ?? 0;
    actualRows += readNumber(node["Actual Rows"]) ?? 0;
    rowsRemovedByFilter += readNumber(node["Rows Removed by Filter"]) ?? 0;
  });

  return {
    nodeTypes: [...nodeTypes],
    relationNames: [...relationNames],
    indexNames: [...indexNames],
    sequentialScanRelations: [...sequentialScanRelations],
    hasSequentialScan: nodeTypes.has("Seq Scan"),
    actualRows,
    rowsRemovedByFilter,
    planningTimeMs: readNumber(record["Planning Time"]),
    executionTimeMs: readNumber(record["Execution Time"]),
    sharedHitBlocks,
    sharedReadBlocks
  };
}

export function createLargeScaleReadPlanTargets(): QueryPlanTarget[] {
  return [
    {
      name: "knowledge-base-card-search",
      description: "Knowledge-base card search must use indexed metadata search before cursor pagination.",
      sql: `
        SELECT id, name, description, active_release_id, created_at, updated_at
        FROM focowiki.knowledge_bases
        WHERE deleted_at IS NULL
          AND lower(id || ' ' || name || ' ' || coalesce(description, '')) LIKE '%docs%' ESCAPE '\\'
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list",
      description: "Source-file cursor page must use knowledge-base scoped created_at/id indexes.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, generated_bundle_file_id, generated_bundle_file_path,
               model_invocation_status, model_invocation_model_name, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-filename-filter",
      description: "Source-file filename filter must stay bounded and use indexed searchable filename state.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND relative_path ILIKE '%example%'
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-status-stage-filter",
      description: "Source-file status and stage filters must use knowledge-base scoped processing indexes.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND processing_status = 'completed'
          AND processing_stage = 'release_activation'
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-time-filter",
      description: "Source-file time range filters must apply in PostgreSQL before cursor pagination.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND processing_started_at >= '2026-01-01T00:00:00.000Z'
          AND processing_started_at <= '2026-12-31T23:59:59.999Z'
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-error-filter",
      description: "Source-file error filters must use persisted error summary columns.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND (
            processing_error_code IS NOT NULL
            OR publication_error_code IS NOT NULL
          )
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-model-filter",
      description: "Source-file model-state filters must use persisted latest model summary columns.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND model_invocation_status = 'completed'
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-action-filter",
      description: "Source-file action filters must derive from persisted source-file summary columns.",
      sql: `
        SELECT id, knowledge_base_id, relative_path, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND generated_output_status = 'visible'
          AND generated_bundle_file_path IS NOT NULL
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-event-page",
      description: "Source-file events must use a resource-scoped keyset cursor.",
      sql: `
        SELECT id, knowledge_base_id, source_file_id, stage_key, message_key,
               started_at, ended_at, severity, created_at
        FROM focowiki.source_file_events
        WHERE knowledge_base_id = 'kb-plan'
          AND source_file_id = 'source-file-plan'
          AND (created_at > '2026-01-01T00:00:00.000Z'
            OR (created_at = '2026-01-01T00:00:00.000Z' AND id > 'source-event-plan'))
        ORDER BY created_at ASC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-resource-list-filter",
      description: "Version-two source resources must use indexed path, processing, output, and ID cursor filters.",
      sql: `
        SELECT id, knowledge_base_id, directory_id, name, relative_path,
               processing_status, processing_stage, generated_output_status,
               generated_bundle_file_path, resource_revision, content_revision
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND deletion_intent_id IS NULL
          AND relative_path ILIKE '%guide%' ESCAPE '\\'
          AND processing_status = 'completed'
          AND processing_stage = 'release_activation'
          AND generated_output_status = 'visible'
          AND id > 'source-file-plan'
        ORDER BY id ASC
        LIMIT 51
      `
    },
    {
      name: "resource-operation-page",
      description: "Resource-operation pages must use a knowledge-base scoped keyset cursor and bounded target lookup.",
      sql: `
        SELECT operation.id, operation.knowledge_base_id, operation.operation_kind,
               operation.state, operation.candidate_catalog_generation,
               target.target_kind, target.target_id
        FROM focowiki.resource_operations operation
        LEFT JOIN LATERAL (
          SELECT candidate.target_kind, candidate.target_id
          FROM focowiki.resource_operation_targets candidate
          WHERE candidate.operation_id = operation.id
          ORDER BY candidate.sequence_number ASC, candidate.target_kind ASC, candidate.target_id ASC
          LIMIT 1
        ) target ON TRUE
        WHERE operation.knowledge_base_id = 'kb-plan'
          AND operation.id > 'operation-plan'
        ORDER BY operation.id ASC
        LIMIT 51
      `
    },
    {
      name: "worker-job-source-cancellation",
      description: "Task deletion must cancel selected queued source-file jobs through explicit indexed IDs.",
      sql: `
        SELECT id
        FROM focowiki.worker_jobs
        WHERE knowledge_base_id = 'kb-plan'
          AND kind = 'source_file_processing'
          AND status IN ('queued', 'running')
          AND source_file_id = ANY(ARRAY['source-file-plan-a', 'source-file-plan-b'])
        ORDER BY run_after ASC, created_at ASC, id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-tree-page",
      description: "Knowledge tree pages must use parent scoped cursor indexes.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.parent_id,
               entry.name, entry.path, entry.sort_key, entry.node_type,
               entry.file_id, entry.child_count, entry.descendant_file_count,
               file.source_file_id, file.file_kind
        FROM focowiki.knowledge_file_tree_nodes entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND entry.parent_id IS NULL
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-tree-search-name",
      description: "Knowledge tree search by name must use knowledge-base scoped indexed search.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.parent_id,
               entry.name, entry.path, entry.sort_key, entry.node_type,
               entry.file_id, entry.child_count, entry.descendant_file_count,
               file.source_file_id, file.file_kind
        FROM focowiki.knowledge_file_tree_nodes entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND lower(entry.name || ' ' || entry.path) LIKE '%example%' ESCAPE '\\'
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-tree-search-path",
      description: "Knowledge tree search by path must use knowledge-base scoped indexed search.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.parent_id,
               entry.name, entry.path, entry.sort_key, entry.node_type,
               entry.file_id, entry.child_count, entry.descendant_file_count,
               file.source_file_id, file.file_kind
        FROM focowiki.knowledge_file_tree_nodes entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND lower(entry.name || ' ' || entry.path) LIKE '%pages/guides/example%' ESCAPE '\\'
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-tree-search-next-page",
      description: "Knowledge tree search next page must use cursor seek rather than offset.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.parent_id,
               entry.name, entry.path, entry.sort_key, entry.node_type,
               entry.file_id, entry.child_count, entry.descendant_file_count,
               file.source_file_id, file.file_kind
        FROM focowiki.knowledge_file_tree_nodes entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND lower(entry.name || ' ' || entry.path) LIKE '%example%' ESCAPE '\\'
          AND (entry.sort_key > '1:example.md' OR (entry.sort_key = '1:example.md' AND entry.id > 'tree-entry-plan'))
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-tree-search-ancestors",
      description: "Search result ancestor lookup must fetch only returned match ancestors.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.parent_id,
               entry.name, entry.path, entry.sort_key, entry.node_type,
               entry.file_id, entry.child_count, entry.descendant_file_count,
               file.source_file_id, file.file_kind
        FROM focowiki.knowledge_file_tree_nodes entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND entry.path = ANY(ARRAY['pages', 'pages/guides'])
        ORDER BY entry.path ASC
      `
    },
    {
      name: "knowledge-file-content",
      description: "Generated content lookup must resolve one knowledge file by path.",
      sql: `
        SELECT id, knowledge_base_id, logical_path, object_key, source_file_id, file_kind
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND logical_path = 'pages/example.md'
        LIMIT 1
      `
    },
    {
      name: "knowledge-file-search-first-page",
      description: "Developer file search first page must use the flat release-scoped search document.",
      sql: `
        SELECT bundle_file_id, file_kind, logical_path
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_kind = 'page'
          AND search_text ILIKE '%example%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 1000
      `
    },
    {
      name: "knowledge-file-search-next-page",
      description: "Developer file search next page must use a keyset cursor over flat search documents.",
      sql: `
        SELECT bundle_file_id, file_kind, logical_path
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_kind = 'page'
          AND search_text ILIKE '%example%' ESCAPE '\\'
          AND (logical_path > 'pages/example.md' OR (logical_path = 'pages/example.md' AND bundle_file_id > 'bundle-file-plan'))
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 1000
      `
    },
    {
      name: "knowledge-file-search-multi-term",
      description: "Multi-term file search must combine bounded trigram-indexed term predicates.",
      sql: `
        SELECT bundle_file_id, file_kind, logical_path
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_kind = 'page'
          AND search_text ILIKE '%example%' ESCAPE '\\'
          AND search_text ILIKE '%generic%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 1000
      `
    },
    {
      name: "knowledge-file-search-no-result",
      description: "Developer file search no-result checks must stay bounded on flat search documents.",
      sql: `
        SELECT bundle_file_id, file_kind, logical_path
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_kind = 'page'
          AND search_text ILIKE '%no-such-file%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 1000
      `
    },
    {
      name: "knowledge-file-search-kind-filter",
      description: "Developer file search kind filter must use release and file-kind scoped search indexes.",
      sql: `
        SELECT bundle_file_id, file_kind, logical_path
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_kind = 'schema'
          AND search_text ILIKE '%schema%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 1000
      `
    },
    {
      name: "knowledge-file-search-cache-hit",
      description: "Developer file search cache hits must not require database search SQL.",
      sql: `
        SELECT 1
        FROM focowiki.bundle_files
        WHERE false
        LIMIT 0
      `
    },
    {
      name: "release-read-summary",
      description: "Search availability and counts must resolve from one compact release summary row.",
      sql: `
        SELECT searchable_file_count, graph_document_count,
               graph_relationship_count, graph_node_count, graph_edge_count
        FROM focowiki.release_read_summaries
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
        LIMIT 1
      `
    },
    {
      name: "knowledge-graph-search-first-page",
      description: "Developer graph search first page must use knowledge graph search documents.",
      sql: `
        SELECT id, file_id, node_id, edge_id, path, anchor_type, title, summary,
               relationship_count, top_neighbors_json
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_id IS NOT NULL
          AND path IS NOT NULL
          AND search_text ILIKE '%example%' ESCAPE '\\'
        ORDER BY path ASC NULLS LAST, file_id ASC, id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-graph-search-edge-match",
      description: "Developer graph search edge matches must use edge-anchored graph search documents.",
      sql: `
        SELECT id, file_id, node_id, edge_id, path, title, summary, matched_field_text
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND anchor_type = 'edge'
          AND file_id IS NOT NULL
          AND path IS NOT NULL
          AND search_text ILIKE '%example%' ESCAPE '\\'
        ORDER BY path ASC NULLS LAST, file_id ASC, id ASC
        LIMIT 26
      `
    },
    {
      name: "knowledge-graph-search-multi-term",
      description: "Multi-term graph search must combine bounded indexed graph-context predicates.",
      sql: `
        SELECT id, file_id, path, anchor_type, title, summary
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_id IS NOT NULL
          AND path IS NOT NULL
          AND (search_text ILIKE '%example%' ESCAPE '\\' OR neighbor_text ILIKE '%example%' ESCAPE '\\')
          AND (search_text ILIKE '%generic%' ESCAPE '\\' OR neighbor_text ILIKE '%generic%' ESCAPE '\\')
        ORDER BY path ASC NULLS LAST, file_id ASC, id ASC
        LIMIT 51
      `
    },
    {
      name: "knowledge-hybrid-search-first-page",
      description: "Hybrid search must use the same bounded release graph document candidates as graph search.",
      sql: `
        SELECT id, file_id, node_id, edge_id, path, anchor_type, title, summary,
               relationship_count, top_neighbors_json
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_id IS NOT NULL
          AND path IS NOT NULL
          AND (
            search_text ILIKE '%example%' ESCAPE '\\'
            OR neighbor_text ILIKE '%example%' ESCAPE '\\'
          )
        ORDER BY path ASC NULLS LAST, file_id ASC, id ASC
        LIMIT 1000
      `
    },
    {
      name: "source-file-graph-summary",
      description: "Graph summary detail must read one source-file summary row.",
      sql: `
        SELECT graph_relationship_count, graph_top_relationships_json
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND id = 'source-file-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
        LIMIT 1
      `
    },
    {
      name: "graph-expand-file-neighborhood",
      description: "Graph expansion from a file seed must use accepted edge indexes and bounded page reads.",
      sql: `
        WITH relationships AS (
          SELECT
            edge.to_file_id AS related_file_id,
            edge.relation_type,
            'outgoing'::text AS direction,
            edge.weight,
            edge.reason,
            edge.evidence_json
          FROM focowiki.knowledge_graph_edges edge
          WHERE edge.knowledge_base_id = 'kb-plan'
            AND edge.quality_status = 'accepted'
            AND edge.from_file_id = 'knowledge-file-plan'
          UNION ALL
          SELECT
            edge.from_file_id AS related_file_id,
            edge.relation_type,
            'incoming'::text AS direction,
            edge.weight,
            edge.reason,
            edge.evidence_json
          FROM focowiki.knowledge_graph_edges edge
          WHERE edge.knowledge_base_id = 'kb-plan'
            AND edge.quality_status = 'accepted'
            AND edge.to_file_id = 'knowledge-file-plan'
        )
        SELECT
          node.id AS node_id,
          node.source_file_id,
          file.id AS file_id,
          file.logical_path,
          relationships.relation_type,
          relationships.direction,
          relationships.weight,
          relationships.reason
        FROM relationships
        JOIN focowiki.knowledge_graph_nodes node
          ON node.knowledge_base_id = 'kb-plan'
         AND node.file_id = relationships.related_file_id
        JOIN focowiki.bundle_files file
          ON file.knowledge_base_id = 'kb-plan'
         AND file.id = node.file_id
        ORDER BY relationships.weight DESC, node.id ASC
        LIMIT 26
      `
    },
    {
      name: "graph-expand-edge-seed",
      description: "Graph expansion from an edge seed must resolve one accepted edge before bounded neighbor reads.",
      sql: `
        SELECT edge.id, edge.knowledge_base_id, edge.from_file_id, edge.to_file_id,
               edge.relation_type, edge.weight, edge.reason, edge.quality_status, edge.evidence_json
        FROM focowiki.knowledge_graph_edges edge
        JOIN focowiki.bundle_files from_file
          ON from_file.knowledge_base_id = edge.knowledge_base_id
         AND from_file.id = edge.from_file_id
        JOIN focowiki.bundle_files to_file
          ON to_file.knowledge_base_id = edge.knowledge_base_id
         AND to_file.id = edge.to_file_id
        WHERE edge.knowledge_base_id = 'kb-plan'
          AND edge.release_id = 'release-plan'
          AND edge.id = 'graph-edge-plan'
          AND edge.quality_status = 'accepted'
        LIMIT 1
      `
    },
    {
      name: "graph-expand-query-seed",
      description: "Graph expansion from a query seed must use graph search documents before expansion.",
      sql: `
        SELECT id, file_id, node_id, edge_id, path, anchor_type, title, summary,
               relationship_count, top_neighbors_json
        FROM focowiki.knowledge_graph_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND file_id IS NOT NULL
          AND path IS NOT NULL
          AND search_text ILIKE '%example%' ESCAPE '\\'
        ORDER BY path ASC NULLS LAST, file_id ASC, id ASC
        LIMIT 26
      `
    }
  ];
}

export function createHardDeletePlanTargets(): QueryPlanTarget[] {
  return [
    {
      name: "hard-delete-source-knowledge-graph-search-documents",
      description: "Source-file hard delete graph search cleanup must stay file scoped.",
      sql: `
        WITH target AS (
          SELECT document.id
          FROM focowiki.knowledge_graph_search_documents document
          JOIN focowiki.bundle_files file
            ON file.id = document.file_id
          WHERE document.knowledge_base_id = 'kb-plan'
            AND file.knowledge_base_id = 'kb-plan'
            AND file.source_file_id = 'source-file-plan'
          ORDER BY document.id ASC
          LIMIT 100
        )
        SELECT document.id
        FROM focowiki.knowledge_graph_search_documents document
        JOIN target ON target.id = document.id
      `
    },
    {
      name: "hard-delete-source-knowledge-graph-edges",
      description: "Source-file hard delete graph edge cleanup must stay file endpoint scoped.",
      sql: `
        WITH source_files AS (
          SELECT id
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = 'kb-plan'
            AND source_file_id = 'source-file-plan'
        ),
        target AS (
          SELECT edge.id
          FROM focowiki.knowledge_graph_edges edge
          WHERE edge.knowledge_base_id = 'kb-plan'
            AND (
              edge.from_file_id IN (SELECT id FROM source_files)
              OR edge.to_file_id IN (SELECT id FROM source_files)
            )
          ORDER BY edge.id ASC
          LIMIT 100
        )
        SELECT edge.id
        FROM focowiki.knowledge_graph_edges edge
        JOIN target ON target.id = edge.id
      `
    },
    {
      name: "hard-delete-source-knowledge-tree-entries",
      description: "Source-file hard delete tree cleanup must resolve entries through knowledge files.",
      sql: `
        WITH target AS (
          SELECT entry.id
          FROM focowiki.knowledge_file_tree_nodes entry
          JOIN focowiki.bundle_files file
            ON file.id = entry.file_id
          WHERE entry.knowledge_base_id = 'kb-plan'
            AND file.knowledge_base_id = 'kb-plan'
            AND file.source_file_id = 'source-file-plan'
          ORDER BY entry.id ASC
          LIMIT 100
        )
        SELECT entry.id
        FROM focowiki.knowledge_file_tree_nodes entry
        JOIN target ON target.id = entry.id
      `
    },
    {
      name: "hard-delete-source-bundle-files",
      description: "Source-file hard delete bundle cleanup must use knowledge-base and source-file scope.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = 'kb-plan'
            AND source_file_id = 'source-file-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT file.id
        FROM focowiki.bundle_files file
        JOIN target ON target.id = file.id
      `
    },
    {
      name: "hard-delete-source-worker-jobs",
      description: "Source-file hard delete worker cleanup must target only the source-file job scope.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.worker_jobs
          WHERE knowledge_base_id = 'kb-plan'
            AND source_file_id = 'source-file-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT job.id
        FROM focowiki.worker_jobs job
        JOIN target ON target.id = job.id
      `
    },
    {
      name: "hard-delete-knowledge-base-graph-search-documents",
      description: "Knowledge-base hard delete graph search cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.knowledge_graph_search_documents
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT document.id
        FROM focowiki.knowledge_graph_search_documents document
        JOIN target ON target.id = document.id
      `
    },
    {
      name: "hard-delete-knowledge-base-graph-edges",
      description: "Knowledge-base hard delete graph edge cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.knowledge_graph_edges
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT edge.id
        FROM focowiki.knowledge_graph_edges edge
        JOIN target ON target.id = edge.id
      `
    },
    {
      name: "hard-delete-knowledge-base-tree-entries",
      description: "Knowledge-base hard delete tree cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.knowledge_file_tree_nodes
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT entry.id
        FROM focowiki.knowledge_file_tree_nodes entry
        JOIN target ON target.id = entry.id
      `
    },
    {
      name: "hard-delete-knowledge-base-bundle-files",
      description: "Knowledge-base hard delete bundle cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT file.id
        FROM focowiki.bundle_files file
        JOIN target ON target.id = file.id
      `
    },
    {
      name: "hard-delete-knowledge-base-source-files",
      description: "Knowledge-base hard delete source cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.source_files
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT source_file.id
        FROM focowiki.source_files source_file
        JOIN target ON target.id = source_file.id
      `
    },
    {
      name: "hard-delete-knowledge-base-worker-jobs",
      description: "Knowledge-base hard delete worker cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.worker_jobs
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT job.id
        FROM focowiki.worker_jobs job
        JOIN target ON target.id = job.id
      `
    }
  ];
}

export function createReleaseValidationPlanTargets(): QueryPlanTarget[] {
  return [
    {
      name: "release-validation-source-page",
      description: "Release source-page validation must use release-scoped snapshot and page indexes.",
      sql: `
        SELECT expected.generated_path
        FROM focowiki.release_source_files expected
        LEFT JOIN focowiki.bundle_files actual
          ON actual.knowledge_base_id = expected.knowledge_base_id
         AND actual.release_id = expected.release_id
         AND actual.source_file_id = expected.source_file_id
         AND actual.logical_path = expected.generated_path
         AND actual.file_kind = 'page'
        WHERE expected.knowledge_base_id = 'kb-okf-scale'
          AND expected.release_id = 'release-okf-scale'
          AND actual.id IS NULL
        ORDER BY expected.generated_path ASC
        LIMIT 101
      `
    },
    {
      name: "release-validation-tree-reachability",
      description: "Release tree validation must resolve generated files through indexed file identities.",
      sql: `
        SELECT file.logical_path
        FROM focowiki.bundle_files file
        LEFT JOIN focowiki.knowledge_file_tree_nodes tree
          ON tree.knowledge_base_id = file.knowledge_base_id
         AND tree.release_id = file.release_id
         AND tree.file_id = file.id
        WHERE file.knowledge_base_id = 'kb-okf-scale'
          AND file.release_id = 'release-okf-scale'
          AND tree.id IS NULL
        ORDER BY file.logical_path ASC
        LIMIT 101
      `
    },
    {
      name: "release-validation-concept-type",
      description: "Release concept validation must inspect only non-reserved Markdown in one release.",
      sql: `
        SELECT file.logical_path
        FROM focowiki.bundle_files file
        WHERE file.knowledge_base_id = 'kb-okf-scale'
          AND file.release_id = 'release-okf-scale'
          AND file.logical_path LIKE '%.md'
          AND file.logical_path <> 'log.md'
          AND file.logical_path !~ '(^|/)index\\.md$'
          AND NULLIF(btrim(file.okf_type), '') IS NULL
        ORDER BY file.logical_path ASC
        LIMIT 101
      `
    },
    {
      name: "release-validation-generated-target",
      description: "Generated navigation links must resolve through the release logical-path index.",
      sql: `
        SELECT link.from_path
        FROM focowiki.release_markdown_links link
        LEFT JOIN focowiki.bundle_files target
          ON target.knowledge_base_id = link.knowledge_base_id
         AND target.release_id = link.release_id
         AND target.logical_path = link.to_path
        WHERE link.knowledge_base_id = 'kb-okf-scale'
          AND link.release_id = 'release-okf-scale'
          AND link.navigation_only = true
          AND target.id IS NULL
        ORDER BY link.from_path ASC, link.to_path ASC
        LIMIT 101
      `
    },
    {
      name: "release-validation-continuation-chain",
      description: "Continuation concepts must have one release-scoped incoming navigation link.",
      sql: `
        SELECT continuation.logical_path
        FROM focowiki.bundle_files continuation
        WHERE continuation.knowledge_base_id = 'kb-okf-scale'
          AND continuation.release_id = 'release-okf-scale'
          AND continuation.file_kind IN (
            'history_page', 'directory_index_page', 'directory_index_map'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM focowiki.release_markdown_links link
            JOIN focowiki.bundle_files source
              ON source.knowledge_base_id = link.knowledge_base_id
             AND source.release_id = link.release_id
             AND source.logical_path = link.from_path
            WHERE link.knowledge_base_id = continuation.knowledge_base_id
              AND link.release_id = continuation.release_id
              AND link.to_path = continuation.logical_path
              AND link.navigation_only = true
              AND (
                (continuation.file_kind = 'history_page'
                  AND source.file_kind IN ('log', 'history_page'))
                OR
                (continuation.file_kind IN ('directory_index_page', 'directory_index_map')
                  AND source.file_kind IN (
                    'directory_index', 'directory_index_page', 'directory_index_map'
                  ))
              )
          )
        ORDER BY continuation.logical_path ASC
        LIMIT 101
      `
    },
    {
      name: "release-validation-index-coverage",
      description: "Every source-backed page must have exactly one directory-navigation link.",
      sql: `
        SELECT page.logical_path
        FROM focowiki.bundle_files page
        LEFT JOIN focowiki.release_markdown_links link
          ON link.knowledge_base_id = page.knowledge_base_id
         AND link.release_id = page.release_id
         AND link.to_path = page.logical_path
         AND link.navigation_only = true
        LEFT JOIN focowiki.bundle_files source
          ON source.knowledge_base_id = link.knowledge_base_id
         AND source.release_id = link.release_id
         AND source.logical_path = link.from_path
         AND source.file_kind IN ('directory_index', 'directory_index_page')
        WHERE page.knowledge_base_id = 'kb-okf-scale'
          AND page.release_id = 'release-okf-scale'
          AND page.file_kind = 'page'
        GROUP BY page.logical_path
        HAVING count(source.id) <> 1
        ORDER BY page.logical_path ASC
        LIMIT 101
      `
    }
  ];
}

function readExplainRecord(planJson: unknown): JsonExplainRecord {
  if (Array.isArray(planJson)) {
    const first = planJson[0];
    return first && typeof first === "object" ? (first as JsonExplainRecord) : {};
  }

  return planJson && typeof planJson === "object" ? (planJson as JsonExplainRecord) : {};
}

function collectPlanNode(node: unknown, visitor: (node: JsonPlanNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const planNode = node as JsonPlanNode;
  visitor(planNode);

  if (!Array.isArray(planNode.Plans)) {
    return;
  }

  for (const child of planNode.Plans) {
    collectPlanNode(child, visitor);
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
