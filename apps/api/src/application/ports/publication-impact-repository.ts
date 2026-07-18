import type { SerializableJson } from "./source-dispatch-repository.js";
import type { ChangeFactKind, ProjectionKind } from "../../domain/generation.js";
import type { PublicationProjectionInput } from "./publication-projection-input.js";

export type ClaimedPublicationImpact = {
  id: string;
  knowledgeBaseId: string;
  generationId: string;
  changeFactId: string;
  changeKind: ChangeFactKind;
  sourceFileId: string | null;
  sourceRevisionId: string | null;
  previousPath: string | null;
  path: string | null;
  resourceRevision: number;
  projectionKind: ProjectionKind;
  projectionKey: string;
  recordIdentity: string;
  action: "upsert" | "delete" | "validate";
  retryCursor: SerializableJson;
  attemptCount: number;
  maxAttempts: number;
  projectionInput: PublicationProjectionInput | null;
};

export type PublicationImpactFailureResult = {
  terminal: boolean;
  attemptCount: number;
  maxAttempts: number;
};

export type PublicationImpactRepository = {
  claimBatch: (input: {
    knowledgeBaseId: string;
    generationId: string;
    workerId: string;
    limit: number;
    now: string;
    staleBefore: string;
  }) => Promise<ClaimedPublicationImpact[]>;
  heartbeat: (input: {
    impactIds: string[];
    workerId: string;
    heartbeatAt: string;
  }) => Promise<number>;
  release: (input: {
    impactIds: string[];
    workerId: string;
    releasedAt: string;
  }) => Promise<number>;
  complete: (input: {
    knowledgeBaseId: string;
    generationId: string;
    impactId: string;
    workerId: string;
    touchedShardCount: number;
    completedAt: string;
  }) => Promise<boolean>;
  fail: (input: {
    knowledgeBaseId: string;
    generationId: string;
    impactId: string;
    workerId: string;
    code: string;
    message: string;
    retryCursor: SerializableJson;
    retryAt: string;
    failedAt: string;
  }) => Promise<PublicationImpactFailureResult>;
  countIncomplete: (input: {
    knowledgeBaseId: string;
    generationId: string;
  }) => Promise<{ pending: number; running: number; failed: number }>;
};
