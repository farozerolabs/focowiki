import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { generatedPagePath } from "../../domain/source-path.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import {
  StorageVnextGraphRepositoryError,
  type StorageVnextGraphRepository
} from "../graph/postgres-repository.js";
import {
  MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS,
  type StorageVnextGraphEdgeFact,
  type StorageVnextGraphEvidence,
  type StorageVnextGraphNodeFact,
  type StorageVnextGraphReadPort,
  type StorageVnextGraphWritePort
} from "../graph/ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import {
  overlayStorageVnextMutationGraphEdge,
  overlayStorageVnextMutationGraphNode,
  type StorageVnextMutationCandidateOverlay
} from "./candidate-overlay.js";

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

type NeighborhoodCursor = {
  kind: "mutation_candidate_neighborhood";
  scope: string;
  weight: number;
  publicId: string;
};

export type StorageVnextMutationCandidateGraph = Pick<
  StorageVnextGraphReadPort & StorageVnextGraphWritePort,
  | "getNode"
  | "getEdge"
  | "listNodes"
  | "listBySourceFile"
  | "listNeighborhood"
  | "replaceSourceFileGraph"
> & Pick<StorageVnextGraphRepository, "listNodesBySourceFiles">;

export function createPostgresStorageVnextMutationCandidateGraph(input: {
  sql: DatabaseClient;
  candidatePublicId: string;
  mutation: StorageVnextMutationCandidateOverlay;
  catalog: Pick<
    StorageVnextCatalogReadPort,
    "getCurrentSourceRevision" | "listSourceFilesByPublicIds"
  >;
  graph: Pick<
    StorageVnextGraphRepository,
    | "getNode"
    | "getEdge"
    | "listNodes"
    | "listBySourceFile"
    | "listNeighborhood"
    | "listNodesBySourceFiles"
  >;
}): StorageVnextMutationCandidateGraph {
  assertIdentifier(input.candidatePublicId);
  const repository: StorageVnextMutationCandidateGraph = {
    async getNode(request) {
      assertScope(input, request.knowledgeBaseId);
      const staged = await readCandidateNodes(input.sql, {
        candidatePublicId: input.candidatePublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        publicIds: [request.publicId]
      });
      if (staged[0]) return staged[0];
      const current = await input.graph.getNode(request);
      return current
        ? overlayStorageVnextMutationGraphNode(input.mutation, current)
        : null;
    },

    async getEdge(request) {
      assertScope(input, request.knowledgeBaseId);
      const staged = await readCandidateEdges(input.sql, {
        candidatePublicId: input.candidatePublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        publicIds: [request.publicId]
      });
      if (staged[0]) return staged[0];
      const current = await input.graph.getEdge(request);
      if (!current) return null;
      if (await isStagedFromNode(input.sql, input.candidatePublicId,
        request.knowledgeBaseId, current.fromNodePublicId)) return null;
      return overlayStorageVnextMutationGraphEdge(input.mutation, current);
    },

    async listNodes(request) {
      assertScope(input, request.knowledgeBaseId);
      const page = await input.graph.listNodes(request);
      const staged = await readCandidateNodes(input.sql, {
        candidatePublicId: input.candidatePublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        publicIds: page.items.map((node) => node.publicId)
      });
      const stagedById = new Map(staged.map((node) => [node.publicId, node]));
      return {
        items: page.items.map((node) => stagedById.get(node.publicId)
          ?? overlayStorageVnextMutationGraphNode(input.mutation, node)),
        nextCursor: page.nextCursor
      };
    },

    async listBySourceFile(request) {
      assertScope(input, request.knowledgeBaseId);
      const staged = await readCandidateNodesBySourceFiles(input.sql, {
        candidatePublicId: input.candidatePublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: [request.sourceFilePublicId]
      });
      if (staged[0]) return { items: staged, nextCursor: null };
      const page = await input.graph.listBySourceFile(request);
      return {
        items: page.items.map((node) =>
          overlayStorageVnextMutationGraphNode(input.mutation, node)),
        nextCursor: page.nextCursor
      };
    },

    async listNodesBySourceFiles(request) {
      assertScope(input, request.knowledgeBaseId);
      const current = await input.graph.listNodesBySourceFiles(request);
      const staged = await readCandidateNodesBySourceFiles(input.sql, {
        candidatePublicId: input.candidatePublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: [...request.sourceFilePublicIds]
      });
      const stagedBySource = new Map(staged.map((node) =>
        [node.sourceFilePublicId, node]));
      return current.map((node) => stagedBySource.get(node.sourceFilePublicId)
        ?? overlayStorageVnextMutationGraphNode(input.mutation, node));
    },

    async listNeighborhood(request) {
      assertScope(input, request.knowledgeBaseId);
      if (request.depth !== 1) {
        throw new StorageVnextGraphRepositoryError("invalid_input");
      }
      const limit = assertLimit(request.limit);
      const scope = [
        input.candidatePublicId,
        request.knowledgeBaseId,
        request.nodePublicId,
        request.depth
      ].join(":");
      const cursor = decodeNeighborhoodCursor(request.cursor, scope);
      const rows = await input.sql<EdgeRow[]>`
        WITH effective_edges AS (
          SELECT edge.public_id, edge.knowledge_base_id,
                 edge.from_node_public_id, edge.to_node_public_id,
                 edge.relation, edge.weight, edge.reason, edge.edge_source,
                 edge.metadata, edge.revision
          FROM focowiki.graph_edges edge
          WHERE edge.knowledge_base_id = ${request.knowledgeBaseId}
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.release_candidate_graph_nodes staged
              WHERE staged.candidate_public_id = ${input.candidatePublicId}
                AND staged.knowledge_base_id = edge.knowledge_base_id
                AND staged.public_id = edge.from_node_public_id
            )
          UNION ALL
          SELECT edge.public_id, edge.knowledge_base_id,
                 edge.from_node_public_id, edge.to_node_public_id,
                 edge.relation, edge.weight, edge.reason, edge.edge_source,
                 edge.metadata, edge.revision
          FROM focowiki.release_candidate_graph_edges edge
          WHERE edge.candidate_public_id = ${input.candidatePublicId}
            AND edge.knowledge_base_id = ${request.knowledgeBaseId}
        )
        SELECT public_id, knowledge_base_id, from_node_public_id,
               to_node_public_id, relation, weight, reason, edge_source,
               metadata, revision
        FROM effective_edges
        WHERE (from_node_public_id = ${request.nodePublicId}
               OR to_node_public_id = ${request.nodePublicId})
          AND (${cursor?.weight ?? null}::double precision IS NULL
            OR weight < ${cursor?.weight ?? null}::double precision
            OR (weight = ${cursor?.weight ?? null}::double precision
              AND public_id COLLATE "C"
                > ${cursor?.publicId ?? null}::text COLLATE "C"))
        ORDER BY weight DESC, public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const visible = rows.slice(0, limit);
      const evidence = await readEffectiveEvidence(input.sql, {
        candidatePublicId: input.candidatePublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        nodePublicIds: [],
        edgePublicIds: visible.map((row) => row.public_id)
      });
      const last = visible.at(-1);
      return {
        items: visible.map((row) => overlayStorageVnextMutationGraphEdge(
          input.mutation,
          mapEdge(row, evidence.get(targetKey("edge", row.public_id)) ?? [])
        )),
        nextCursor: rows.length > limit && last
          ? encodeNeighborhoodCursor({
              kind: "mutation_candidate_neighborhood",
              scope,
              weight: Number(last.weight),
              publicId: last.public_id
            })
          : null
      };
    },

    async replaceSourceFileGraph(request) {
      assertScope(input, request.knowledgeBaseId);
      validateReplacement(request);
      await validateEffectiveFacts(input, request);
      for (const targetPublicId of new Set(
        request.edges.map((edge) => edge.toNodePublicId)
      )) {
        if (!await repository.getNode({
          knowledgeBaseId: request.knowledgeBaseId,
          publicId: targetPublicId
        })) throw new StorageVnextGraphRepositoryError("scope_conflict");
      }
      await input.sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.release_candidate_graph_nodes
          WHERE candidate_public_id = ${input.candidatePublicId}
            AND knowledge_base_id = ${request.knowledgeBaseId}
            AND source_file_public_id = ${request.sourceFilePublicId}
        `;
        await transaction`
          INSERT INTO focowiki.release_candidate_graph_nodes (
            candidate_public_id, knowledge_base_id, public_id,
            source_file_public_id, source_revision_public_id, logical_path,
            label, node_kind, metadata, revision
          ) VALUES (
            ${input.candidatePublicId}, ${request.knowledgeBaseId},
            ${request.node.publicId}, ${request.sourceFilePublicId},
            ${request.sourceRevisionPublicId}, ${request.node.logicalPath},
            ${request.node.label}, ${request.node.kind},
            ${transaction.json(request.node.metadata as never)},
            ${request.node.revision}
          )
        `;
        await insertCandidateEvidence(transaction, {
          candidatePublicId: input.candidatePublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          nodePublicId: request.node.publicId,
          edgePublicId: null,
          evidence: request.node.evidence
        });
        if (request.edges.length > 0) {
          const edges = request.edges.map((edge) => ({
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
          await transaction`
            INSERT INTO focowiki.release_candidate_graph_edges (
              candidate_public_id, knowledge_base_id, public_id,
              from_node_public_id, to_node_public_id, relation, weight,
              reason, edge_source, metadata, revision
            )
            SELECT ${input.candidatePublicId}, ${request.knowledgeBaseId},
                   item."publicId", item."fromNodePublicId",
                   item."toNodePublicId", item.relation, item.weight,
                   item.reason, item."edgeSource", item.metadata, item.revision
            FROM jsonb_to_recordset(${transaction.json(edges as never)}) AS item(
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
          for (const edge of request.edges) {
            await insertCandidateEvidence(transaction, {
              candidatePublicId: input.candidatePublicId,
              knowledgeBaseId: request.knowledgeBaseId,
              nodePublicId: null,
              edgePublicId: edge.publicId,
              evidence: edge.evidence
            });
          }
        }
      });
    }
  };
  return repository;
}

async function validateEffectiveFacts(
  input: Parameters<typeof createPostgresStorageVnextMutationCandidateGraph>[0],
  request: Parameters<StorageVnextGraphWritePort["replaceSourceFileGraph"]>[0]
): Promise<void> {
  const evidence = [
    ...request.node.evidence,
    ...request.edges.flatMap((edge) => edge.evidence)
  ];
  const sourceFilePublicIds = [...new Set([
    request.sourceFilePublicId,
    ...evidence.map((item) => item.sourceFilePublicId)
  ])];
  const sources = await input.catalog.listSourceFilesByPublicIds({
    knowledgeBaseId: request.knowledgeBaseId,
    publicIds: sourceFilePublicIds,
    limit: sourceFilePublicIds.length
  });
  const sourceById = new Map(sources.map((source) => [source.publicId, source]));
  const revisions = new Map<string, Awaited<ReturnType<
    typeof input.catalog.getCurrentSourceRevision
  >>>();
  for (const sourceFilePublicId of sourceFilePublicIds) {
    revisions.set(sourceFilePublicId, await input.catalog.getCurrentSourceRevision({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId
    }));
  }
  const source = sourceById.get(request.sourceFilePublicId);
  const revision = revisions.get(request.sourceFilePublicId);
  if (!source || !revision) {
    throw new StorageVnextGraphRepositoryError("scope_conflict");
  }
  if (revision.publicId !== request.sourceRevisionPublicId) {
    throw new StorageVnextGraphRepositoryError("stale_source_revision");
  }
  if (request.node.logicalPath !== generatedPagePath(source.logicalPath)) {
    throw new StorageVnextGraphRepositoryError("markdown_path_mismatch");
  }
  for (const item of evidence) {
    const evidenceSource = sourceById.get(item.sourceFilePublicId);
    const evidenceRevision = revisions.get(item.sourceFilePublicId);
    if (!evidenceSource || !evidenceRevision) {
      throw new StorageVnextGraphRepositoryError("scope_conflict");
    }
    if (item.sourceRevisionPublicId !== evidenceRevision.publicId) {
      throw new StorageVnextGraphRepositoryError("stale_source_revision");
    }
    if (item.logicalPath !== generatedPagePath(evidenceSource.logicalPath)) {
      throw new StorageVnextGraphRepositoryError("markdown_path_mismatch");
    }
    if (
      item.checksum !== evidenceRevision.checksum
      || !Number.isSafeInteger(item.startOffset)
      || !Number.isSafeInteger(item.endOffset)
      || item.startOffset < 0
      || item.endOffset < item.startOffset
      || item.endOffset > evidenceRevision.byteCount
    ) throw new StorageVnextGraphRepositoryError("invalid_input");
  }
}

function validateReplacement(
  input: Parameters<StorageVnextGraphWritePort["replaceSourceFileGraph"]>[0]
): void {
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
    || input.edges.length > 1_000
  ) throw new StorageVnextGraphRepositoryError("invalid_input");
  const edgeIds = new Set<string>();
  const relationships = new Set<string>();
  const evidenceIds = new Set<string>();
  validateEvidence(input.node.evidence, evidenceIds);
  for (const edge of input.edges) {
    if (
      !edge.publicId
      || edge.knowledgeBaseId !== input.knowledgeBaseId
      || edge.fromNodePublicId !== input.node.publicId
      || !edge.toNodePublicId
      || edge.toNodePublicId === input.node.publicId
      || !edge.relation
      || !Number.isFinite(edge.weight)
      || edge.weight < 0
      || edge.weight > 1
      || !Number.isSafeInteger(edge.revision)
      || edge.revision < 0
    ) throw new StorageVnextGraphRepositoryError("invalid_input");
    const relationship = [
      edge.fromNodePublicId,
      edge.toNodePublicId,
      edge.relation
    ].join("\u0000");
    if (edgeIds.has(edge.publicId) || relationships.has(relationship)) {
      throw new StorageVnextGraphRepositoryError("duplicate_graph_fact");
    }
    edgeIds.add(edge.publicId);
    relationships.add(relationship);
    validateEvidence(edge.evidence, evidenceIds);
  }
}

function validateEvidence(
  evidence: readonly StorageVnextGraphEvidence[],
  publicIds: Set<string>
): void {
  if (evidence.length > MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS) {
    throw new StorageVnextGraphRepositoryError("evidence_limit_exceeded");
  }
  for (const item of evidence) {
    if (!item.publicId || publicIds.has(item.publicId)) {
      throw new StorageVnextGraphRepositoryError("duplicate_graph_fact");
    }
    publicIds.add(item.publicId);
  }
}

async function readCandidateNodes(
  sql: DatabaseClient,
  input: {
    candidatePublicId: string;
    knowledgeBaseId: string;
    publicIds: readonly string[];
  }
): Promise<StorageVnextGraphNodeFact[]> {
  if (input.publicIds.length === 0) return [];
  const rows = await sql<NodeRow[]>`
    SELECT public_id, knowledge_base_id, source_file_public_id,
           source_revision_public_id, logical_path, label, node_kind,
           metadata, revision
    FROM focowiki.release_candidate_graph_nodes
    WHERE candidate_public_id = ${input.candidatePublicId}
      AND knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ANY(${[...input.publicIds]})
    ORDER BY public_id
  `;
  return mapCandidateNodes(sql, input, rows);
}

async function readCandidateNodesBySourceFiles(
  sql: DatabaseClient,
  input: {
    candidatePublicId: string;
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
  }
): Promise<StorageVnextGraphNodeFact[]> {
  if (input.sourceFilePublicIds.length === 0) return [];
  const rows = await sql<NodeRow[]>`
    SELECT public_id, knowledge_base_id, source_file_public_id,
           source_revision_public_id, logical_path, label, node_kind,
           metadata, revision
    FROM focowiki.release_candidate_graph_nodes
    WHERE candidate_public_id = ${input.candidatePublicId}
      AND knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ANY(${[...input.sourceFilePublicIds]})
    ORDER BY array_position(${[...input.sourceFilePublicIds]}::text[],
             source_file_public_id), public_id COLLATE "C"
  `;
  return mapCandidateNodes(sql, input, rows);
}

async function mapCandidateNodes(
  sql: DatabaseClient,
  input: { candidatePublicId: string; knowledgeBaseId: string },
  rows: NodeRow[]
): Promise<StorageVnextGraphNodeFact[]> {
  const evidence = await readEffectiveEvidence(sql, {
    ...input,
    nodePublicIds: rows.map((row) => row.public_id),
    edgePublicIds: []
  });
  return rows.map((row) =>
    mapNode(row, evidence.get(targetKey("node", row.public_id)) ?? []));
}

async function readCandidateEdges(
  sql: DatabaseClient,
  input: {
    candidatePublicId: string;
    knowledgeBaseId: string;
    publicIds: readonly string[];
  }
): Promise<StorageVnextGraphEdgeFact[]> {
  if (input.publicIds.length === 0) return [];
  const rows = await sql<EdgeRow[]>`
    SELECT public_id, knowledge_base_id, from_node_public_id,
           to_node_public_id, relation, weight, reason, edge_source,
           metadata, revision
    FROM focowiki.release_candidate_graph_edges
    WHERE candidate_public_id = ${input.candidatePublicId}
      AND knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ANY(${[...input.publicIds]})
    ORDER BY public_id COLLATE "C"
  `;
  const evidence = await readEffectiveEvidence(sql, {
    ...input,
    nodePublicIds: [],
    edgePublicIds: rows.map((row) => row.public_id)
  });
  return rows.map((row) =>
    mapEdge(row, evidence.get(targetKey("edge", row.public_id)) ?? []));
}

async function readEffectiveEvidence(
  sql: DatabaseClient,
  input: {
    candidatePublicId: string;
    knowledgeBaseId: string;
    nodePublicIds: readonly string[];
    edgePublicIds: readonly string[];
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
    FROM focowiki.release_candidate_graph_evidence evidence
    WHERE evidence.candidate_public_id = ${input.candidatePublicId}
      AND evidence.knowledge_base_id = ${input.knowledgeBaseId}
      AND (evidence.node_public_id = ANY(${[...input.nodePublicIds]})
        OR evidence.edge_public_id = ANY(${[...input.edgePublicIds]}))
    UNION ALL
    SELECT evidence.public_id, evidence.node_public_id,
           evidence.edge_public_id, evidence.source_file_public_id,
           evidence.source_revision_public_id, evidence.logical_path,
           evidence.start_offset, evidence.end_offset,
           evidence.checksum_sha256
    FROM focowiki.graph_evidence_refs evidence
    WHERE evidence.knowledge_base_id = ${input.knowledgeBaseId}
      AND (evidence.node_public_id = ANY(${[...input.nodePublicIds]})
        OR evidence.edge_public_id = ANY(${[...input.edgePublicIds]}))
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.release_candidate_graph_evidence staged
        WHERE staged.candidate_public_id = ${input.candidatePublicId}
          AND staged.public_id = evidence.public_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.release_candidate_graph_nodes staged_node
        WHERE staged_node.candidate_public_id = ${input.candidatePublicId}
          AND staged_node.public_id = evidence.node_public_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.release_candidate_graph_edges staged_edge
        WHERE staged_edge.candidate_public_id = ${input.candidatePublicId}
          AND staged_edge.public_id = evidence.edge_public_id
      )
    ORDER BY public_id
  `;
  const output = new Map<string, StorageVnextGraphEvidence[]>();
  for (const row of rows) {
    const key = row.node_public_id
      ? targetKey("node", row.node_public_id)
      : targetKey("edge", row.edge_public_id!);
    const items = output.get(key) ?? [];
    items.push(mapEvidence(row));
    output.set(key, items);
  }
  return output;
}

async function isStagedFromNode(
  sql: DatabaseClient,
  candidatePublicId: string,
  knowledgeBaseId: string,
  nodePublicId: string
): Promise<boolean> {
  const rows = await sql<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM focowiki.release_candidate_graph_nodes
      WHERE candidate_public_id = ${candidatePublicId}
        AND knowledge_base_id = ${knowledgeBaseId}
        AND public_id = ${nodePublicId}
    ) AS present
  `;
  return rows[0]?.present ?? false;
}

async function insertCandidateEvidence(
  sql: TransactionSql,
  input: {
    candidatePublicId: string;
    knowledgeBaseId: string;
    nodePublicId: string | null;
    edgePublicId: string | null;
    evidence: readonly StorageVnextGraphEvidence[];
  }
): Promise<void> {
  if (input.evidence.length === 0) return;
  const rows = input.evidence.map((item) => ({
    publicId: item.publicId,
    sourceFilePublicId: item.sourceFilePublicId,
    sourceRevisionPublicId: item.sourceRevisionPublicId,
    logicalPath: item.logicalPath,
    startOffset: item.startOffset,
    endOffset: item.endOffset,
    checksum: item.checksum
  }));
  await sql`
    INSERT INTO focowiki.release_candidate_graph_evidence (
      candidate_public_id, knowledge_base_id, public_id, node_public_id,
      edge_public_id, source_file_public_id, source_revision_public_id,
      logical_path, start_offset, end_offset, checksum_sha256
    )
    SELECT ${input.candidatePublicId}, ${input.knowledgeBaseId},
           item."publicId", ${input.nodePublicId}, ${input.edgePublicId},
           item."sourceFilePublicId", item."sourceRevisionPublicId",
           item."logicalPath", item."startOffset", item."endOffset",
           item.checksum
    FROM jsonb_to_recordset(${sql.json(rows as never)}) AS item(
      "publicId" text,
      "sourceFilePublicId" text,
      "sourceRevisionPublicId" text,
      "logicalPath" text,
      "startOffset" bigint,
      "endOffset" bigint,
      checksum text
    )
  `;
}

function mapNode(
  row: NodeRow,
  evidence: readonly StorageVnextGraphEvidence[]
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
  evidence: readonly StorageVnextGraphEvidence[]
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

function targetKey(kind: "edge" | "node", publicId: string): string {
  return `${kind}:${publicId}`;
}

function assertScope(
  input: { mutation: StorageVnextMutationCandidateOverlay },
  knowledgeBaseId: string
): void {
  if (input.mutation.knowledgeBaseId !== knowledgeBaseId) {
    throw new StorageVnextGraphRepositoryError("scope_conflict");
  }
}

function assertIdentifier(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) {
    throw new StorageVnextGraphRepositoryError("invalid_input");
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new StorageVnextGraphRepositoryError("invalid_input");
  }
  return value;
}

function encodeNeighborhoodCursor(value: NeighborhoodCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeNeighborhoodCursor(
  value: string | null,
  scope: string
): NeighborhoodCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as NeighborhoodCursor;
    if (
      parsed.kind !== "mutation_candidate_neighborhood"
      || parsed.scope !== scope
      || !Number.isFinite(parsed.weight)
      || !parsed.publicId
    ) throw new Error("invalid cursor");
    return parsed;
  } catch {
    throw new StorageVnextGraphRepositoryError("invalid_cursor");
  }
}
