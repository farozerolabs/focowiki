import { buildGraphQueryTerms } from "../graph/graph-term-document.js";
import {
  GRAPH_COMMON_TERM_ABSOLUTE_MAX_DOCUMENTS,
  GRAPH_COMMON_TERM_MAX_DOCUMENT_RATIO,
  GRAPH_LEXICAL_QUERY_TERM_LIMIT,
  GRAPH_QUERY_TERM_LIMIT
} from "../graph/graph-term-frequency.js";

export type QueryPlanTargetName =
  | "knowledge-base-card-search"
  | "source-file-list"
  | "source-file-event-page"
  | "source-resource-list-filter"
  | "resource-operation-page"
  | "active-generation-resolve"
  | "active-file-by-id"
  | "active-file-by-path"
  | "active-file-metadata-by-source"
  | "active-tree-page"
  | "active-tree-search"
  | "active-file-search"
  | "active-graph-search"
  | "active-related-page"
  | "graph-candidate-terms"
  | "role-job-source-cancellation"
  | "role-job-claim"
  | "source-dispatch-claim"
  | "publication-impact-claim"
  | "publication-progress-summary"
  | "optimization-migration-progress-summary"
  | "projection-compaction-active-summary"
  | "projection-compaction-completed-summary"
  | "generation-freeze"
  | "generation-validation-ref-page"
  | "generation-validation-projection-page"
  | "cleanup-object-page"
  | "immutable-object-gc-claim";

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
  if (!normalized) throw new Error("Query plan SQL must not be empty");
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
    if (nodeType) nodeTypes.add(nodeType);
    if (relationName) {
      relationNames.add(relationName);
      if (nodeType === "Seq Scan") sequentialScanRelations.add(relationName);
    }
    if (indexName) indexNames.add(indexName);
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
    target("knowledge-base-card-search", "Knowledge-base search stays indexed and bounded.", `
      SELECT id, name, description, active_generation_id, created_at, updated_at
      FROM focowiki.knowledge_bases
      WHERE deleted_at IS NULL
        AND lower(id || ' ' || name || ' ' || coalesce(description, '')) LIKE '%docs%'
      ORDER BY created_at DESC, id ASC
      LIMIT 51
    `),
    target("source-file-list", "Source-file task pages use a scoped keyset cursor.", `
      SELECT id, relative_path, processing_status, processing_stage,
             generated_output_status, model_invocation_status, created_at
      FROM focowiki.source_files
      WHERE knowledge_base_id = 'kb-plan'
        AND deleted_at IS NULL
        AND task_deleted_at IS NULL
      ORDER BY created_at DESC, id ASC
      LIMIT 51
    `),
    target("source-file-event-page", "Source-file events use a resource-scoped keyset cursor.", `
      SELECT id, stage_key, message_key, started_at, ended_at, severity, created_at
      FROM focowiki.source_file_events
      WHERE knowledge_base_id = 'kb-plan'
        AND source_file_id = 'source-file-plan'
        AND (created_at, id) > ('2026-01-01T00:00:00.000Z', 'source-event-plan')
      ORDER BY created_at, id
      LIMIT 51
    `),
    target("source-resource-list-filter", "Source-resource filters execute before bounded pagination.", `
      SELECT id, directory_id, name, relative_path, processing_status,
             processing_stage, generated_output_status, resource_revision, content_revision
      FROM focowiki.source_files
      WHERE knowledge_base_id = 'kb-plan'
        AND deleted_at IS NULL
        AND deletion_intent_id IS NULL
        AND relative_path ILIKE '%guide%'
        AND processing_status = 'completed'
        AND id > 'source-file-plan'
      ORDER BY id
      LIMIT 51
    `),
    target("resource-operation-page", "Resource operations use knowledge-base scoped keyset pagination.", `
      SELECT operation.id, operation.operation_kind, operation.state,
             operation.candidate_catalog_generation
      FROM focowiki.resource_operations operation
      WHERE operation.knowledge_base_id = 'kb-plan'
        AND operation.id > 'operation-plan'
      ORDER BY operation.id
      LIMIT 51
    `),
    target("active-generation-resolve", "Every generated read resolves one active generation.", `
      SELECT active_generation_id
      FROM focowiki.knowledge_bases
      WHERE id = 'kb-plan' AND deleted_at IS NULL
      LIMIT 1
    `),
    target("active-file-by-id", "Generated content resolves directly through the active object file identity.", `
      SELECT reference.file_id, reference.logical_path, object.object_key,
             object.content_type, object.size_bytes, object.checksum_sha256
      FROM focowiki.active_object_refs reference
      JOIN focowiki.immutable_objects object
        ON object.checksum_sha256 = reference.checksum_sha256
       AND object.format_version = reference.format_version
      WHERE reference.knowledge_base_id = 'kb-plan'
        AND reference.file_id = 'bundle-file-plan'
      LIMIT 1
    `),
    target("active-file-by-path", "Generated content resolves directly through the active object catalog.", `
      SELECT reference.file_id, reference.logical_path, object.object_key,
             object.content_type, object.size_bytes, object.checksum_sha256
      FROM focowiki.active_object_refs reference
      JOIN focowiki.immutable_objects object
        ON object.checksum_sha256 = reference.checksum_sha256
       AND object.format_version = reference.format_version
      WHERE reference.knowledge_base_id = 'kb-plan'
        AND reference.logical_path = 'pages/example.md'
      LIMIT 1
    `),
    target("active-file-metadata-by-source", "Generated file metadata resolves from one active search record.", `
      SELECT record_id, title, summary, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = 'kb-plan'
        AND projection_kind = 'search'
        AND source_file_id = 'source-file-plan'
      ORDER BY record_id
      LIMIT 1
    `),
    target("active-tree-page", "Tree children use active projection keyset pagination.", `
      SELECT record_id, source_file_id, logical_path, parent_path, sort_key,
             title, summary, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = 'kb-plan'
        AND projection_kind = 'tree'
        AND coalesce(parent_path, '') = 'pages'
        AND (coalesce(sort_key, ''), record_id) > ('entry-plan', 'record-plan')
      ORDER BY coalesce(sort_key, ''), record_id
      LIMIT 51
    `),
    target("active-tree-search", "Tree search uses bounded active projection text lookup.", `
      SELECT record_id, logical_path, title, summary, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = 'kb-plan'
        AND projection_kind = 'tree'
        AND lower(coalesce(title, '') || ' ' || coalesce(logical_path, ''))
          LIKE '%example%'
      ORDER BY coalesce(sort_key, ''), record_id
      LIMIT 51
    `),
    target("active-file-search", "File search reads active search projections and direct page references.", `
      SELECT record.record_id, record.source_file_id, file.file_id,
             file.logical_path, record.title, record.summary
      FROM focowiki.active_projection_records record
      JOIN focowiki.active_object_refs file
        ON file.knowledge_base_id = record.knowledge_base_id
       AND file.source_file_id = record.source_file_id
       AND file.ref_kind = 'page'
      WHERE record.knowledge_base_id = 'kb-plan'
        AND record.projection_kind = 'search'
        AND lower(coalesce(record.searchable_text, '')) LIKE '%example%'
      ORDER BY record.record_id
      LIMIT 51
    `),
    target("active-graph-search", "Graph search reads active graph projections with direct page continuity.", `
      SELECT record.record_id, record.source_file_id, file.file_id,
             file.logical_path, record.title, record.summary
      FROM focowiki.active_projection_records record
      JOIN focowiki.active_object_refs file
        ON file.knowledge_base_id = record.knowledge_base_id
       AND file.source_file_id = record.source_file_id
       AND file.ref_kind = 'page'
      WHERE record.knowledge_base_id = 'kb-plan'
        AND record.projection_kind IN ('graph_node', 'graph_edge')
        AND lower(coalesce(record.searchable_text, '')) LIKE '%example%'
      ORDER BY record.record_id
      LIMIT 51
    `),
    target("active-related-page", "Related-file traversal stays edge scoped and cursor bounded.", `
      SELECT record_id, source_file_id, related_source_file_id, title, summary, payload_json
      FROM focowiki.active_projection_records
      WHERE knowledge_base_id = 'kb-plan'
        AND projection_kind = 'graph_edge'
        AND (source_file_id = 'source-file-plan'
          OR related_source_file_id = 'source-file-plan')
        AND record_id > 'graph-edge-plan'
      ORDER BY record_id
      LIMIT 51
    `)
  ];
}

