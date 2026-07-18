import type {
  OkfGraphNode,
  OkfGraphRelationship,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";
import type { TransactionSql } from "postgres";
import type {
  PublicationDirectorySnapshot,
  PublicationGraphEdgeSnapshot,
  PublicationKnowledgeBaseSnapshot,
  PublicationNavigationTarget,
  PublicationProjectionInput,
  PublicationSourceSnapshot
} from "../../application/ports/publication-projection-input.js";
import { toProjectionInputJson } from "../../application/ports/publication-projection-input.js";
import type { ChangeFactKind } from "../../domain/generation.js";
import { generatedPagePath } from "../../domain/source-path.js";
import type { PublicationImpact } from "../../publication/impact-planner.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import { createDirectoryStatistics } from "../../domain/tree-statistics.js";

const MAX_SNAPSHOT_RELATIONSHIPS = 100;

type SourceRow = {
  source_file_id: string;
  source_revision_id: string;
  resource_revision: number;
  name: string;
  relative_path: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  metadata_json: SourceMetadataDefaults;
  model_suggestions_json: SourceModelSuggestions | null;
  node_title: string | null;
  node_type: string | null;
  node_description: string | null;
  node_summary: string | null;
  node_subjects: string[] | null;
  node_tags: string[] | null;
  node_entities: string[] | null;
  node_explicit_references: string[] | null;
  node_relationship_hints: string[] | null;
  node_headings: string[] | null;
  node_keywords: string[] | null;
  node_language: string | null;
  node_profile_version: string | null;
  node_profile_source: string | null;
  node_metadata: Record<string, unknown> | null;
};

type RelationshipRow = {
  source_file_id: string;
  related_source_file_id: string;
  direction: "outgoing" | "incoming";
  path: string;
  title: string;
  relation_type: string;
  weight: number;
  reason: string;
  source: string;
  evidence_json: Record<string, unknown>;
};

type EdgeRow = {
  id: string;
  from_source_file_id: string;
  from_path: string;
  from_title: string;
  to_source_file_id: string;
  to_path: string;
  to_title: string;
  relation_type: string;
  weight: number;
  reason: string;
  source: string;
  evidence_json: Record<string, unknown>;
};

type DirectoryRow = {
  relative_path: string;
  id: string;
  name: string;
  resource_revision: number;
  direct_directory_count: number;
  direct_file_count: number;
  descendant_file_count: number;
};

export type CapturedProjectionInput = {
  inputKey: string;
  payload: SerializableJson;
};

export async function capturePublicationProjectionInputs(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    generationId: string;
    changeKind: ChangeFactKind;
    sourceFileId: string | null;
    sourceRevisionId: string | null;
    previousPath: string | null;
    path: string | null;
    impacts: PublicationImpact[];
    now: string;
  }
): Promise<Map<string, CapturedProjectionInput>> {
  const sourceIds = unique(input.impacts.flatMap((impact) =>
    requiresSourceInput(impact) ? [impact.recordIdentity] : []
  ));
  const edgeIds = unique(input.impacts.flatMap((impact) =>
    requiresGraphEdgeInput(impact) ? [impact.recordIdentity] : []
  ));
  const directoryPaths = unique(input.impacts.flatMap((impact) =>
    requiresDirectoryInput(impact)
      ? [impact.recordIdentity.slice("directory:".length)]
      : []
  ));
  const sourceInputs = await captureSources(transaction, input, sourceIds);
  const edgeInputs = await captureGraphEdges(transaction, input.knowledgeBaseId, edgeIds);
  const directoryInputs = await captureDirectories(
    transaction,
    input.knowledgeBaseId,
    directoryPaths
  );
  const knowledgeBaseInput = input.impacts.some((impact) => impact.projectionKind === "root")
    || directoryPaths.includes("")
    ? await captureKnowledgeBase(transaction, input.knowledgeBaseId)
    : null;
  const result = new Map<string, CapturedProjectionInput>();

  for (const impact of input.impacts) {
    let projectionInput: PublicationProjectionInput | null = null;
    if (requiresSourceInput(impact)) {
      projectionInput = sourceInputs.get(impact.recordIdentity) ?? null;
    } else if (requiresGraphEdgeInput(impact)) {
      const edge = edgeInputs.get(impact.recordIdentity);
      projectionInput = edge ? { kind: "graph_edge", edge } : null;
    } else if (requiresDirectoryInput(impact)) {
      const relativePath = impact.recordIdentity.slice("directory:".length);
      const directory = relativePath
        ? directoryInputs.get(relativePath) ?? null
        : rootDirectorySnapshot(knowledgeBaseInput);
      projectionInput = directory
        ? { kind: "directory", directory }
        : { kind: "empty" };
    } else if (impact.projectionKind === "directory") {
      projectionInput = {
        kind: "navigation",
        targets: buildNavigationTargets({ ...input, impact })
      };
    } else if (impact.projectionKind === "root" && knowledgeBaseInput) {
      projectionInput = {
        kind: "knowledge_base",
        descriptor: knowledgeBaseInput.descriptor,
        rootEntryCount: knowledgeBaseInput.rootEntryCount
      };
    }

    if (!projectionInput && impact.action !== "delete" && impact.projectionKind !== "cleanup") {
      throw new Error(
        `Publication projection input is unavailable for ${impact.projectionKind}:${impact.recordIdentity}`
      );
    }
    if (!projectionInput) continue;
    result.set(impact.id, {
      inputKey: projectionInputKey(impact),
      payload: toProjectionInputJson(projectionInput)
    });
  }

  return result;
}

