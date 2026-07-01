export type QueryPlanTargetName =
  | "knowledge-base-card-search"
  | "source-file-list"
  | "source-file-list-filename-filter"
  | "source-file-list-status-stage-filter"
  | "source-file-list-time-filter"
  | "source-file-list-error-filter"
  | "source-file-list-model-filter"
  | "source-file-list-action-filter"
  | "worker-job-source-cancellation"
  | "bundle-tree-page"
  | "bundle-tree-search-name"
  | "bundle-tree-search-path"
  | "bundle-tree-search-next-page"
  | "bundle-tree-search-ancestors"
  | "bundle-file-content"
  | "generated-file-search-first-page"
  | "generated-file-search-next-page"
  | "generated-file-search-no-result"
  | "generated-file-search-kind-filter"
  | "generated-file-search-cache-hit"
  | "source-file-graph-summary"
  | "hard-delete-source-search-documents"
  | "hard-delete-source-tree-entries"
  | "hard-delete-source-bundle-files"
  | "hard-delete-source-worker-jobs"
  | "hard-delete-knowledge-base-search-documents"
  | "hard-delete-knowledge-base-tree-entries"
  | "hard-delete-knowledge-base-bundle-files"
  | "hard-delete-knowledge-base-source-files"
  | "hard-delete-knowledge-base-worker-jobs";

export type QueryPlanTarget = {
  name: QueryPlanTargetName;
  description: string;
  sql: string;
};

export type QueryPlanSummary = {
  nodeTypes: string[];
  relationNames: string[];
  hasSequentialScan: boolean;
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
};

type JsonPlanNode = {
  "Node Type"?: unknown;
  "Relation Name"?: unknown;
  "Shared Hit Blocks"?: unknown;
  "Shared Read Blocks"?: unknown;
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
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;

  collectPlanNode(record.Plan, (node) => {
    const nodeType = readString(node["Node Type"]);
    const relationName = readString(node["Relation Name"]);

    if (nodeType) {
      nodeTypes.add(nodeType);
    }

    if (relationName) {
      relationNames.add(relationName);
    }

    sharedHitBlocks += readNumber(node["Shared Hit Blocks"]) ?? 0;
    sharedReadBlocks += readNumber(node["Shared Read Blocks"]) ?? 0;
  });

  return {
    nodeTypes: [...nodeTypes],
    relationNames: [...relationNames],
    hasSequentialScan: nodeTypes.has("Seq Scan"),
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
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
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
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
               generated_output_status, model_invocation_status, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
          AND task_deleted_at IS NULL
          AND original_name ILIKE '%example%'
        ORDER BY created_at DESC, id ASC
        LIMIT 51
      `
    },
    {
      name: "source-file-list-status-stage-filter",
      description: "Source-file status and stage filters must use knowledge-base scoped processing indexes.",
      sql: `
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
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
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
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
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
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
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
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
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
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
      name: "bundle-tree-page",
      description: "Active release tree page must use release and parent scoped tree indexes.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path,
               entry.name, entry.logical_path, entry.sort_key, entry.entry_type,
               entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
        FROM focowiki.bundle_tree_entries entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND entry.parent_path = ''
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "bundle-tree-search-name",
      description: "Active release tree search by name must use indexed release-scoped search.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path,
               entry.name, entry.logical_path, entry.sort_key, entry.entry_type,
               entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
        FROM focowiki.bundle_tree_entries entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND (entry.name || ' ' || entry.logical_path) ILIKE '%example%' ESCAPE '\\'
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "bundle-tree-search-path",
      description: "Active release tree search by logical path must use indexed release-scoped search.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path,
               entry.name, entry.logical_path, entry.sort_key, entry.entry_type,
               entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
        FROM focowiki.bundle_tree_entries entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND (entry.name || ' ' || entry.logical_path) ILIKE '%pages/example%' ESCAPE '\\'
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "bundle-tree-search-next-page",
      description: "Active release tree search next page must use cursor seek rather than offset.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path,
               entry.name, entry.logical_path, entry.sort_key, entry.entry_type,
               entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
        FROM focowiki.bundle_tree_entries entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND (entry.name || ' ' || entry.logical_path) ILIKE '%example%' ESCAPE '\\'
          AND (entry.sort_key > '1:example.md' OR (entry.sort_key = '1:example.md' AND entry.id > 'tree-entry-plan'))
        ORDER BY entry.sort_key ASC, entry.id ASC
        LIMIT 51
      `
    },
    {
      name: "bundle-tree-search-ancestors",
      description: "Search result ancestor lookup must fetch only returned match ancestors.",
      sql: `
        SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path,
               entry.name, entry.logical_path, entry.sort_key, entry.entry_type,
               entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
        FROM focowiki.bundle_tree_entries entry
        LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
        WHERE entry.knowledge_base_id = 'kb-plan'
          AND entry.release_id = 'release-plan'
          AND entry.logical_path = ANY(ARRAY['pages', 'pages/guides'])
        ORDER BY entry.logical_path ASC
      `
    },
    {
      name: "bundle-file-content",
      description: "Generated content lookup must resolve one active-release bundle file.",
      sql: `
        SELECT id, knowledge_base_id, release_id, logical_path, object_key, source_file_id, file_kind
        FROM focowiki.bundle_files
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND logical_path = 'pages/example.md'
        LIMIT 1
      `
    },
    {
      name: "generated-file-search-first-page",
      description: "Developer file search first page must use compact active-release search documents.",
      sql: `
        SELECT bundle_file_id, source_file_id, file_kind, logical_path, title, description, tags_json
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND removed_at IS NULL
          AND file_kind = 'page'
          AND search_text ILIKE '%example%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 51
      `
    },
    {
      name: "generated-file-search-next-page",
      description: "Developer file search next page must use cursor seek over bounded search documents.",
      sql: `
        SELECT bundle_file_id, source_file_id, file_kind, logical_path, title, description, tags_json
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND removed_at IS NULL
          AND file_kind = 'page'
          AND search_text ILIKE '%example%' ESCAPE '\\'
          AND (logical_path > 'pages/example.md' OR (logical_path = 'pages/example.md' AND bundle_file_id > 'bundle-file-plan'))
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 51
      `
    },
    {
      name: "generated-file-search-no-result",
      description: "Developer file search no-result checks must stay bounded on compact search documents.",
      sql: `
        SELECT bundle_file_id, source_file_id, file_kind, logical_path, title, description, tags_json
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND removed_at IS NULL
          AND file_kind = 'page'
          AND search_text ILIKE '%no-such-file%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 51
      `
    },
    {
      name: "generated-file-search-kind-filter",
      description: "Developer file search kind filter must use release and file-kind scoped search indexes.",
      sql: `
        SELECT bundle_file_id, source_file_id, file_kind, logical_path, title, description, tags_json
        FROM focowiki.bundle_file_search_documents
        WHERE knowledge_base_id = 'kb-plan'
          AND release_id = 'release-plan'
          AND removed_at IS NULL
          AND file_kind = 'schema'
          AND search_text ILIKE '%schema%' ESCAPE '\\'
        ORDER BY logical_path ASC, bundle_file_id ASC
        LIMIT 51
      `
    },
    {
      name: "generated-file-search-cache-hit",
      description: "Developer file search cache hits must not require database search SQL.",
      sql: `
        SELECT 1
        FROM focowiki.bundle_file_search_documents
        WHERE false
        LIMIT 0
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
    }
  ];
}