export function createMaintenanceProgressPlanTargets(): QueryPlanTarget[] {
  return [
    target("optimization-migration-progress-summary", "Migration progress resolves by knowledge-base primary key.", `
      SELECT state, phase, attempt_count, max_attempts, started_at,
             updated_at, completed_at, last_error_code, last_error_message
      FROM focowiki.knowledge_base_optimization_migrations
      WHERE knowledge_base_id = 'kb-plan'
    `),
    target("projection-compaction-active-summary", "Active compaction progress resolves from one partial-index row.", `
      SELECT state, attempt_count, max_attempts, created_at, updated_at,
             completed_at, last_error_code
      FROM focowiki.projection_compaction_jobs
      WHERE knowledge_base_id = 'kb-plan'
        AND state IN ('pending', 'running', 'failed')
      ORDER BY updated_at DESC, id
      LIMIT 1
    `),
    target("projection-compaction-completed-summary", "Completed compaction progress resolves from one partial-index row.", `
      SELECT state, attempt_count, max_attempts, created_at, updated_at,
             completed_at, last_error_code
      FROM focowiki.projection_compaction_jobs
      WHERE knowledge_base_id = 'kb-plan'
        AND state IN ('completed', 'superseded')
      ORDER BY updated_at DESC, id
      LIMIT 1
    `)
  ];
}

