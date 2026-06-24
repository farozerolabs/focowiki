export type QueryPlanTargetName =
  | "source-file-list"
  | "bundle-tree-page"
  | "bundle-file-content"
  | "source-file-graph-summary";

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
      name: "source-file-list",
      description: "Source-file cursor page must use knowledge-base scoped created_at/id indexes.",
      sql: `
        SELECT id, knowledge_base_id, original_name, processing_status, processing_stage,
               generated_output_status, generated_bundle_file_id, generated_bundle_file_path,
               model_invocation_status, model_invocation_model_name, created_at, deleted_at
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND deleted_at IS NULL
        ORDER BY created_at DESC, id ASC
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
      name: "source-file-graph-summary",
      description: "Graph summary detail must read one source-file summary row.",
      sql: `
        SELECT graph_relationship_count, graph_top_relationships_json
        FROM focowiki.source_files
        WHERE knowledge_base_id = 'kb-plan'
          AND id = 'source-file-plan'
          AND deleted_at IS NULL
        LIMIT 1
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