export function createHardDeletePlanTargets(): QueryPlanTarget[] {
  return [
    {
      name: "hard-delete-source-search-documents",
      description: "Source-file hard delete search-document cleanup must stay source scoped.",
      sql: `
        WITH target AS (
          SELECT release_id, bundle_file_id
          FROM focowiki.bundle_file_search_documents
          WHERE knowledge_base_id = 'kb-plan'
            AND source_file_id = 'source-file-plan'
          ORDER BY bundle_file_id ASC
          LIMIT 100
        )
        SELECT document.bundle_file_id
        FROM focowiki.bundle_file_search_documents document
        JOIN target
          ON document.release_id = target.release_id
         AND document.bundle_file_id = target.bundle_file_id
      `
    },
    {
      name: "hard-delete-source-tree-entries",
      description: "Source-file hard delete tree cleanup must resolve entries through owned bundle files.",
      sql: `
        WITH target AS (
          SELECT entry.id
          FROM focowiki.bundle_tree_entries entry
          JOIN focowiki.bundle_files bundle
            ON bundle.id = entry.bundle_file_id
          WHERE bundle.knowledge_base_id = 'kb-plan'
            AND bundle.source_file_id = 'source-file-plan'
          ORDER BY entry.id ASC
          LIMIT 100
        )
        SELECT entry.id
        FROM focowiki.bundle_tree_entries entry
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
      name: "hard-delete-knowledge-base-search-documents",
      description: "Knowledge-base hard delete search cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT release_id, bundle_file_id
          FROM focowiki.bundle_file_search_documents
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY bundle_file_id ASC
          LIMIT 100
        )
        SELECT document.bundle_file_id
        FROM focowiki.bundle_file_search_documents document
        JOIN target
          ON document.release_id = target.release_id
         AND document.bundle_file_id = target.bundle_file_id
      `
    },
    {
      name: "hard-delete-knowledge-base-tree-entries",
      description: "Knowledge-base hard delete tree cleanup must stay knowledge-base scoped.",
      sql: `
        WITH target AS (
          SELECT id
          FROM focowiki.bundle_tree_entries
          WHERE knowledge_base_id = 'kb-plan'
          ORDER BY id ASC
          LIMIT 100
        )
        SELECT entry.id
        FROM focowiki.bundle_tree_entries entry
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