export function createGraphCandidatePlanTarget(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  terms: string[];
  limit: number;
}): QueryPlanTarget {
  const terms = buildGraphQueryTerms(input.terms.slice(0, 100));
  const sqlTerms = terms.exactTerms.map(sqlLiteral).join(", ");
  const sqlPhrases = terms.phraseTerms.map(sqlLiteral).join(", ");
  const sqlReferences = terms.explicitReferences.map(sqlLiteral).join(", ");
  const optionalMatches = [
    terms.phraseTerms.length > 0 ? `
      UNION ALL
      SELECT document.source_file_id
      FROM focowiki.source_file_graph_term_documents document
      CROSS JOIN bounded_query query
      WHERE document.knowledge_base_id = ${sqlLiteral(input.knowledgeBaseId)}
        AND document.source_file_id <> ${sqlLiteral(input.sourceFileId)}
        AND document.phrase_terms && ARRAY[${sqlPhrases}]::text[]
        AND cardinality(query.exact_terms) > 0
        AND document.exact_terms && query.exact_terms
    ` : "",
    terms.explicitReferences.length > 0 ? `
      UNION ALL
      SELECT document.source_file_id
      FROM focowiki.source_file_graph_term_documents document
      WHERE document.knowledge_base_id = ${sqlLiteral(input.knowledgeBaseId)}
        AND document.source_file_id <> ${sqlLiteral(input.sourceFileId)}
        AND document.explicit_references && ARRAY[${sqlReferences}]::text[]
    ` : ""
  ].join("");

  return target("graph-candidate-terms", "Graph candidates use indexed body-derived terms.", `
    WITH query_term_frequencies AS MATERIALIZED (
      SELECT frequency.term, sum(frequency.document_count)::bigint AS document_count
      FROM focowiki.source_file_graph_term_frequencies frequency
      WHERE frequency.knowledge_base_id = ${sqlLiteral(input.knowledgeBaseId)}
        AND frequency.term = ANY(ARRAY[${sqlTerms}]::text[])
      GROUP BY frequency.term
    ), selected_query_terms AS MATERIALIZED (
      SELECT query_term.term,
             coalesce(frequency.document_count, 0)::bigint AS document_count
      FROM unnest(ARRAY[${sqlTerms}]::text[]) AS query_term(term)
      LEFT JOIN query_term_frequencies frequency
        ON frequency.term = query_term.term
      LEFT JOIN (
        SELECT coalesce(sum(source_file_count), 0)::bigint AS source_file_count
        FROM focowiki.knowledge_base_incremental_stat_shards
        WHERE knowledge_base_id = ${sqlLiteral(input.knowledgeBaseId)}
      ) stats ON true
      WHERE coalesce(frequency.document_count, 0) <= greatest(
        1::bigint,
        least(
          ${GRAPH_COMMON_TERM_ABSOLUTE_MAX_DOCUMENTS}::bigint,
          ceil(
            coalesce(stats.source_file_count, 0)
            * ${GRAPH_COMMON_TERM_MAX_DOCUMENT_RATIO}::numeric
          )::bigint
        )
      )
      ORDER BY coalesce(frequency.document_count, 0), query_term.term
      LIMIT ${GRAPH_QUERY_TERM_LIMIT}
    ), bounded_query AS MATERIALIZED (
      SELECT coalesce(
               array_agg(term ORDER BY document_count, term),
               ARRAY[]::text[]
             ) AS exact_terms,
             coalesce(
               array_to_string(
                 (array_agg(term ORDER BY document_count, term))
                   [1:${GRAPH_LEXICAL_QUERY_TERM_LIMIT}],
                 ' '
               ),
               ''
             ) AS lexical_text
      FROM selected_query_terms
    ), candidate_matches AS MATERIALIZED (
      SELECT document.source_file_id
      FROM focowiki.source_file_graph_term_documents document
      CROSS JOIN bounded_query query
      WHERE document.knowledge_base_id = ${sqlLiteral(input.knowledgeBaseId)}
        AND document.source_file_id <> ${sqlLiteral(input.sourceFileId)}
        AND cardinality(query.exact_terms) > 0
        AND document.exact_terms && query.exact_terms
      ${optionalMatches}
      UNION ALL
      SELECT document.source_file_id
      FROM focowiki.source_file_graph_term_documents document
      CROSS JOIN bounded_query query
      WHERE document.knowledge_base_id = ${sqlLiteral(input.knowledgeBaseId)}
        AND document.source_file_id <> ${sqlLiteral(input.sourceFileId)}
        AND query.lexical_text <> ''
        AND document.lexical_vector @@ websearch_to_tsquery('simple', query.lexical_text)
    )
    SELECT candidate.source_file_id
    FROM candidate_matches candidate
    GROUP BY candidate.source_file_id
    ORDER BY candidate.source_file_id
    LIMIT ${Math.max(1, Math.min(1_000, input.limit))}
  `);
}