export async function persistCapturedProjectionInputs(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    generationId: string;
    captured: Map<string, CapturedProjectionInput>;
    now: string;
  }
): Promise<void> {
  const uniqueInputs = new Map<string, SerializableJson>();
  for (const item of input.captured.values()) uniqueInputs.set(item.inputKey, item.payload);
  for (const [inputKey, payload] of uniqueInputs) {
    await transaction`
      INSERT INTO focowiki.publication_projection_inputs (
        knowledge_base_id, generation_id, input_key, payload_json, created_at, updated_at
      ) VALUES (
        ${input.knowledgeBaseId}, ${input.generationId}, ${inputKey},
        ${transaction.json(payload as never)}, ${input.now}, ${input.now}
      )
      ON CONFLICT (generation_id, input_key) DO UPDATE
      SET payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at
    `;
  }
}

function requiresSourceInput(impact: PublicationImpact): boolean {
  if (impact.action === "delete") return false;
  if (impact.projectionKind === "tree") {
    return !impact.recordIdentity.startsWith("directory:");
  }
  return [
    "page",
    "search",
    "manifest",
    "graph_node",
    "graph_reverse_neighbor",
    "related_files"
  ].includes(impact.projectionKind);
}

function requiresGraphEdgeInput(impact: PublicationImpact): boolean {
  return impact.action !== "delete"
    && (impact.projectionKind === "graph_edge" || impact.projectionKind === "links");
}

function requiresDirectoryInput(impact: PublicationImpact): boolean {
  return impact.action !== "delete"
    && impact.projectionKind === "tree"
    && impact.recordIdentity.startsWith("directory:");
}

function projectionInputKey(impact: PublicationImpact): string {
  if (requiresSourceInput(impact)) return `source:${impact.recordIdentity}`;
  if (requiresGraphEdgeInput(impact)) return `graph-edge:${impact.recordIdentity}`;
  if (requiresDirectoryInput(impact)) return `directory:${impact.recordIdentity}`;
  if (impact.projectionKind === "root") return "knowledge-base";
  return `navigation:${impact.projectionKey}:${impact.recordIdentity}`;
}

