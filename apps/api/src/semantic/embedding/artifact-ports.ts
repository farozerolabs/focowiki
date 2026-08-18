import type { EmbeddingArtifactIdentity } from "../domain/contracts.js";
import type { OkfSearchSignals } from
  "../../storage-vnext/search/okf-signals.js";

export class EmbeddingArtifactObjectUnavailableError extends Error {
  public constructor() {
    super("Embedding artifact object is unavailable");
    this.name = "EmbeddingArtifactObjectUnavailableError";
  }
}

export type EmbeddingArtifactRecord = EmbeddingArtifactIdentity & {
  publicId: string;
  objectId: string;
  storageKey: string;
  vectorChecksumSha256: string;
  byteCount: number;
  state: "registered" | "verified" | "failed" | "orphaned";
};

export type EmbeddingArtifactSourceReference = {
  artifact: EmbeddingArtifactRecord;
  sourceFilePublicId: string;
  evidenceTargetPath: string;
  sourceExcerpt: string;
  fileKind: string;
  okfSignals: OkfSearchSignals;
};

export type EmbeddingArtifactDescriptor = {
  objectId: string;
  storageKey: string;
  checksumSha256: string;
  byteCount: number;
  contentType: "application/octet-stream";
  objectFormat: "semantic-vector-v1";
};

export type EmbeddingArtifactStorePort = {
  describe(bytes: Uint8Array): EmbeddingArtifactDescriptor;
  putVerified(input: {
    descriptor: EmbeddingArtifactDescriptor;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<"stored" | "reused">;
  readVerified(input: {
    descriptor: EmbeddingArtifactDescriptor;
    maximumBytes: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  deleteIfUnowned(input: {
    descriptor: EmbeddingArtifactDescriptor;
    signal?: AbortSignal;
  }): Promise<void>;
};

export type EmbeddingArtifactRepositoryPort = {
  findCompatible(identity: EmbeddingArtifactIdentity): Promise<EmbeddingArtifactRecord | null>;
  findReusable(identity: EmbeddingArtifactIdentity): Promise<EmbeddingArtifactRecord | null>;
  reserveObject(input: {
    descriptor: EmbeddingArtifactDescriptor;
    writeAttemptPublicId: string;
    createdAt: string;
  }): Promise<"reserved" | "reused">;
  commitVerified(input: {
    identity: EmbeddingArtifactIdentity;
    artifactPublicId: string;
    descriptor: EmbeddingArtifactDescriptor;
    writeAttemptPublicId: string;
    vectorChecksumSha256: string;
    semanticGenerationPublicId: string;
    operationPublicId: string | null;
    sourceFilePublicId: string;
    sourceExcerpt: string;
    retentionKind: "candidate" | "active" | "retry" | "cleanup";
    verifiedAt: string;
    replaceUnavailable?: {
      artifactPublicId: string;
      objectId: string;
    };
  }): Promise<EmbeddingArtifactRecord>;
  reuseVerified(input: {
    sourceArtifact: EmbeddingArtifactRecord;
    identity: EmbeddingArtifactIdentity;
    artifactPublicId: string;
    semanticGenerationPublicId: string;
    operationPublicId: string | null;
    sourceFilePublicId: string;
    sourceExcerpt: string;
    retentionKind: "candidate" | "active" | "retry" | "cleanup";
    reusedAt: string;
  }): Promise<EmbeddingArtifactRecord>;
  attachReference(input: {
    artifact: EmbeddingArtifactRecord;
    semanticGenerationPublicId: string;
    operationPublicId: string | null;
    sourceFilePublicId: string;
    sourceExcerpt: string;
    retentionKind: "candidate" | "active" | "retry" | "cleanup";
  }): Promise<void>;
  listSourceReferences(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    limit: number;
  }): Promise<readonly EmbeddingArtifactSourceReference[]>;
  markWriteFailed(input: {
    descriptor: EmbeddingArtifactDescriptor;
    writeAttemptPublicId: string;
    safeCode: string;
    failedAt: string;
  }): Promise<void>;
  releaseReferences(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    ownerPublicIds: readonly string[] | null;
    releasedAt: string;
  }): Promise<number>;
  releaseSupersededSourceReferences(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    currentSourceRevisionPublicId: string;
    releasedAt: string;
    limit: number;
  }): Promise<number>;
  listOrphaned(input: {
    knowledgeBaseId: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ items: EmbeddingArtifactRecord[]; nextCursor: string | null }>;
  claimOrphaned(input: {
    knowledgeBaseId: string;
    artifactPublicId: string;
    claimedAt: string;
  }): Promise<{
    artifactPublicId: string;
    descriptor: EmbeddingArtifactDescriptor | null;
  } | null>;
  completeOrphanDeletion(input: {
    knowledgeBaseId: string;
    artifactPublicId: string;
    descriptor: EmbeddingArtifactDescriptor | null;
    completedAt: string;
  }): Promise<boolean>;
  abandonOrphanDeletion(input: {
    knowledgeBaseId: string;
    artifactPublicId: string;
    descriptor: EmbeddingArtifactDescriptor | null;
  }): Promise<void>;
};
