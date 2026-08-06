import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { generatedPagePath } from "../../domain/source-path.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphEvidence,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort,
  StorageVnextGraphWritePort
} from "./ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import { MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS } from "./ports.js";

export type StorageVnextGraphRepository =
  & StorageVnextGraphReadPort
  & StorageVnextGraphWritePort
  & {
    listNodesBySourceFiles(input: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly StorageVnextGraphNodeFact[]>;
  };

export type StorageVnextGraphRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "scope_conflict"
  | "stale_source_revision"
  | "markdown_path_mismatch"
  | "evidence_limit_exceeded"
  | "duplicate_graph_fact";

export class StorageVnextGraphRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextGraphRepositoryErrorCode) {
    super(`Storage vNext graph repository error: ${code}`);
    this.name = "StorageVnextGraphRepositoryError";
  }
}

type ReadSql = DatabaseClient | TransactionSql;

type NodeRow = {
  public_id: string;
  knowledge_base_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  logical_path: string;
  label: string;
  node_kind: string;
  metadata: StorageVnextStructuredMetadata;
  revision: number | string;
};

type EdgeRow = {
  public_id: string;
  knowledge_base_id: string;
  from_node_public_id: string;
  to_node_public_id: string;
  relation: string;
  weight: number | string;
  reason: string | null;
  edge_source: string;
  metadata: StorageVnextStructuredMetadata;
  revision: number | string;
};

type EvidenceRow = {
  public_id: string;
  node_public_id: string | null;
  edge_public_id: string | null;
  source_file_public_id: string;
  source_revision_public_id: string;
  logical_path: string;
  start_offset: number | string;
  end_offset: number | string;
  checksum_sha256: string;
};

type CurrentSourceRow = {
  source_file_public_id: string;
  source_revision_public_id: string;
  logical_path: string;
  checksum_sha256: string;
  byte_count: number | string;
};

type GraphCursor = {
  kind: "edge_catalog" | "neighborhood" | "node_catalog" | "source_node";
  scope: string;
  weight: number | null;
  publicId: string;
};

const MAX_GRAPH_PAGE_SIZE = 1_000;
const MAX_GRAPH_EDGES_PER_REPLACEMENT = 1_000;