export function createRoleQueuePlanTargets(): QueryPlanTarget[] {
  return [
    target("role-job-source-cancellation", "Deletion cancels only selected source role jobs.", `
      SELECT id
      FROM focowiki.role_jobs
      WHERE knowledge_base_id = 'kb-plan'
        AND role = 'source'
        AND source_file_id = ANY(ARRAY['source-file-plan-a', 'source-file-plan-b'])
        AND status IN ('queued', 'running')
      ORDER BY run_after, created_at, id
      LIMIT 51
    `),
    target("role-job-claim", "Each worker role claims a bounded deterministic job page.", `
      SELECT id
      FROM focowiki.role_jobs
      WHERE role = 'publication'
        AND run_after <= '2026-01-01T00:00:00.000Z'
        AND status IN ('queued', 'running')
      ORDER BY run_after, created_at, id
      LIMIT 16
      FOR UPDATE SKIP LOCKED
    `),
    target("source-dispatch-claim", "Dispatch markers are claimed in sequence order without backlog materialization.", `
      SELECT id, knowledge_base_id, source_file_id, source_revision_id
      FROM focowiki.source_dispatch_markers
      WHERE status = 'pending'
        AND run_after <= '2026-01-01T00:00:00.000Z'
      ORDER BY sequence_number, id
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `),
    target("publication-impact-claim", "Publication workers claim only one bounded generation impact page.", `
      SELECT id, projection_kind, projection_key, record_identity, action
      FROM focowiki.publication_impacts
      WHERE knowledge_base_id = 'kb-plan'
        AND generation_id = 'generation-plan'
        AND status = 'pending'
        AND run_after <= '2026-01-01T00:00:00.000Z'
      ORDER BY projection_kind, projection_key, record_identity, id
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `),
    target("publication-progress-summary", "Admin progress reads one persisted generation summary.", `
      SELECT stage, processed_impact_count, total_impact_count, touched_shard_count,
             oldest_dirty_at, heartbeat_at, last_success_at, safe_error_code
      FROM focowiki.publication_progress
      WHERE knowledge_base_id = 'kb-plan'
        AND generation_id = 'generation-plan'
      LIMIT 1
    `),
    target("generation-freeze", "Generation freeze locks one open generation for a knowledge base.", `
      SELECT id, predecessor_generation_id, state, created_at
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = 'kb-plan' AND state = 'open'
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE
    `)
  ];
}

