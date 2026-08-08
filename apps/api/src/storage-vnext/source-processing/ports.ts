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
  }): Promise<{
    outcome: "active" | "candidate";
    candidatePublicId: string;
    releaseOperationPublicId: string;
  }>;
};

export type StorageVnextSourceProcessingPorts = {
  workflow: StorageVnextSourceProcessingWorkflowPort;
  catalog: StorageVnextSourceProcessingCatalogPort;
  bodyStore: StorageVnextSourceBodyReadPort;
  model: StorageVnextSourceModelPort;
  handoff: StorageVnextSourceReleaseHandoffPort;
  events: StorageVnextSourceEventWritePort;
};