async function captureSources(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    sourceFileId: string | null;
    sourceRevisionId: string | null;
    path: string | null;
  },
  sourceIds: string[]
): Promise<Map<string, Extract<PublicationProjectionInput, { kind: "source" }>>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await transaction<SourceRow[]>`
    SELECT source.id AS source_file_id, revision.id AS source_revision_id,
           source.resource_revision + CASE WHEN operation.id IS NULL THEN 0 ELSE 1 END
             AS resource_revision,
           coalesce(source.candidate_name, source.name) AS name,
           coalesce(source.candidate_relative_path, source.relative_path) AS relative_path,
           revision.object_key, revision.content_type, revision.size_bytes,
           revision.checksum_sha256, revision.metadata_json,
           CASE WHEN operation.id IS NULL THEN source.model_suggestions_json
             ELSE source.candidate_model_suggestions_json END AS model_suggestions_json,
           node.title AS node_title, node.type AS node_type,
           node.description AS node_description, node.summary AS node_summary,
           node.subjects_json AS node_subjects, node.tags_json AS node_tags,
           node.entities_json AS node_entities,
           node.explicit_references_json AS node_explicit_references,
           node.relationship_hints_json AS node_relationship_hints,
           node.headings_json AS node_headings, node.keywords_json AS node_keywords,
           node.language AS node_language, node.profile_version AS node_profile_version,
           node.profile_source AS node_profile_source, node.metadata_json AS node_metadata
    FROM focowiki.source_files source
    LEFT JOIN focowiki.resource_operations operation
      ON operation.id = source.candidate_operation_id
     AND operation.knowledge_base_id = source.knowledge_base_id
     AND operation.state = 'publishing'
    JOIN focowiki.source_revisions revision
      ON revision.id = CASE
        WHEN source.id = ${input.sourceFileId} AND ${input.sourceRevisionId}::text IS NOT NULL
          THEN ${input.sourceRevisionId}
        WHEN operation.id IS NULL THEN source.active_revision_id
        ELSE coalesce(source.candidate_revision_id, source.active_revision_id)
      END
     AND revision.source_file_id = source.id
     AND revision.knowledge_base_id = source.knowledge_base_id
    LEFT JOIN focowiki.source_file_graph_nodes node
      ON node.knowledge_base_id = source.knowledge_base_id
     AND node.source_file_id = source.id
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.id = ANY(${sourceIds})
      AND source.deleted_at IS NULL
      AND source.task_deleted_at IS NULL
      AND source.deletion_intent_id IS NULL
  `;
  const relationships = await captureRelationships(transaction, input.knowledgeBaseId, sourceIds);
  return new Map(rows.map((row) => {
    const relativePath = row.source_file_id === input.sourceFileId && input.path
      ? input.path
      : row.relative_path;
    const document: PublicationSourceSnapshot = {
      sourceFileId: row.source_file_id,
      sourceRevisionId: row.source_revision_id,
      resourceRevision: Number(row.resource_revision),
      name: relativePath.split("/").at(-1) ?? row.name,
      relativePath,
      generatedPath: generatedPagePath(relativePath),
      objectKey: row.object_key,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      checksumSha256: row.checksum_sha256,
      metadata: row.metadata_json,
      suggestions: row.model_suggestions_json,
      graphNode: mapGraphNode(row, relativePath)
    };
    return [row.source_file_id, {
      kind: "source" as const,
      document,
      relationships: relationships.get(row.source_file_id) ?? []
    }];
  }));
}

async function captureRelationships(
  transaction: TransactionSql<Record<string, never>>,
  knowledgeBaseId: string,
  sourceIds: string[]
): Promise<Map<string, OkfGraphRelationship[]>> {
  const rows = await transaction<RelationshipRow[]>`
    WITH relationships AS (
      SELECT requested.source_file_id, edge.to_source_file_id AS related_source_file_id,
             'outgoing'::text AS direction, edge.relation_type, edge.weight,
             edge.reason, edge.source, edge.evidence_json
      FROM unnest(${sourceIds}::text[]) requested(source_file_id)
      JOIN focowiki.source_file_graph_edges edge
        ON edge.knowledge_base_id = ${knowledgeBaseId}
       AND edge.from_source_file_id = requested.source_file_id
       AND edge.status = 'accepted'
      UNION ALL
      SELECT requested.source_file_id, edge.from_source_file_id AS related_source_file_id,
             'incoming'::text AS direction, edge.relation_type, edge.weight,
             edge.reason, edge.source, edge.evidence_json
      FROM unnest(${sourceIds}::text[]) requested(source_file_id)
      JOIN focowiki.source_file_graph_edges edge
        ON edge.knowledge_base_id = ${knowledgeBaseId}
       AND edge.to_source_file_id = requested.source_file_id
       AND edge.status = 'accepted'
    ), ranked AS (
      SELECT relationships.*,
             row_number() OVER (
               PARTITION BY source_file_id, related_source_file_id
               ORDER BY weight DESC, direction, relation_type, related_source_file_id
             ) AS relation_rank,
             row_number() OVER (
               PARTITION BY source_file_id
               ORDER BY weight DESC, related_source_file_id, relation_type
             ) AS source_rank
      FROM relationships
    )
    SELECT ranked.source_file_id, ranked.related_source_file_id,
           ranked.direction, ranked.relation_type, ranked.weight,
           ranked.reason, ranked.source, ranked.evidence_json,
           'pages/' || coalesce(related.candidate_relative_path, related.relative_path) AS path,
           coalesce(node.title, related.candidate_name, related.name) AS title
    FROM ranked
    JOIN focowiki.source_files related
      ON related.knowledge_base_id = ${knowledgeBaseId}
     AND related.id = ranked.related_source_file_id
    LEFT JOIN focowiki.source_file_graph_nodes node
      ON node.knowledge_base_id = related.knowledge_base_id
     AND node.source_file_id = related.id
    WHERE ranked.relation_rank = 1 AND ranked.source_rank <= ${MAX_SNAPSHOT_RELATIONSHIPS}
      AND related.deleted_at IS NULL AND related.task_deleted_at IS NULL
      AND related.deletion_intent_id IS NULL
    ORDER BY ranked.source_file_id, ranked.source_rank
  `;
  const result = new Map<string, OkfGraphRelationship[]>();
  for (const row of rows) {
    const current = result.get(row.source_file_id) ?? [];
    current.push({
      fileId: row.related_source_file_id,
      path: row.path,
      title: row.title,
      relationType: row.relation_type,
      direction: row.direction,
      weight: Number(row.weight),
      reason: row.reason,
      source: row.source,
      evidence: row.evidence_json
    });
    result.set(row.source_file_id, current);
  }
  return result;
}