export function createPostgresStorageVnextGraphRepository(
  sql: DatabaseClient
): StorageVnextGraphRepository {
  return {
    async getNode(input) {
      const row = await readNode(sql, input.knowledgeBaseId, input.publicId);
      if (!row) return null;
      const evidence = await readEvidence(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        nodePublicIds: [input.publicId],
        edgePublicIds: []
      });
      return mapNode(row, evidence.get(targetKey("node", input.publicId)) ?? []);
    },

    async getEdge(input) {
      const row = await readEdge(sql, input.knowledgeBaseId, input.publicId);
      if (!row) return null;
      const evidence = await readEvidence(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        nodePublicIds: [],
        edgePublicIds: [input.publicId]
      });
      return mapEdge(row, evidence.get(targetKey("edge", input.publicId)) ?? []);
    },

    async listNodes(input) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(
        input.cursor,
        "node_catalog",
        input.knowledgeBaseId
      );
      const rows = await sql<NodeRow[]>`
        SELECT node.public_id, node.knowledge_base_id, node.source_file_public_id,
               node.source_revision_public_id, node.logical_path, node.label,
               node.node_kind, node.metadata, node.revision
        FROM focowiki.graph_nodes node
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = node.knowledge_base_id
         AND source.public_id = node.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = node.knowledge_base_id
         AND current_revision.source_file_public_id = node.source_file_public_id
         AND current_revision.source_revision_public_id = node.source_revision_public_id
        WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = node.knowledge_base_id
              AND knowledge_base.deleted_at IS NULL
          )
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR node.public_id COLLATE "C"
              > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY node.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return nodePage(sql, input.knowledgeBaseId, rows, limit, "node_catalog");
    },

    async listEdges(input) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(
        input.cursor,
        "edge_catalog",
        input.knowledgeBaseId
      );
      const rows = await sql<EdgeRow[]>`
        SELECT edge.public_id, edge.knowledge_base_id,
               edge.from_node_public_id, edge.to_node_public_id,
               edge.relation, edge.weight, edge.reason, edge.edge_source,
               edge.metadata, edge.revision
        FROM focowiki.graph_edges edge
        JOIN focowiki.graph_nodes source_node
          ON source_node.knowledge_base_id = edge.knowledge_base_id
         AND source_node.public_id = edge.from_node_public_id
        JOIN focowiki.graph_nodes target_node
          ON target_node.knowledge_base_id = edge.knowledge_base_id
         AND target_node.public_id = edge.to_node_public_id
        JOIN focowiki.source_file_current_revisions source_current
          ON source_current.knowledge_base_id = source_node.knowledge_base_id
         AND source_current.source_file_public_id = source_node.source_file_public_id
         AND source_current.source_revision_public_id = source_node.source_revision_public_id
        JOIN focowiki.source_file_current_revisions target_current
          ON target_current.knowledge_base_id = target_node.knowledge_base_id
         AND target_current.source_file_public_id = target_node.source_file_public_id
         AND target_current.source_revision_public_id = target_node.source_revision_public_id
        JOIN focowiki.source_files source_file
          ON source_file.knowledge_base_id = source_node.knowledge_base_id
         AND source_file.public_id = source_node.source_file_public_id
         AND source_file.deleted_at IS NULL
        JOIN focowiki.source_files target_file
          ON target_file.knowledge_base_id = target_node.knowledge_base_id
         AND target_file.public_id = target_node.source_file_public_id
         AND target_file.deleted_at IS NULL
        WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = edge.knowledge_base_id
              AND knowledge_base.deleted_at IS NULL
          )
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR edge.public_id COLLATE "C"
              > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY edge.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      return edgePage(sql, input.knowledgeBaseId, rows, limit, "edge_catalog");
    },

    async listBySourceFile(input) {
      const limit = assertLimit(input.limit);
      const scope = `${input.knowledgeBaseId}:${input.sourceFilePublicId}`;
      const cursor = decodeCursor(input.cursor, "source_node", scope);
      const rows = await sql<NodeRow[]>`
        SELECT node.public_id, node.knowledge_base_id, node.source_file_public_id,
               node.source_revision_public_id, node.logical_path, node.label,
               node.node_kind, node.metadata, node.revision
        FROM focowiki.graph_nodes node
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = node.knowledge_base_id
         AND source.public_id = node.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = node.knowledge_base_id
         AND current_revision.source_file_public_id = node.source_file_public_id
         AND current_revision.source_revision_public_id = node.source_revision_public_id
        WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
          AND node.source_file_public_id = ${input.sourceFilePublicId}
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = node.knowledge_base_id
              AND knowledge_base.deleted_at IS NULL
          )
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR node.public_id COLLATE "C"
              > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY node.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const evidence = await readEvidence(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        nodePublicIds: pageRows.map((row) => row.public_id),
        edgePublicIds: []
      });
      const items = pageRows.map((row) =>
        mapNode(row, evidence.get(targetKey("node", row.public_id)) ?? [])
      );
      return {
        items,
        nextCursor: rows.length > limit && pageRows.at(-1)
          ? encodeCursor({
              kind: "source_node",
              scope,
              weight: null,
              publicId: pageRows.at(-1)!.public_id
            })
          : null
      };
    },

    async listNodesBySourceFiles(input) {
      const limit = assertLimit(input.limit);
      const sourceFilePublicIds = [...new Set(input.sourceFilePublicIds)];
      if (
        sourceFilePublicIds.length > limit
        || sourceFilePublicIds.some((publicId) => !publicId)
      ) throw new StorageVnextGraphRepositoryError("invalid_input");
      if (sourceFilePublicIds.length === 0) return [];
      const rows = await sql<NodeRow[]>`
        SELECT node.public_id, node.knowledge_base_id, node.source_file_public_id,
               node.source_revision_public_id, node.logical_path, node.label,
               node.node_kind, node.metadata, node.revision
        FROM focowiki.graph_nodes node
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = node.knowledge_base_id
         AND source.public_id = node.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = node.knowledge_base_id
         AND current_revision.source_file_public_id = node.source_file_public_id
         AND current_revision.source_revision_public_id = node.source_revision_public_id
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = node.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
          AND node.source_file_public_id = ANY(${sourceFilePublicIds})
        ORDER BY array_position(
                   ${sourceFilePublicIds}::text[],
                   node.source_file_public_id
                 ),
                 node.public_id COLLATE "C"
        LIMIT ${limit}
      `;
      const evidence = await readEvidence(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        nodePublicIds: rows.map((row) => row.public_id),
        edgePublicIds: []
      });
      return rows.map((row) =>
        mapNode(row, evidence.get(targetKey("node", row.public_id)) ?? [])
      );
    },

    async listNeighborhood(input) {
      const limit = assertLimit(input.limit);
      if (!Number.isSafeInteger(input.depth) || input.depth < 1 || input.depth > 2) {
        throw new StorageVnextGraphRepositoryError("invalid_input");
      }
      const scope = `${input.knowledgeBaseId}:${input.nodePublicId}:${input.depth}`;
      const cursor = decodeCursor(input.cursor, "neighborhood", scope);
      const neighborFanout = input.depth === 1
        ? limit + 1
        : Math.min(limit + 1, 64);
      const rows = await sql<EdgeRow[]>`
        WITH RECURSIVE walk(node_public_id, edge_public_id, depth, visited) AS (
          SELECT ${input.nodePublicId}::text, NULL::text, 0,
                 ARRAY[${input.nodePublicId}::text]
          UNION ALL
          SELECT neighbor.node_public_id, neighbor.edge_public_id,
                 walk.depth + 1,
                 walk.visited || neighbor.node_public_id
          FROM walk
          CROSS JOIN LATERAL (
            SELECT incident.edge_public_id, incident.node_public_id
            FROM (
              SELECT edge.public_id AS edge_public_id,
                     edge.to_node_public_id AS node_public_id,
                     edge.weight
              FROM focowiki.graph_edges edge
              WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
                AND edge.from_node_public_id = walk.node_public_id
                AND (
                  ${cursor?.weight ?? null}::double precision IS NULL
                  OR edge.weight < ${cursor?.weight ?? null}::double precision
                  OR (
                    edge.weight = ${cursor?.weight ?? null}::double precision
                    AND edge.public_id COLLATE "C"
                      > ${cursor?.publicId ?? null}::text COLLATE "C"
                  )
                )
              UNION ALL
              SELECT edge.public_id, edge.from_node_public_id, edge.weight
              FROM focowiki.graph_edges edge
              WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
                AND edge.to_node_public_id = walk.node_public_id
                AND (
                  ${cursor?.weight ?? null}::double precision IS NULL
                  OR edge.weight < ${cursor?.weight ?? null}::double precision
                  OR (
                    edge.weight = ${cursor?.weight ?? null}::double precision
                    AND edge.public_id COLLATE "C"
                      > ${cursor?.publicId ?? null}::text COLLATE "C"
                  )
                )
            ) incident
            ORDER BY incident.weight DESC,
                     incident.edge_public_id COLLATE "C"
            LIMIT ${neighborFanout}
          ) neighbor
          WHERE walk.depth < ${input.depth}
            AND NOT neighbor.node_public_id = ANY(walk.visited)
        ), reachable_edges AS (
          SELECT DISTINCT edge_public_id AS public_id
          FROM walk
          WHERE edge_public_id IS NOT NULL
        )
        SELECT edge.public_id, edge.knowledge_base_id,
               edge.from_node_public_id, edge.to_node_public_id,
               edge.relation, edge.weight, edge.reason, edge.edge_source,
               edge.metadata, edge.revision
        FROM reachable_edges reachable
        JOIN focowiki.graph_edges edge ON edge.public_id = reachable.public_id
        WHERE EXISTS (
          SELECT 1
          FROM focowiki.graph_nodes source_node
          JOIN focowiki.source_files source
            ON source.knowledge_base_id = source_node.knowledge_base_id
           AND source.public_id = source_node.source_file_public_id
           AND source.deleted_at IS NULL
          JOIN focowiki.graph_nodes target_node
            ON target_node.knowledge_base_id = edge.knowledge_base_id
           AND target_node.public_id = edge.to_node_public_id
          JOIN focowiki.source_files target
            ON target.knowledge_base_id = target_node.knowledge_base_id
           AND target.public_id = target_node.source_file_public_id
           AND target.deleted_at IS NULL
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.public_id = edge.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE source_node.knowledge_base_id = edge.knowledge_base_id
            AND source_node.public_id = edge.from_node_public_id
        )
        ORDER BY edge.weight DESC, edge.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const evidence = await readEvidence(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        nodePublicIds: [],
        edgePublicIds: pageRows.map((row) => row.public_id)
      });
      const items = pageRows.map((row) =>
        mapEdge(row, evidence.get(targetKey("edge", row.public_id)) ?? [])
      );
      const last = pageRows.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeCursor({
              kind: "neighborhood",
              scope,
              weight: Number(last.weight),
              publicId: last.public_id
            })
          : null
      };
    },

    async replaceSourceFileGraph(input) {
      validateReplacement(input);
      await sql.begin(async (transaction) => {
        const sources = await readCurrentSources(
          transaction,
          input.knowledgeBaseId,
          unique([
            input.sourceFilePublicId,
            ...input.node.evidence.map((item) => item.sourceFilePublicId),
            ...input.edges.flatMap((edge) =>
              edge.evidence.map((item) => item.sourceFilePublicId)
            )
          ]),
          true
        );
        const source = sources.get(input.sourceFilePublicId);
        if (!source) throw new StorageVnextGraphRepositoryError("scope_conflict");
        if (source.source_revision_public_id !== input.sourceRevisionPublicId) {
          throw new StorageVnextGraphRepositoryError("stale_source_revision");
        }
        const expectedPath = generatedPagePath(source.logical_path);
        if (input.node.logicalPath !== expectedPath) {
          throw new StorageVnextGraphRepositoryError("markdown_path_mismatch");
        }
        validateEvidenceFacts(
          [...input.node.evidence, ...input.edges.flatMap((edge) => edge.evidence)],
          sources
        );

        const existingNodes = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.graph_nodes
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ${input.sourceFilePublicId}
          FOR UPDATE
        `;
        if (
          existingNodes[0]
          && existingNodes[0].public_id !== input.node.publicId
        ) {
          throw new StorageVnextGraphRepositoryError("duplicate_graph_fact");
        }

        await transaction`
          DELETE FROM focowiki.graph_edges
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND from_node_public_id = ${input.node.publicId}
        `;
        await transaction`
          DELETE FROM focowiki.graph_evidence_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND node_public_id = ${input.node.publicId}
        `;
        try {
          await transaction`
            INSERT INTO focowiki.graph_nodes (
              public_id, knowledge_base_id, source_file_public_id,
              source_revision_public_id, logical_path, label, node_kind,
              metadata, revision
            )
            VALUES (
              ${input.node.publicId}, ${input.knowledgeBaseId},
              ${input.sourceFilePublicId}, ${input.sourceRevisionPublicId},
              ${input.node.logicalPath}, ${input.node.label}, ${input.node.kind},
              ${transaction.json(input.node.metadata as never)}, ${input.node.revision}
            )
            ON CONFLICT (public_id) DO UPDATE SET
              source_revision_public_id = excluded.source_revision_public_id,
              logical_path = excluded.logical_path,
              label = excluded.label,
              node_kind = excluded.node_kind,
              metadata = excluded.metadata,
              revision = excluded.revision
            WHERE focowiki.graph_nodes.knowledge_base_id = excluded.knowledge_base_id
              AND focowiki.graph_nodes.source_file_public_id
                = excluded.source_file_public_id
          `;
          await insertNodeEvidence(
            transaction,
            input.knowledgeBaseId,
            input.node.publicId,
            input.node.evidence
          );
          await assertTargetNodes(
            transaction,
            input.knowledgeBaseId,
            input.edges.map((edge) => edge.toNodePublicId)
          );
          await insertEdges(transaction, input.knowledgeBaseId, input.edges);
          await insertEdgeEvidence(transaction, input.knowledgeBaseId, input.edges);
        } catch (error) {
          throw mapDatabaseError(error);
        }
      });
    },

    async updateSourceFileGraphPath(input) {
      return sql.begin(async (transaction) => {
        const sources = await readCurrentSources(
          transaction,
          input.knowledgeBaseId,
          [input.sourceFilePublicId],
          true
        );
        const source = sources.get(input.sourceFilePublicId);
        if (!source) throw new StorageVnextGraphRepositoryError("scope_conflict");
        if (source.source_revision_public_id !== input.sourceRevisionPublicId) {
          throw new StorageVnextGraphRepositoryError("stale_source_revision");
        }
        const logicalPath = generatedPagePath(source.logical_path);
        const rows = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.graph_nodes
          SET logical_path = ${logicalPath}, revision = revision + 1
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ${input.sourceFilePublicId}
            AND source_revision_public_id = ${input.sourceRevisionPublicId}
          RETURNING public_id
        `;
        await transaction`
          UPDATE focowiki.graph_evidence_refs
          SET logical_path = ${logicalPath}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ${input.sourceFilePublicId}
            AND source_revision_public_id = ${input.sourceRevisionPublicId}
        `;
        const publicId = rows[0]?.public_id;
        if (!publicId) return null;
        const node = await readNode(transaction, input.knowledgeBaseId, publicId);
        if (!node) return null;
        const evidence = await readEvidence(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          nodePublicIds: [publicId],
          edgePublicIds: []
        });
        return mapNode(node, evidence.get(targetKey("node", publicId)) ?? []);
      });
    },

    async deleteSourceFileGraph(input) {
      return deleteSourceFileGraphs(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFilePublicIds: [input.sourceFilePublicId]
      });
    },

    async deleteSourceFileGraphs(input) {
      if (input.sourceFilePublicIds.length > 1_000) {
        throw new StorageVnextGraphRepositoryError("invalid_input");
      }
      return deleteSourceFileGraphs(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFilePublicIds: unique([...input.sourceFilePublicIds])
      });
    },

    async deleteKnowledgeBaseGraph(input) {
      return sql.begin(async (transaction) => {
        const counts = await transaction<Array<{
          node_count: number | string;
          edge_count: number | string;
          evidence_count: number | string;
        }>>`
          SELECT
            (SELECT count(*) FROM focowiki.graph_nodes
              WHERE knowledge_base_id = ${input.knowledgeBaseId}) AS node_count,
            (SELECT count(*) FROM focowiki.graph_edges
              WHERE knowledge_base_id = ${input.knowledgeBaseId}) AS edge_count,
            (SELECT count(*) FROM focowiki.graph_evidence_refs
              WHERE knowledge_base_id = ${input.knowledgeBaseId}) AS evidence_count
        `;
        await transaction`
          DELETE FROM focowiki.graph_nodes
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        return {
          nodeCount: Number(counts[0]?.node_count ?? 0),
          edgeCount: Number(counts[0]?.edge_count ?? 0),
          evidenceCount: Number(counts[0]?.evidence_count ?? 0)
        };
      });
    }
  };
}

async function deleteSourceFileGraphs(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: string[];
  }
) {
  if (input.sourceFilePublicIds.length === 0) {
    return {
      nodePublicIds: [],
      edgePublicIds: [],
      affectedSourceFilePublicIds: [],
      logicalPaths: []
    };
  }
  return sql.begin(async (transaction) => {
    const nodes = await transaction<Array<{
      public_id: string;
      source_file_public_id: string;
      logical_path: string;
    }>>`
      SELECT public_id, source_file_public_id, logical_path
      FROM focowiki.graph_nodes
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ANY(${input.sourceFilePublicIds})
      ORDER BY public_id
      FOR UPDATE
    `;
    if (nodes.length === 0) {
      return {
        nodePublicIds: [],
        edgePublicIds: [],
        affectedSourceFilePublicIds: [],
        logicalPaths: []
      };
    }
    const nodePublicIds = nodes.map((node) => node.public_id);
    const edges = await transaction<Array<{
      public_id: string;
      from_source_file_public_id: string;
      to_source_file_public_id: string;
    }>>`
      SELECT edge.public_id,
             source_node.source_file_public_id AS from_source_file_public_id,
             target_node.source_file_public_id AS to_source_file_public_id
      FROM focowiki.graph_edges edge
      JOIN focowiki.graph_nodes source_node
        ON source_node.knowledge_base_id = edge.knowledge_base_id
       AND source_node.public_id = edge.from_node_public_id
      JOIN focowiki.graph_nodes target_node
        ON target_node.knowledge_base_id = edge.knowledge_base_id
       AND target_node.public_id = edge.to_node_public_id
      WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          edge.from_node_public_id = ANY(${nodePublicIds})
          OR edge.to_node_public_id = ANY(${nodePublicIds})
        )
      ORDER BY edge.public_id
    `;
    await transaction`
      DELETE FROM focowiki.graph_nodes
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ANY(${nodePublicIds})
    `;
    return {
      nodePublicIds,
      edgePublicIds: edges.map((edge) => edge.public_id),
      affectedSourceFilePublicIds: unique(edges.flatMap((edge) => [
        edge.from_source_file_public_id,
        edge.to_source_file_public_id
      ])).sort(compareText),
      logicalPaths: unique(nodes.map((node) => node.logical_path)).sort(compareText)
    };
  });
}

function validateReplacement(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  node: StorageVnextGraphNodeFact;
  edges: readonly StorageVnextGraphEdgeFact[];
}): void {
  if (
    !input.knowledgeBaseId
    || !input.sourceFilePublicId
    || !input.sourceRevisionPublicId
    || input.node.knowledgeBaseId !== input.knowledgeBaseId
    || input.node.sourceFilePublicId !== input.sourceFilePublicId
    || input.node.sourceRevisionPublicId !== input.sourceRevisionPublicId
    || !input.node.publicId
    || !input.node.logicalPath
    || !input.node.label
    || !input.node.kind
    || !Number.isSafeInteger(input.node.revision)
    || input.node.revision < 0
    || input.edges.length > MAX_GRAPH_EDGES_PER_REPLACEMENT
  ) {
    throw new StorageVnextGraphRepositoryError("invalid_input");
  }
  assertEvidenceBound(input.node.evidence);
  const publicIds = new Set<string>();
  const relationships = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const evidence of input.node.evidence) {
    if (evidenceIds.has(evidence.publicId)) {
      throw new StorageVnextGraphRepositoryError("duplicate_graph_fact");
    }
    evidenceIds.add(evidence.publicId);
  }
  for (const edge of input.edges) {
    assertEvidenceBound(edge.evidence);
    if (
      !edge.publicId
      || edge.knowledgeBaseId !== input.knowledgeBaseId
      || edge.fromNodePublicId !== input.node.publicId
      || edge.toNodePublicId === input.node.publicId
      || !edge.toNodePublicId
      || !edge.relation
      || (edge.source !== undefined && (
        !edge.source || Buffer.byteLength(edge.source) > 128
      ))
      || (edge.metadata !== undefined && (
        Buffer.byteLength(JSON.stringify(edge.metadata), "utf8") > 8_192
      ))
      || !Number.isFinite(edge.weight)
      || edge.weight < 0
      || edge.weight > 1
      || !Number.isSafeInteger(edge.revision)
      || edge.revision < 0
    ) {
      throw new StorageVnextGraphRepositoryError("invalid_input");
    }
    const relationship = [
      edge.fromNodePublicId,
      edge.toNodePublicId,
      edge.relation
    ].join("\u0000");
    if (publicIds.has(edge.publicId) || relationships.has(relationship)) {
      throw new StorageVnextGraphRepositoryError("duplicate_graph_fact");
    }
    publicIds.add(edge.publicId);
    relationships.add(relationship);
    for (const evidence of edge.evidence) {
      if (evidenceIds.has(evidence.publicId)) {
        throw new StorageVnextGraphRepositoryError("duplicate_graph_fact");
      }
      evidenceIds.add(evidence.publicId);
    }
  }
}

function assertEvidenceBound(evidence: readonly StorageVnextGraphEvidence[]): void {
  if (evidence.length > MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS) {
    throw new StorageVnextGraphRepositoryError("evidence_limit_exceeded");
  }
}

function validateEvidenceFacts(
  evidence: readonly StorageVnextGraphEvidence[],
  sources: ReadonlyMap<string, CurrentSourceRow>
): void {
  for (const item of evidence) {
    const source = sources.get(item.sourceFilePublicId);
    if (!source) throw new StorageVnextGraphRepositoryError("scope_conflict");
    if (source.source_revision_public_id !== item.sourceRevisionPublicId) {
      throw new StorageVnextGraphRepositoryError("stale_source_revision");
    }
    if (generatedPagePath(source.logical_path) !== item.logicalPath) {
      throw new StorageVnextGraphRepositoryError("markdown_path_mismatch");
    }
    if (
      !item.publicId
      || item.checksum !== source.checksum_sha256
      || !Number.isSafeInteger(item.startOffset)
      || !Number.isSafeInteger(item.endOffset)
      || item.startOffset < 0
      || item.endOffset < item.startOffset
      || item.endOffset > Number(source.byte_count)
    ) {
      throw new StorageVnextGraphRepositoryError("invalid_input");
    }
  }
}

async function readCurrentSources(
  sql: ReadSql,
  knowledgeBaseId: string,
  sourceFilePublicIds: string[],
  lock: boolean
): Promise<Map<string, CurrentSourceRow>> {
  if (sourceFilePublicIds.length === 0) return new Map();
  const rows = await sql<CurrentSourceRow[]>`
    SELECT source.public_id AS source_file_public_id,
           current_revision.source_revision_public_id,
           source.logical_path, revision.checksum_sha256, revision.byte_count
    FROM focowiki.source_files source
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = source.knowledge_base_id
     AND current_revision.source_file_public_id = source.public_id
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = current_revision.knowledge_base_id
     AND revision.source_file_public_id = current_revision.source_file_public_id
     AND revision.public_id = current_revision.source_revision_public_id
    WHERE source.knowledge_base_id = ${knowledgeBaseId}
      AND source.public_id = ANY(${sourceFilePublicIds})
      AND source.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = source.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
    ORDER BY source.public_id
    ${lock ? sql`FOR UPDATE OF source` : sql``}
  `;
  return new Map(rows.map((row) => [row.source_file_public_id, row]));
}

async function assertTargetNodes(
  sql: ReadSql,
  knowledgeBaseId: string,
  targetPublicIds: string[]
): Promise<void> {
  const publicIds = unique(targetPublicIds);
  if (publicIds.length === 0) return;
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT node.public_id
    FROM focowiki.graph_nodes node
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = node.knowledge_base_id
     AND source.public_id = node.source_file_public_id
     AND source.deleted_at IS NULL
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = node.knowledge_base_id
     AND current_revision.source_file_public_id = node.source_file_public_id
     AND current_revision.source_revision_public_id = node.source_revision_public_id
    WHERE node.knowledge_base_id = ${knowledgeBaseId}
      AND node.public_id = ANY(${publicIds})
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = node.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
  `;
  if (rows.length !== publicIds.length) {
    throw new StorageVnextGraphRepositoryError("scope_conflict");
  }
}

async function insertNodeEvidence(
  sql: ReadSql,
  knowledgeBaseId: string,
  nodePublicId: string,
  evidence: readonly StorageVnextGraphEvidence[]
): Promise<void> {
  if (evidence.length === 0) return;
  const rows = evidence.map((item) => evidenceInsertRow(item, nodePublicId, null));
  await sql`
    INSERT INTO focowiki.graph_evidence_refs (
      public_id, knowledge_base_id, node_public_id, edge_public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, checksum_sha256
    )
    SELECT item."publicId", ${knowledgeBaseId}, item."nodePublicId",
           item."edgePublicId", item."sourceFilePublicId",
           item."sourceRevisionPublicId", item."logicalPath",
           item."startOffset", item."endOffset", item.checksum
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text,
      "nodePublicId" text,
      "edgePublicId" text,
      "sourceFilePublicId" text,
      "sourceRevisionPublicId" text,
      "logicalPath" text,
      "startOffset" bigint,
      "endOffset" bigint,
      checksum text
    )
  `;
}

async function insertEdges(
  sql: ReadSql,
  knowledgeBaseId: string,
  edges: readonly StorageVnextGraphEdgeFact[]
): Promise<void> {
  if (edges.length === 0) return;
  const rows = edges.map((edge) => ({
    publicId: edge.publicId,
    fromNodePublicId: edge.fromNodePublicId,
    toNodePublicId: edge.toNodePublicId,
    relation: edge.relation,
    weight: edge.weight,
    reason: edge.reason,
    edgeSource: edge.source ?? "deterministic",
    metadata: edge.metadata ?? {},
    revision: edge.revision
  }));
  await sql`
    INSERT INTO focowiki.graph_edges (
      public_id, knowledge_base_id, from_node_public_id, to_node_public_id,
      relation, weight, reason, edge_source, metadata, revision
    )
    SELECT item."publicId", ${knowledgeBaseId}, item."fromNodePublicId",
           item."toNodePublicId", item.relation, item.weight, item.reason,
           item."edgeSource", item.metadata, item.revision
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text,
      "fromNodePublicId" text,
      "toNodePublicId" text,
      relation text,
      weight double precision,
      reason text,
      "edgeSource" text,
      metadata jsonb,
      revision bigint
    )
  `;
}

async function insertEdgeEvidence(
  sql: ReadSql,
  knowledgeBaseId: string,
  edges: readonly StorageVnextGraphEdgeFact[]
): Promise<void> {
  const rows = edges.flatMap((edge) =>
    edge.evidence.map((item) => evidenceInsertRow(item, null, edge.publicId))
  );
  if (rows.length === 0) return;
  await sql`
    INSERT INTO focowiki.graph_evidence_refs (
      public_id, knowledge_base_id, node_public_id, edge_public_id,
      source_file_public_id, source_revision_public_id, logical_path,
      start_offset, end_offset, checksum_sha256
    )
    SELECT item."publicId", ${knowledgeBaseId}, item."nodePublicId",
           item."edgePublicId", item."sourceFilePublicId",
           item."sourceRevisionPublicId", item."logicalPath",
           item."startOffset", item."endOffset", item.checksum
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text,
      "nodePublicId" text,
      "edgePublicId" text,
      "sourceFilePublicId" text,
      "sourceRevisionPublicId" text,
      "logicalPath" text,
      "startOffset" bigint,
      "endOffset" bigint,
      checksum text
    )
  `;
}

function evidenceInsertRow(
  item: StorageVnextGraphEvidence,
  nodePublicId: string | null,
  edgePublicId: string | null
) {
  return {
    publicId: item.publicId,
    nodePublicId,
    edgePublicId,
    sourceFilePublicId: item.sourceFilePublicId,
    sourceRevisionPublicId: item.sourceRevisionPublicId,
    logicalPath: item.logicalPath,
    startOffset: item.startOffset,
    endOffset: item.endOffset,
    checksum: item.checksum
  };
}

async function readNode(
  sql: ReadSql,
  knowledgeBaseId: string,
  publicId: string
): Promise<NodeRow | null> {
  const rows = await sql<NodeRow[]>`
    SELECT node.public_id, node.knowledge_base_id, node.source_file_public_id,
           node.source_revision_public_id, node.logical_path, node.label,
           node.node_kind, node.metadata, node.revision
    FROM focowiki.graph_nodes node
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = node.knowledge_base_id
     AND source.public_id = node.source_file_public_id
     AND source.deleted_at IS NULL
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = node.knowledge_base_id
     AND current_revision.source_file_public_id = node.source_file_public_id
     AND current_revision.source_revision_public_id = node.source_revision_public_id
    WHERE node.knowledge_base_id = ${knowledgeBaseId}
      AND node.public_id = ${publicId}
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = node.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readEdge(
  sql: ReadSql,
  knowledgeBaseId: string,
  publicId: string
): Promise<EdgeRow | null> {
  const rows = await sql<EdgeRow[]>`
    SELECT edge.public_id, edge.knowledge_base_id,
           edge.from_node_public_id, edge.to_node_public_id,
           edge.relation, edge.weight, edge.reason, edge.edge_source,
           edge.metadata, edge.revision
    FROM focowiki.graph_edges edge
    JOIN focowiki.graph_nodes source_node
      ON source_node.knowledge_base_id = edge.knowledge_base_id
     AND source_node.public_id = edge.from_node_public_id
    JOIN focowiki.graph_nodes target_node
      ON target_node.knowledge_base_id = edge.knowledge_base_id
     AND target_node.public_id = edge.to_node_public_id
    JOIN focowiki.source_file_current_revisions source_current
      ON source_current.knowledge_base_id = source_node.knowledge_base_id
     AND source_current.source_file_public_id = source_node.source_file_public_id
     AND source_current.source_revision_public_id = source_node.source_revision_public_id
    JOIN focowiki.source_file_current_revisions target_current
      ON target_current.knowledge_base_id = target_node.knowledge_base_id
     AND target_current.source_file_public_id = target_node.source_file_public_id
     AND target_current.source_revision_public_id = target_node.source_revision_public_id
    JOIN focowiki.source_files source_file
      ON source_file.knowledge_base_id = source_node.knowledge_base_id
     AND source_file.public_id = source_node.source_file_public_id
     AND source_file.deleted_at IS NULL
    JOIN focowiki.source_files target_file
      ON target_file.knowledge_base_id = target_node.knowledge_base_id
     AND target_file.public_id = target_node.source_file_public_id
     AND target_file.deleted_at IS NULL
    WHERE edge.knowledge_base_id = ${knowledgeBaseId}
      AND edge.public_id = ${publicId}
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = edge.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readEvidence(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    nodePublicIds: string[];
    edgePublicIds: string[];
  }
): Promise<Map<string, StorageVnextGraphEvidence[]>> {
  if (input.nodePublicIds.length === 0 && input.edgePublicIds.length === 0) {
    return new Map();
  }
  const rows = await sql<EvidenceRow[]>`
    SELECT evidence.public_id, evidence.node_public_id,
           evidence.edge_public_id, evidence.source_file_public_id,
           evidence.source_revision_public_id, evidence.logical_path,
           evidence.start_offset, evidence.end_offset,
           evidence.checksum_sha256
    FROM focowiki.graph_evidence_refs evidence
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = evidence.knowledge_base_id
     AND source.public_id = evidence.source_file_public_id
     AND source.deleted_at IS NULL
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = evidence.knowledge_base_id
     AND current_revision.source_file_public_id = evidence.source_file_public_id
     AND current_revision.source_revision_public_id
       = evidence.source_revision_public_id
    WHERE evidence.knowledge_base_id = ${input.knowledgeBaseId}
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = evidence.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
      AND (
        evidence.node_public_id = ANY(${input.nodePublicIds})
        OR evidence.edge_public_id = ANY(${input.edgePublicIds})
      )
    ORDER BY evidence.public_id COLLATE "C"
  `;
  const grouped = new Map<string, StorageVnextGraphEvidence[]>();
  for (const row of rows) {
    const key = row.node_public_id
      ? targetKey("node", row.node_public_id)
      : targetKey("edge", row.edge_public_id!);
    const items = grouped.get(key) ?? [];
    items.push(mapEvidence(row));
    grouped.set(key, items);
  }
  return grouped;
}

function mapNode(
  row: NodeRow,
  evidence: StorageVnextGraphEvidence[]
): StorageVnextGraphNodeFact {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    logicalPath: row.logical_path,
    label: row.label,
    kind: row.node_kind,
    metadata: row.metadata,
    evidence,
    revision: Number(row.revision)
  };
}