export function createGenerationValidationPlanTargets(): QueryPlanTarget[] {
  return [
    target("generation-validation-ref-page", "Generation validation scans only changed object references in bounded pages.", `
      SELECT ref_kind, ref_key, logical_path, checksum_sha256, format_version
      FROM focowiki.generation_object_refs
      WHERE knowledge_base_id = 'kb-plan'
        AND generation_id = 'generation-plan'
        AND (ref_kind, ref_key) > ('page', 'ref-plan')
      ORDER BY ref_kind, ref_key
      LIMIT 101
    `),
    target("generation-validation-projection-page", "Generation validation scans only changed projection records in bounded pages.", `
      SELECT projection_kind, record_id, source_file_id, logical_path, payload_json
      FROM focowiki.generation_projection_records
      WHERE knowledge_base_id = 'kb-plan'
        AND generation_id = 'generation-plan'
        AND (projection_kind, record_id) > ('search', 'record-plan')
      ORDER BY projection_kind, record_id
      LIMIT 101
    `)
  ];
}

export function createCleanupPlanTargets(): QueryPlanTarget[] {
  return [
    target("cleanup-object-page", "Cleanup deletes one persisted object-key page at a time.", `
      SELECT object_key
      FROM focowiki.cleanup_object_deletions
      WHERE job_id = 'role-job-cleanup-plan' AND status = 'pending'
      ORDER BY object_key
      LIMIT 100
    `),
    target("immutable-object-gc-claim", "Garbage collection claims only unreferenced immutable objects in a bounded page.", `
      SELECT object.checksum_sha256, object.format_version, object.object_key
      FROM focowiki.immutable_objects object
      WHERE object.lifecycle_state = 'active'
        AND object.created_at < '2026-01-01T00:00:00.000Z'
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
      ORDER BY object.checksum_sha256, object.format_version
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `)
  ];
}

function target(name: QueryPlanTargetName, description: string, sql: string): QueryPlanTarget {
  return { name, description, sql };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readExplainRecord(planJson: unknown): JsonExplainRecord {
  if (Array.isArray(planJson)) {
    const first = planJson[0];
    return first && typeof first === "object" ? first as JsonExplainRecord : {};
  }
  return planJson && typeof planJson === "object" ? planJson as JsonExplainRecord : {};
}

function collectPlanNode(node: unknown, visitor: (node: JsonPlanNode) => void): void {
  if (!node || typeof node !== "object") return;
  const planNode = node as JsonPlanNode;
  visitor(planNode);
  if (!Array.isArray(planNode.Plans)) return;
  for (const child of planNode.Plans) collectPlanNode(child, visitor);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
