import type { StorageVnextSourceBodyReadPort } from
  "../catalog/s3-source-body-store.js";
import type {
  StorageVnextCatalogRepository,
  StorageVnextSourceFileFact,
  StorageVnextSourceRevisionFact
} from "../catalog/ports.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import type {
  StorageVnextWorkflowClaimPort,
  StorageVnextWorkflowWritePort
} from "../workflow/ports.js";
import type { StorageVnextSourceEventWritePort } from "../source-events/ports.js";

export type StorageVnextSourceProcessingCatalogPort = Pick<
  StorageVnextCatalogRepository,
  | "getKnowledgeBase"
  | "getSourceFile"
  | "getSourceRevision"
  | "getCurrentSourceRevision"
  | "updateSourceFileState"
>;

export type StorageVnextSourceProcessingWorkflowPort = Pick<
  StorageVnextWorkflowClaimPort & StorageVnextWorkflowWritePort,
  "claim" | "saveCheckpoint" | "complete" | "releaseForRetry"
>;

export type StorageVnextSourceModelResult = {
  metadata: StorageVnextStructuredMetadata;
  node: StorageVnextGraphNodeFact;
  edges: readonly StorageVnextGraphEdgeFact[];
  modelAssistanceUsed: boolean;
  modelWarningCount?: number;
};

export type StorageVnextSourceModelPort = {
  extract(input: {
    knowledgeBaseId: string;
    sourceFile: StorageVnextSourceFileFact;
    sourceRevision: StorageVnextSourceRevisionFact;
    sourceRevisionPublicId: string;
    attemptPublicId: string;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
    onModelAssistanceStart?: () => Promise<void>;
  }): Promise<StorageVnextSourceModelResult>;
};

export type StorageVnextSourceReleaseHandoffPort = {
  apply(input: {
    operationPublicId: string;
    knowledgeBaseId: string;
    settingsRevisionPublicId: string;
    sourceFile: StorageVnextSourceFileFact;
    sourceRevisionPublicId: string;
    node: StorageVnextGraphNodeFact;
    edges: readonly StorageVnextGraphEdgeFact[];
    completedAt: string;
    publicationMode?: "immediate" | "semantic_final";
  }): Promise<{
    outcome: "active" | "candidate" | "deferred";
    candidatePublicId: string | null;
    releaseOperationPublicId: string | null;
  }>;
};

export type StorageVnextSemanticSourceHandoffPort = {
  enqueue(input: {
    operationPublicId: string;
    knowledgeBaseId: string;
    settingsRevisionPublicId: string;
    sourceFile: StorageVnextSourceFileFact;
    sourceRevision: StorageVnextSourceRevisionFact;
    skeletonGraphSignals?: {
      acceptedEdgeCount: number;
      inboundEdgeCount: number;
      outboundEdgeCount: number;
      distinctNeighborCount: number;
      relationKindCount: number;
      contentProfileHeadingCount?: number;
      contentProfileDefinitionCount?: number;
      contentProfileExplicitReferenceCount?: number;
    };
    enqueuedAt: string;
    resumeFromStage?: "publication";
  }): Promise<{
    state: "disabled" | "blocked" | "queued";
    semanticGenerationPublicId: string | null;
    stageCount: number;
    safeCode: string | null;
  }>;
};

export type StorageVnextSourceProcessingPorts = {
  workflow: StorageVnextSourceProcessingWorkflowPort;
  catalog: StorageVnextSourceProcessingCatalogPort;
  bodyStore: StorageVnextSourceBodyReadPort;
  model: StorageVnextSourceModelPort;
  handoff: StorageVnextSourceReleaseHandoffPort;
  semanticHandoff?: StorageVnextSemanticSourceHandoffPort;
  events: StorageVnextSourceEventWritePort;
};
