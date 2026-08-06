import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextStructuredMetadata
} from "../shared/types.js";

export const MAX_STORAGE_VNEXT_GRAPH_EVIDENCE_REFS = 16;

export type StorageVnextGraphEvidence = {
  publicId: StorageVnextPublicId;
  sourceFilePublicId: StorageVnextPublicId;
  sourceRevisionPublicId: StorageVnextPublicId;
  logicalPath: string;
  startOffset: number;
  endOffset: number;
  checksum: string;
};

export type StorageVnextGraphNodeFact = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceFilePublicId: StorageVnextPublicId;
  sourceRevisionPublicId: StorageVnextPublicId;
  logicalPath: string;
  label: string;
  kind: string;
  metadata: StorageVnextStructuredMetadata;
  evidence: readonly StorageVnextGraphEvidence[];
  revision: StorageVnextRevision;
};

export type StorageVnextGraphEdgeFact = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  fromNodePublicId: StorageVnextPublicId;
  toNodePublicId: StorageVnextPublicId;
  relation: string;
  weight: number;
  reason: string | null;
  source?: string;
  metadata?: StorageVnextStructuredMetadata;
  evidence: readonly StorageVnextGraphEvidence[];
  revision: StorageVnextRevision;
};

export type StorageVnextGraphMutationClosure = {
  nodePublicIds: readonly StorageVnextPublicId[];
  edgePublicIds: readonly StorageVnextPublicId[];
  affectedSourceFilePublicIds: readonly StorageVnextPublicId[];
  logicalPaths: readonly string[];
};

export type StorageVnextKnowledgeBaseGraphDeleteSummary = {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
};

export type StorageVnextGraphReadPort = {
  getNode(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextGraphNodeFact | null>;
  getEdge(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextGraphEdgeFact | null>;
  listNodes(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextGraphNodeFact>>;
  listEdges(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextGraphEdgeFact>>;
  listNeighborhood(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    nodePublicId: StorageVnextPublicId;
    depth: number;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextGraphEdgeFact>>;
  listBySourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextGraphNodeFact>>;
};

export type StorageVnextGraphWritePort = {
  replaceSourceFileGraph(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicId: StorageVnextPublicId;
    sourceRevisionPublicId: StorageVnextPublicId;
    node: StorageVnextGraphNodeFact;
    edges: readonly StorageVnextGraphEdgeFact[];
  }): Promise<void>;
  updateSourceFileGraphPath(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicId: StorageVnextPublicId;
    sourceRevisionPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextGraphNodeFact | null>;
  deleteSourceFileGraph(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicId: StorageVnextPublicId;
  }): Promise<StorageVnextGraphMutationClosure>;
  deleteSourceFileGraphs(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicIds: readonly StorageVnextPublicId[];
  }): Promise<StorageVnextGraphMutationClosure>;
  deleteKnowledgeBaseGraph(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
  }): Promise<StorageVnextKnowledgeBaseGraphDeleteSummary>;
};
