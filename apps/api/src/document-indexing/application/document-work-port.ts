import type { DocumentResourceLane } from "./document-fixed-dag-scheduler.js";
import type { DocumentWorkKind } from "../domain/document-work-graph.js";

export type DocumentArtifactWorkState =
  | "waiting"
  | "running"
  | "waiting_on_projection"
  | "completed"
  | "error"
  | "cancelled"
  | "superseded";

export type DocumentReceiptKind =
  | "parsed_source"
  | "first_layer"
  | "graphrag"
  | "embedding"
  | "search_family"
  | "relation_reconciliation"
  | "generated_page"
  | "validation"
  | "activation"
  | "cleanup";

export type ClaimedDocumentArtifactWork = {
  publicId: string;
  knowledgeBaseId: string;
  documentJobPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  kind: DocumentWorkKind;
  resourceLane: DocumentResourceLane;
  inputFingerprintSha256: string;
  attemptCount: number;
  maximumAttempts: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  startedAt: string;
};

export type DocumentArtifactWorkRepository = {
  createFixedGraph(input: {
    knowledgeBaseId: string;
    documentJobPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    inputFingerprints: Record<DocumentWorkKind, string>;
    maximumAttempts: number;
    acceptedAt: string;
  }): Promise<void>;
  claim(input: {
    kind: DocumentWorkKind;
    resourceLane: DocumentResourceLane;
    workerId: string;
    limit: number;
    now: string;
    leaseDurationMs: number;
  }): Promise<readonly ClaimedDocumentArtifactWork[]>;
  complete(input: {
    publicId: string;
    workerId: string;
    now: string;
    receipt: {
      kind: DocumentReceiptKind;
      key: string;
      inputFingerprintSha256: string;
      outputFingerprintSha256: string;
      value: Readonly<Record<string, unknown>>;
    };
  }): Promise<boolean>;
  heartbeat(input: {
    publicId: string;
    workerId: string;
    now: string;
    leaseDurationMs: number;
  }): Promise<boolean>;
  fail(input: {
    publicId: string;
    workerId: string;
    now: string;
    errorCode: string;
    safeMessage: string | null;
    retryable: boolean;
    nextEligibleAt: string | null;
  }): Promise<"retrying" | "error" | null>;
  defer?(input: {
    publicId: string;
    workerId: string;
    now: string;
    nextEligibleAt: string;
  }): Promise<boolean>;
  recoverExpired(input: {
    now: string;
    retryAt: string;
    limit: number;
  }): Promise<number>;
};
