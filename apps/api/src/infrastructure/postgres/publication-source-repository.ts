import type {
  OkfGraphNode,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";
import type {
  PublicationDirectoryChild,
  PublicationSourceDocument,
  PublicationGraphEdge,
  PublicationSourceRepository
} from "../../application/ports/publication-source-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { generatedPagePath } from "../../domain/source-path.js";

type DocumentRow = {
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
  node_path: string | null;
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

type EdgeCoreRow = {
  from_source_file_id: string;
  to_source_file_id: string;
  relation_type: string;
  weight: number;
  reason: string;
  source: string;
  evidence_json: Record<string, unknown>;
};

type EdgeRow = EdgeCoreRow & {
  from_path: string;
  from_title: string;
  to_path: string;
  to_title: string;
};

type RelationshipRow = EdgeCoreRow & {
  related_source_file_id: string;
  direction: "outgoing" | "incoming";
  path: string;
  title: string;
};

export function createPostgresPublicationSourceRepository(
  sql: DatabaseClient
): PublicationSourceRepository {
  return {
    async findDocument(input) {
      const rows = await sql<DocumentRow[]>`
        SELECT source.id AS source_file_id,
               revision.id AS source_revision_id,
               source.resource_revision + CASE WHEN operation.id IS NULL THEN 0 ELSE 1 END
                 AS resource_revision,
               coalesce(source.candidate_name, source.name) AS name,
               coalesce(source.candidate_relative_path, source.relative_path) AS relative_path,
               revision.object_key, revision.content_type, revision.size_bytes,
               revision.checksum_sha256, revision.metadata_json,
               CASE WHEN operation.id IS NULL THEN source.model_suggestions_json
                 ELSE source.candidate_model_suggestions_json END AS model_suggestions_json,
               node.path AS node_path, node.title AS node_title,
               node.type AS node_type, node.description AS node_description,
               node.summary AS node_summary, node.subjects_json AS node_subjects,
               node.tags_json AS node_tags, node.entities_json AS node_entities,
               node.explicit_references_json AS node_explicit_references,
               node.relationship_hints_json AS node_relationship_hints,
               node.headings_json AS node_headings,
               node.keywords_json AS node_keywords, node.language AS node_language,
               node.profile_version AS node_profile_version,
               node.profile_source AS node_profile_source,
               node.metadata_json AS node_metadata
        FROM focowiki.source_files source
        LEFT JOIN focowiki.resource_operations operation
          ON operation.id = source.candidate_operation_id
         AND operation.knowledge_base_id = source.knowledge_base_id
         AND operation.state = 'publishing'
        JOIN focowiki.source_revisions revision
          ON revision.id = CASE WHEN operation.id IS NULL
            THEN source.active_revision_id
            ELSE coalesce(source.candidate_revision_id, source.active_revision_id)
          END
         AND revision.source_file_id = source.id
         AND revision.knowledge_base_id = source.knowledge_base_id
        LEFT JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = source.knowledge_base_id
         AND node.source_file_id = source.id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.id = ${input.sourceFileId}
          AND source.deleted_at IS NULL
          AND source.task_deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
          AND revision.processing_status = 'completed'
        LIMIT 1
      `;
      return rows[0] ? mapDocument(rows[0]) : null;
    },

    async findGraphEdge(input) {
      const rows = await sql<EdgeRow[]>`
        SELECT edge.from_source_file_id, edge.to_source_file_id,
               edge.relation_type, edge.weight, edge.reason, edge.source,
               edge.evidence_json, source_node.path AS from_path,
               source_node.title AS from_title, target_node.path AS to_path,
               target_node.title AS to_title
        FROM focowiki.source_file_graph_edges edge
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = edge.knowledge_base_id
         AND source.id = edge.from_source_file_id
        JOIN focowiki.source_files target
          ON target.knowledge_base_id = edge.knowledge_base_id
         AND target.id = edge.to_source_file_id
        JOIN focowiki.source_file_graph_nodes source_node
          ON source_node.knowledge_base_id = edge.knowledge_base_id
         AND source_node.source_file_id = edge.from_source_file_id
        JOIN focowiki.source_file_graph_nodes target_node
          ON target_node.knowledge_base_id = edge.knowledge_base_id
         AND target_node.source_file_id = edge.to_source_file_id
        WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
          AND edge.id = ${input.edgeId}
          AND edge.status = 'accepted'
          AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
          AND target.deleted_at IS NULL AND target.deletion_intent_id IS NULL
        LIMIT 1
      `;
      return rows[0] ? mapEdge(rows[0]) : null;
    },

    async listRelationships(input) {
      assertPositiveInteger(input.limit, "limit");
      const rows = await sql<RelationshipRow[]>`
        WITH relationships AS (
          SELECT edge.from_source_file_id, edge.to_source_file_id,
                 edge.to_source_file_id AS related_source_file_id,
                 edge.relation_type, edge.weight, edge.reason, edge.source,
                 edge.evidence_json, 'outgoing'::text AS direction
          FROM focowiki.source_file_graph_edges edge
          WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
            AND edge.from_source_file_id = ${input.sourceFileId}
            AND edge.status = 'accepted'
          UNION ALL
          SELECT edge.from_source_file_id, edge.to_source_file_id,
                 edge.from_source_file_id AS related_source_file_id,
                 edge.relation_type, edge.weight, edge.reason, edge.source,
                 edge.evidence_json, 'incoming'::text AS direction
          FROM focowiki.source_file_graph_edges edge
          WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
            AND edge.to_source_file_id = ${input.sourceFileId}
            AND edge.status = 'accepted'
        ), ranked AS (
          SELECT relationships.*,
                 row_number() OVER (
                   PARTITION BY related_source_file_id
                   ORDER BY weight DESC,
                            CASE WHEN direction = 'outgoing' THEN 0 ELSE 1 END,
                            relation_type, related_source_file_id
                 ) AS rank
          FROM relationships
        )
        SELECT ranked.from_source_file_id, ranked.to_source_file_id,
               ranked.related_source_file_id, ranked.relation_type,
               ranked.weight, ranked.reason, ranked.source,
               ranked.evidence_json, ranked.direction,
               node.path, node.title
        FROM ranked
        JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = ${input.knowledgeBaseId}
         AND node.source_file_id = ranked.related_source_file_id
        JOIN focowiki.source_files related
          ON related.knowledge_base_id = ${input.knowledgeBaseId}
         AND related.id = ranked.related_source_file_id
        WHERE ranked.rank = 1
          AND related.deleted_at IS NULL
          AND related.task_deleted_at IS NULL
          AND related.deletion_intent_id IS NULL
        ORDER BY ranked.weight DESC, ranked.related_source_file_id
        LIMIT ${input.limit}
      `;
      return rows.map((row) => ({
        fileId: row.related_source_file_id,
        path: row.path,
        title: row.title,
        relationType: row.relation_type,
        direction: row.direction,
        weight: Number(row.weight),
        reason: row.reason,
        source: row.source,
        evidence: row.evidence_json
      }));
    },

    async findDirectoryChild(input) {
      if (input.kind === "file") {
        if (!input.sourceFileId) return null;
        const rows = await sql<Array<{
          id: string;
          name: string;
          relative_path: string;
          resource_revision: number;
        }>>`
          SELECT source.id, coalesce(source.candidate_name, source.name) AS name,
                 coalesce(source.candidate_relative_path, source.relative_path) AS relative_path,
                 source.resource_revision + CASE WHEN operation.id IS NULL THEN 0 ELSE 1 END
                   AS resource_revision
          FROM focowiki.source_files source
          LEFT JOIN focowiki.resource_operations operation
            ON operation.id = source.candidate_operation_id
           AND operation.knowledge_base_id = source.knowledge_base_id
           AND operation.state = 'publishing'
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.id = ${input.sourceFileId}
            AND CASE WHEN operation.id IS NULL THEN source.relative_path
              ELSE source.candidate_relative_path END = ${input.relativePath}
            AND source.processing_status = 'completed'
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
          LIMIT 1
        `;
        return rows[0] ? mapDirectoryFile(rows[0]) : null;
      }
      const rows = await sql<Array<{
        id: string;
        name: string;
        relative_path: string;
        resource_revision: number;
        child_count: number;
        direct_file_count: number;
        descendant_file_count: number;
      }>>`
        SELECT directory.id, coalesce(directory.candidate_name, directory.name) AS name,
               coalesce(directory.candidate_relative_path, directory.relative_path) AS relative_path,
               directory.resource_revision + CASE WHEN operation.id IS NULL THEN 0 ELSE 1 END
                 AS resource_revision,
               (
                 SELECT count(*)::int
                 FROM focowiki.source_directories child
                 WHERE child.knowledge_base_id = directory.knowledge_base_id
                   AND coalesce(child.candidate_parent_id, child.parent_id) = directory.id
                   AND child.deleted_at IS NULL
                   AND child.deletion_intent_id IS NULL
               ) AS child_count,
               (
                 SELECT count(*)::int
                 FROM focowiki.source_files child
                 WHERE child.knowledge_base_id = directory.knowledge_base_id
                   AND coalesce(child.candidate_directory_id, child.directory_id) = directory.id
                   AND child.processing_status = 'completed'
                   AND child.deleted_at IS NULL
                   AND child.task_deleted_at IS NULL
                   AND child.deletion_intent_id IS NULL
               ) AS direct_file_count,
               (
                 SELECT count(*)::int
                 FROM focowiki.source_files descendant
                 WHERE descendant.knowledge_base_id = directory.knowledge_base_id
                   AND coalesce(descendant.candidate_path_key, descendant.path_key) COLLATE "C"
                     >= (coalesce(directory.candidate_path_key, directory.path_key) || '/')::text COLLATE "C"
                   AND coalesce(descendant.candidate_path_key, descendant.path_key) COLLATE "C"
                     < (coalesce(directory.candidate_path_key, directory.path_key) || '0')::text COLLATE "C"
                   AND descendant.processing_status = 'completed'
                   AND descendant.deleted_at IS NULL
                   AND descendant.task_deleted_at IS NULL
                   AND descendant.deletion_intent_id IS NULL
               ) AS descendant_file_count
        FROM focowiki.source_directories directory
        LEFT JOIN focowiki.resource_operations operation
          ON operation.id = directory.candidate_operation_id
         AND operation.knowledge_base_id = directory.knowledge_base_id
         AND operation.state = 'publishing'
        WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
          AND CASE WHEN operation.id IS NULL THEN directory.relative_path
            ELSE directory.candidate_relative_path END = ${input.relativePath}
          AND directory.deleted_at IS NULL
          AND directory.deletion_intent_id IS NULL
        LIMIT 1
      `;
      return rows[0] ? mapDirectory(rows[0]) : null;
    },

    async getKnowledgeBaseDescriptor(knowledgeBaseId) {
      const rows = await sql<Array<{
        id: string;
        name: string;
        description: string | null;
        source_file_count: number;
        graph_edge_count: number;
      }>>`
        SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description,
               (SELECT count(*)::int
                FROM focowiki.source_files source
                WHERE source.knowledge_base_id = knowledge_base.id
                  AND source.deleted_at IS NULL
                  AND source.task_deleted_at IS NULL
                  AND source.deletion_intent_id IS NULL
                  AND source.processing_status = 'completed') AS source_file_count,
               (SELECT count(*)::int
                FROM focowiki.source_file_graph_edges edge
                WHERE edge.knowledge_base_id = knowledge_base.id
                  AND edge.status = 'accepted') AS graph_edge_count
        FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.id = ${knowledgeBaseId}
          AND knowledge_base.deleted_at IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      return row ? {
        id: row.id,
        name: row.name,
        description: row.description,
        sourceFileCount: Number(row.source_file_count),
        graphEdgeCount: Number(row.graph_edge_count)
      } : null;
    }
  };
}

function mapDirectoryFile(row: {
  id: string;
  name: string;
  relative_path: string;
  resource_revision: number;
}): PublicationDirectoryChild {
  return {
    id: row.id,
    sourceDirectoryId: null,
    name: row.name,
    relativePath: row.relative_path,
    generatedPath: generatedPagePath(row.relative_path),
    kind: "file",
    resourceRevision: Number(row.resource_revision),
    childCount: 0,
    directFileCount: 0,
    descendantFileCount: 0
  };
}

function mapDirectory(row: {
  id: string;
  name: string;
  relative_path: string;
  resource_revision: number;
  child_count: number;
  direct_file_count: number;
  descendant_file_count: number;
}): PublicationDirectoryChild {
  return {
    id: `directory:${row.relative_path}`,
    sourceDirectoryId: row.id,
    name: row.name,
    relativePath: row.relative_path,
    generatedPath: `pages/${row.relative_path}/index.md`,
    kind: "directory",
    resourceRevision: Number(row.resource_revision),
    childCount: Number(row.child_count),
    directFileCount: Number(row.direct_file_count),
    descendantFileCount: Number(row.descendant_file_count)
  };
}

function mapDocument(row: DocumentRow): PublicationSourceDocument {
  return {
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    resourceRevision: Number(row.resource_revision),
    name: row.name,
    relativePath: row.relative_path,
    generatedPath: generatedPagePath(row.relative_path),
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    metadata: row.metadata_json,
    suggestions: row.model_suggestions_json,
    graphNode: row.node_path && row.node_title ? mapNode(row) : null
  };
}

function mapNode(row: DocumentRow): OkfGraphNode {
  return {
    fileId: row.source_file_id,
    path: row.node_path!,
    title: row.node_title!,
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

function mapEdge(row: EdgeRow): PublicationGraphEdge {
  return {
    fromFileId: row.from_source_file_id,
    toFileId: row.to_source_file_id,
    relationType: row.relation_type,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: row.evidence_json,
    fromPath: row.from_path,
    fromTitle: row.from_title,
    toPath: row.to_path,
    toTitle: row.to_title
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