async function captureGraphEdges(
  transaction: TransactionSql<Record<string, never>>,
  knowledgeBaseId: string,
  edgeIds: string[]
): Promise<Map<string, PublicationGraphEdgeSnapshot>> {
  if (edgeIds.length === 0) return new Map();
  const rows = await transaction<EdgeRow[]>`
    SELECT edge.id, edge.from_source_file_id, edge.to_source_file_id,
           edge.relation_type, edge.weight, edge.reason, edge.source, edge.evidence_json,
           'pages/' || coalesce(source.candidate_relative_path, source.relative_path) AS from_path,
           coalesce(source_node.title, source.candidate_name, source.name) AS from_title,
           'pages/' || coalesce(target.candidate_relative_path, target.relative_path) AS to_path,
           coalesce(target_node.title, target.candidate_name, target.name) AS to_title
    FROM focowiki.source_file_graph_edges edge
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = edge.knowledge_base_id
     AND source.id = edge.from_source_file_id
    JOIN focowiki.source_files target
      ON target.knowledge_base_id = edge.knowledge_base_id
     AND target.id = edge.to_source_file_id
    LEFT JOIN focowiki.source_file_graph_nodes source_node
      ON source_node.knowledge_base_id = edge.knowledge_base_id
     AND source_node.source_file_id = edge.from_source_file_id
    LEFT JOIN focowiki.source_file_graph_nodes target_node
      ON target_node.knowledge_base_id = edge.knowledge_base_id
     AND target_node.source_file_id = edge.to_source_file_id
    WHERE edge.knowledge_base_id = ${knowledgeBaseId}
      AND edge.id = ANY(${edgeIds}) AND edge.status = 'accepted'
      AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
      AND target.deleted_at IS NULL AND target.deletion_intent_id IS NULL
  `;
  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    fromFileId: row.from_source_file_id,
    fromPath: row.from_path,
    fromTitle: row.from_title,
    toFileId: row.to_source_file_id,
    toPath: row.to_path,
    toTitle: row.to_title,
    relationType: row.relation_type,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: row.evidence_json
  }]));
}

