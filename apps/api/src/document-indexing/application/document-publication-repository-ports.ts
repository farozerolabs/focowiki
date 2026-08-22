import type {
  DocumentFactEpoch,
  DocumentLeaseGeneration,
  DocumentPublicationGenerationId,
  DocumentScopeGeneration
} from "../domain/document-publication-identifiers.js";
import type { DocumentPublicationRecoveryDecision } from
  "./document-publication-recovery.js";

export type DocumentProjectionHead = Readonly<{
  knowledgeBaseId: string;
  activeGenerationId: DocumentPublicationGenerationId | null;
  activeFactEpoch: number;
  headVersion: number;
}>;

export type DocumentPublicationGeneration = Readonly<{
  publicId: DocumentPublicationGenerationId;
  knowledgeBaseId: string;
  baseGenerationId: DocumentPublicationGenerationId | null;
  targetFactEpoch: number;
  rendererContractVersion: string;
  deterministicChangedAt: string;
  state: "planned" | "rendering" | "validating" | "ready"
    | "active" | "obsolete" | "quarantined";
  inputFingerprintSha256: string;
  outputFingerprintSha256: string | null;
}>;

export interface DocumentPublicationRepository {
  allocateFactEpoch(input: Readonly<{
    knowledgeBaseId: string;
    mutationPublicId: string;
    mutationGroupPublicId?: string;
    sourceFilePublicId: string | null;
    sourceRevisionPublicId: string | null;
    factKind: "create" | "replace" | "move" | "delete" | "repair" | "shadow";
    createdAt: string;
  }>): Promise<DocumentFactEpoch>;
  readHead(knowledgeBaseId: string): Promise<DocumentProjectionHead>;
  createGeneration(input: Readonly<{
    publicId: DocumentPublicationGenerationId;
    knowledgeBaseId: string;
    baseGenerationId: DocumentPublicationGenerationId | null;
    targetFactEpoch: number;
    rendererContractVersion: string;
    deterministicChangedAt: string;
    inputFingerprintSha256: string;
  }>): Promise<DocumentPublicationGeneration>;
  addDocuments(input: Readonly<{
    generationId: DocumentPublicationGenerationId;
    documents: readonly Readonly<{
      mutationPublicId: string;
      documentJobPublicId: string | null;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      factEpoch: DocumentFactEpoch;
    }>[];
  }>): Promise<number>;
  listGenerations(input: Readonly<{
    knowledgeBaseId: string;
    limit: number;
    cursor: Readonly<{
      targetFactEpoch: number;
      publicId: DocumentPublicationGenerationId;
    }> | null;
  }>): Promise<Readonly<{
    items: readonly DocumentPublicationGeneration[];
    nextCursor: Readonly<{
      targetFactEpoch: number;
      publicId: DocumentPublicationGenerationId;
    }> | null;
  }>>;
  setRetention(input: Readonly<{
    generationId: DocumentPublicationGenerationId;
    state: "retained" | "eligible" | "deleting" | "deleted";
    retainUntil: string | null;
    reason: string;
    updatedAt: string;
  }>): Promise<void>;
}

export interface DocumentProjectionOwnershipRepository {
  transferArtifacts(input: Readonly<{
    knowledgeBaseId: string;
    generationId: DocumentPublicationGenerationId;
    ownershipEpoch: DocumentFactEpoch;
    owners: readonly Readonly<{
      normalizedPath: string;
      ownerScopeIdentity: string;
      artifactFamily: "source" | "page_directory" | "machine_index"
        | "term" | "graph" | "graph_catalog" | "root";
    }>[];
    updatedAt: string;
  }>): Promise<number>;
  transferDirectories(input: Readonly<{
    knowledgeBaseId: string;
    generationId: DocumentPublicationGenerationId;
    ownershipEpoch: DocumentFactEpoch;
    owners: readonly Readonly<{
      directoryPath: string;
      ownerScopeIdentity: string;
    }>[];
    updatedAt: string;
  }>): Promise<number>;
}

export interface DocumentScopeGenerationRepository {
  create(input: Readonly<{
    publicId: string;
    publicationGenerationId: DocumentPublicationGenerationId;
    knowledgeBaseId: string;
    scopeIdentity: string;
    scopeKind: "source" | "relation" | "directory" | "graph"
      | "_index" | "_graph" | "root" | "validation";
    scopeKey: string;
    scopeGeneration: DocumentScopeGeneration;
    inputSnapshotFingerprintSha256: string;
    createdAt: string;
  }>): Promise<void>;
  claim(input: Readonly<{
    workerId: string;
    now: string;
    leaseDurationMs: number;
    limit: number;
  }>): Promise<readonly Readonly<{
    publicId: string;
    leaseGeneration: DocumentLeaseGeneration;
    knowledgeBaseId: string;
    publicationGenerationPublicId: string;
    scopeKind: string;
    safeScopeKeyHash: string;
    targetFactEpoch: number;
    activeFactEpoch: number;
    scopeGeneration: number;
  }>[] >;
  heartbeat(input: Readonly<{
    publicId: string;
    workerId: string;
    leaseGeneration: DocumentLeaseGeneration;
    now: string;
    leaseDurationMs: number;
  }>): Promise<boolean>;
  fail(input: Readonly<{
    publicId: string;
    workerId: string;
    leaseGeneration: DocumentLeaseGeneration;
    now: string;
    errorCode: string;
    recoveryAction: DocumentPublicationRecoveryDecision["action"];
  }>): Promise<"waiting" | "error" | "superseded" | "quarantined" | null>;
  recoverExpired(input: Readonly<{
    now: string;
    limit: number;
  }>): Promise<number>;
  persistSnapshotMembers(input: Readonly<{
    scopeGenerationPublicId: string;
    members: readonly Readonly<{
      kind: "source_revision" | "relation" | "directory" | "term"
        | "graph" | "base_owner" | "search_receipt" | "tombstone";
      publicId: string;
      version: string;
      order: number;
    }>[];
  }>): Promise<number>;
  reuseCompletedOutput(input: Readonly<{
    scopeGenerationPublicId: string;
    checkedAt: string;
  }>): Promise<boolean>;
  persistOutput(input: Readonly<{
    scopeGenerationPublicId: string;
    workerId: string;
    leaseGeneration: DocumentLeaseGeneration;
    checkedAt: string;
    outputFingerprintSha256: string;
    validationEvidence: Readonly<Record<string, unknown>>;
    pages: readonly Readonly<{
      logicalPath: string;
      normalizedPath: string;
      action: "put" | "delete";
      entryKind: string | null;
      objectId: string | null;
      checksumSha256: string | null;
      byteCount: number | null;
    }>[];
    navigationMutations: readonly Readonly<{
      directoryPath: string;
      order: number;
      action: "upsert" | "delete";
      mutation: Readonly<Record<string, unknown>>;
    }>[];
    verifiedReservations: readonly Readonly<{
      objectId: string;
      writeAttemptPublicId: string;
    }>[];
  }>): Promise<void>;
}
