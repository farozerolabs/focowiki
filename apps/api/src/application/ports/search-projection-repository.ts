import type { BodySearchDocument } from "../../search/body-search-document.js";

export type SearchProjectionIdentity = {
  knowledgeBaseId: string;
  sourceFileId: string;
  sourceBodyChecksumSha256: string;
  searchSchemaVersion: string;
  tokenizerContractVersion: string;
  segmentationVersion: string;
};

export type SearchProjectionDocumentRecord = SearchProjectionIdentity & {
  documentId: string;
  sourceRevisionId: string;
  segmentCount: number;
  lifecycleState: "writing" | "ready" | "failed";
};

export type GenerationSearchProjectionReference = {
  knowledgeBaseId: string;
  generationId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  searchDocumentId: string;
  searchSchemaVersion: string;
  tokenizerContractVersion: string;
  segmentationVersion: string;
  logicalPath: string;
  title: string;
  summary: string | null;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
};

export type SearchProjectionRepository = {
  persistDocument: (input: {
    document: BodySearchDocument;
    completedAt: string;
  }) => Promise<{
    status: "created" | "reused";
    document: SearchProjectionDocumentRecord;
  }>;
  findReadyDocument: (
    input: SearchProjectionIdentity
  ) => Promise<SearchProjectionDocumentRecord | null>;
  attachGenerationReference: (
    input: GenerationSearchProjectionReference
  ) => Promise<void>;
  deleteGenerationReferences: (input: {
    knowledgeBaseId: string;
    generationId: string;
    sourceFileIds: string[];
  }) => Promise<number>;
  cleanupUnreferencedDocuments: (input: {
    olderThan: string;
    limit: number;
  }) => Promise<number>;
};