async function captureDirectories(
  transaction: TransactionSql<Record<string, never>>,
  knowledgeBaseId: string,
  relativePaths: string[]
): Promise<Map<string, PublicationDirectorySnapshot>> {
  const nonRootPaths = relativePaths.filter(Boolean);
  if (nonRootPaths.length === 0) return new Map();
  const rows = await transaction<DirectoryRow[]>`
    SELECT coalesce(directory.candidate_relative_path, directory.relative_path) AS relative_path,
           directory.id, coalesce(directory.candidate_name, directory.name) AS name,
           directory.resource_revision + CASE WHEN operation.id IS NULL THEN 0 ELSE 1 END
             AS resource_revision,
           (SELECT count(*)::int FROM focowiki.source_directories child
            WHERE child.knowledge_base_id = directory.knowledge_base_id
              AND coalesce(child.candidate_parent_id, child.parent_id) = directory.id
              AND child.deleted_at IS NULL AND child.deletion_intent_id IS NULL)
             AS direct_directory_count,
           (SELECT count(*)::int FROM focowiki.source_files child
            WHERE child.knowledge_base_id = directory.knowledge_base_id
              AND coalesce(child.candidate_directory_id, child.directory_id) = directory.id
              AND child.processing_status = 'completed'
              AND child.deleted_at IS NULL AND child.task_deleted_at IS NULL
              AND child.deletion_intent_id IS NULL) AS direct_file_count,
           (SELECT count(*)::int FROM focowiki.source_files descendant
            WHERE descendant.knowledge_base_id = directory.knowledge_base_id
              AND coalesce(descendant.candidate_path_key, descendant.path_key) COLLATE "C"
                >= (coalesce(directory.candidate_path_key, directory.path_key) || '/')::text COLLATE "C"
              AND coalesce(descendant.candidate_path_key, descendant.path_key) COLLATE "C"
                < (coalesce(directory.candidate_path_key, directory.path_key) || '0')::text COLLATE "C"
              AND descendant.processing_status = 'completed'
              AND descendant.deleted_at IS NULL AND descendant.task_deleted_at IS NULL
              AND descendant.deletion_intent_id IS NULL) AS descendant_file_count
    FROM focowiki.source_directories directory
    LEFT JOIN focowiki.resource_operations operation
      ON operation.id = directory.candidate_operation_id
     AND operation.knowledge_base_id = directory.knowledge_base_id
     AND operation.state = 'publishing'
    WHERE directory.knowledge_base_id = ${knowledgeBaseId}
      AND coalesce(directory.candidate_relative_path, directory.relative_path) = ANY(${nonRootPaths})
      AND directory.deleted_at IS NULL AND directory.deletion_intent_id IS NULL
  `;
  return new Map(rows.map((row) => [row.relative_path, {
    id: `directory:${row.relative_path}`,
    sourceDirectoryId: row.id,
    name: row.name,
    relativePath: row.relative_path,
    generatedPath: `pages/${row.relative_path}/index.md`,
    kind: "directory" as const,
    resourceRevision: Number(row.resource_revision),
    ...createDirectoryStatistics({
      directDirectoryCount: Number(row.direct_directory_count),
      directFileCount: Number(row.direct_file_count),
      descendantFileCount: Number(row.descendant_file_count)
    })
  }]));
}