function mapEdge(
  row: EdgeRow,
  evidence: StorageVnextGraphEvidence[]
): StorageVnextGraphEdgeFact {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    fromNodePublicId: row.from_node_public_id,
    toNodePublicId: row.to_node_public_id,
    relation: row.relation,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.edge_source,
    metadata: row.metadata,
    evidence,
    revision: Number(row.revision)
  };
}

function mapEvidence(row: EvidenceRow): StorageVnextGraphEvidence {
  return {
    publicId: row.public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    logicalPath: row.logical_path,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    checksum: row.checksum_sha256
  };
}

async function nodePage(
  sql: ReadSql,
  knowledgeBaseId: string,
  rows: NodeRow[],
  limit: number,
  kind: "node_catalog"
) {
  const pageRows = rows.slice(0, limit);
  const evidence = await readEvidence(sql, {
    knowledgeBaseId,
    nodePublicIds: pageRows.map((row) => row.public_id),
    edgePublicIds: []
  });
  return {
    items: pageRows.map((row) =>
      mapNode(row, evidence.get(targetKey("node", row.public_id)) ?? [])
    ),
    nextCursor: rows.length > limit && pageRows.at(-1)
      ? encodeCursor({
          kind,
          scope: knowledgeBaseId,
          weight: null,
          publicId: pageRows.at(-1)!.public_id
        })
      : null
  };
}