async function captureKnowledgeBase(
  transaction: TransactionSql<Record<string, never>>,
  knowledgeBaseId: string
): Promise<{
  descriptor: PublicationKnowledgeBaseSnapshot;
  rootEntryCount: number;
  rootDirectoryCount: number;
  rootFileCount: number;
} | null> {
  const rows = await transaction<Array<{
    id: string;
    name: string;
    description: string | null;
    source_file_count: number;
    graph_edge_count: number;
    root_entry_count: number;
    root_directory_count: number;
    root_file_count: number;
  }>>`
    SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description,
           (SELECT count(*)::int FROM focowiki.source_files source
            WHERE source.knowledge_base_id = knowledge_base.id
              AND source.processing_status = 'completed'
              AND source.deleted_at IS NULL AND source.task_deleted_at IS NULL
              AND source.deletion_intent_id IS NULL) AS source_file_count,
           (SELECT count(*)::int FROM focowiki.source_file_graph_edges edge
            JOIN focowiki.source_files source ON source.id = edge.from_source_file_id
            JOIN focowiki.source_files target ON target.id = edge.to_source_file_id
            WHERE edge.knowledge_base_id = knowledge_base.id AND edge.status = 'accepted'
              AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
              AND target.deleted_at IS NULL AND target.deletion_intent_id IS NULL) AS graph_edge_count,
           (SELECT count(*)::int FROM focowiki.source_directories directory
             WHERE directory.knowledge_base_id = knowledge_base.id
               AND coalesce(directory.candidate_parent_id, directory.parent_id) IS NULL
               AND directory.deleted_at IS NULL AND directory.deletion_intent_id IS NULL)
             AS root_directory_count,
           (SELECT count(*)::int FROM focowiki.source_files source
             WHERE source.knowledge_base_id = knowledge_base.id
               AND coalesce(source.candidate_directory_id, source.directory_id) IS NULL
               AND source.processing_status = 'completed'
               AND source.deleted_at IS NULL AND source.task_deleted_at IS NULL
               AND source.deletion_intent_id IS NULL) AS root_file_count,
           ((SELECT count(*)::int FROM focowiki.source_directories directory
             WHERE directory.knowledge_base_id = knowledge_base.id
               AND coalesce(directory.candidate_parent_id, directory.parent_id) IS NULL
               AND directory.deleted_at IS NULL AND directory.deletion_intent_id IS NULL)
            + (SELECT count(*)::int FROM focowiki.source_files source
               WHERE source.knowledge_base_id = knowledge_base.id
                 AND coalesce(source.candidate_directory_id, source.directory_id) IS NULL
                 AND source.processing_status = 'completed'
                 AND source.deleted_at IS NULL AND source.task_deleted_at IS NULL
                 AND source.deletion_intent_id IS NULL)) AS root_entry_count
    FROM focowiki.knowledge_bases knowledge_base
    WHERE knowledge_base.id = ${knowledgeBaseId} AND knowledge_base.deleted_at IS NULL
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    descriptor: {
      id: row.id,
      name: row.name,
      description: row.description,
      sourceFileCount: Number(row.source_file_count),
      graphEdgeCount: Number(row.graph_edge_count)
    },
    rootEntryCount: Number(row.root_entry_count),
    rootDirectoryCount: Number(row.root_directory_count),
    rootFileCount: Number(row.root_file_count)
  };
}

function buildNavigationTargets(input: {
  changeKind: ChangeFactKind;
  sourceFileId: string | null;
  previousPath: string | null;
  path: string | null;
  impact: PublicationImpact;
}) {
  const targets = new Map<string, PublicationNavigationTarget>();
  for (const eventPath of unique([input.previousPath, input.path].filter(Boolean) as string[])) {
    const target = navigationTarget({
      eventPath,
      directoryPath: input.impact.projectionKey,
      eventKind: input.changeKind.startsWith("directory_") ? "directory" : "file",
      sourceFileId: input.sourceFileId
    });
    if (!target) continue;
    const isPrevious = eventPath === input.previousPath && eventPath !== input.path;
    const deletesTarget = input.changeKind === "source_deleted" && target.kind === "file"
      || input.changeKind === "directory_deleted" && target.relativePath === input.previousPath
      || isPrevious && target.relativePath === input.previousPath;
    const desiredEntry = deletesTarget ? null : {
      id: target.entryId,
      sortKey: `${target.name.toLocaleLowerCase("en")}/${target.entryId}`,
      name: target.name,
      targetPath: target.kind === "file"
        ? generatedPagePath(target.relativePath)
        : `pages/${target.relativePath}/index.md`,
      kind: target.kind
    };
    targets.set(target.entryId, { entryId: target.entryId, desiredEntry });
  }
  return [...targets.values()];
}

function navigationTarget(input: {
  eventPath: string;
  directoryPath: string;
  eventKind: "file" | "directory";
  sourceFileId: string | null;
}) {
  const eventSegments = input.eventPath.split("/").filter(Boolean);
  const directorySegments = input.directoryPath.split("/").filter(Boolean);
  if (!directorySegments.every((segment, index) => eventSegments[index] === segment)) return null;
  const remaining = eventSegments.slice(directorySegments.length);
  if (remaining.length === 0) return null;
  const kind = input.eventKind === "file" && remaining.length === 1 ? "file" as const : "directory" as const;
  if (kind === "file" && !input.sourceFileId) return null;
  const relativePath = kind === "file"
    ? input.eventPath
    : [...directorySegments, remaining[0]!].join("/");
  const name = relativePath.split("/").at(-1)!;
  return {
    entryId: kind === "file" ? input.sourceFileId! : `directory:${relativePath}`,
    relativePath,
    name,
    kind
  };
}

function rootDirectorySnapshot(
  knowledgeBase: Awaited<ReturnType<typeof captureKnowledgeBase>>
): PublicationDirectorySnapshot {
  return {
    id: "directory:",
    sourceDirectoryId: null,
    name: "pages",
    relativePath: "",
    generatedPath: "pages/index.md",
    kind: "directory",
    resourceRevision: 1,
    ...createDirectoryStatistics({
      directDirectoryCount: knowledgeBase?.rootDirectoryCount ?? 0,
      directFileCount: knowledgeBase?.rootFileCount ?? 0,
      descendantFileCount: knowledgeBase?.descriptor.sourceFileCount ?? 0
    })
  };
}

function mapGraphNode(row: SourceRow, relativePath: string): OkfGraphNode | null {
  if (!row.node_title) return null;
  return {
    fileId: row.source_file_id,
    path: generatedPagePath(relativePath),
    title: row.node_title,
    type: row.node_type,
    description: row.node_description,
    summary: row.node_summary,
    subjects: row.node_subjects ?? [],
    tags: row.node_tags ?? [],
    entities: row.node_entities ?? [],
    explicitReferences: row.node_explicit_references ?? [],
    relationshipHints: row.node_relationship_hints ?? [],
    headings: row.node_headings ?? [],
    keywords: row.node_keywords ?? [],
    language: row.node_language,
    profileVersion: row.node_profile_version,
    profileSource: row.node_profile_source,
    metadata: row.node_metadata ?? {}
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