async function edgePage(
  sql: ReadSql,
  knowledgeBaseId: string,
  rows: EdgeRow[],
  limit: number,
  kind: "edge_catalog"
) {
  const pageRows = rows.slice(0, limit);
  const evidence = await readEvidence(sql, {
    knowledgeBaseId,
    nodePublicIds: [],
    edgePublicIds: pageRows.map((row) => row.public_id)
  });
  return {
    items: pageRows.map((row) =>
      mapEdge(row, evidence.get(targetKey("edge", row.public_id)) ?? [])
    ),
    nextCursor: rows.length > limit && pageRows.at(-1)
      ? encodeCursor({
          kind,
          scope: knowledgeBaseId,
          weight: null,
          publicId: pageRows.at(-1)!.public_id
        })
      : null
  };
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GRAPH_PAGE_SIZE) {
    throw new StorageVnextGraphRepositoryError("invalid_input");
  }
  return limit;
}

function encodeCursor(cursor: GraphCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | null,
  kind: GraphCursor["kind"],
  scope: string
): GraphCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.kind !== kind
      || value.scope !== scope
      || typeof value.publicId !== "string"
      || !value.publicId
      || (
        value.weight !== null
        && (typeof value.weight !== "number" || !Number.isFinite(value.weight))
      )
    ) {
      throw new Error("Invalid graph cursor");
    }
    return value as GraphCursor;
  } catch {
    throw new StorageVnextGraphRepositoryError("invalid_cursor");
  }
}

function targetKey(kind: "node" | "edge", publicId: string): string {
  return `${kind}:${publicId}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function mapDatabaseError(error: unknown): Error {
  if (error instanceof StorageVnextGraphRepositoryError) return error;
  const code = typeof error === "object" && error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "23503") return new StorageVnextGraphRepositoryError("scope_conflict");
  if (code === "23505") {
    return new StorageVnextGraphRepositoryError("duplicate_graph_fact");
  }
  if (code === "23514" || code === "22001") {
    return new StorageVnextGraphRepositoryError("invalid_input");
  }
  return error instanceof Error ? error : new Error("Unknown graph repository error");
}
