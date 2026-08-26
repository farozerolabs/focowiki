import type {
  DocumentPublicationItemOutcome,
  DocumentPublicationJobOutcome
} from "../domain/document-publication-job.js";

export type DocumentPublicationOperation =
  | "create" | "replace" | "move" | "rename" | "delete" | "repair";

export type DocumentPublicationRenderScope = Readonly<{
  publicId: string;
  knowledgeBaseId: string;
  kind: "source" | "relation" | "directory" | "graph"
    | "_index" | "_graph" | "root";
  key: string;
  requiredSequence: number;
  renderedSequence: number;
  deterministicEventTime?: string;
}>;

export type DocumentPublicationBasePage = Readonly<{
  logicalPath: string;
  normalizedPath: string;
  action: "put" | "delete";
  entryKind: string | null;
  objectId: string | null;
  checksumSha256: string | null;
  byteCount: number | null;
  storageKey: string | null;
  contentType: string | null;
  objectFormat: string | null;
}>;

export type DocumentPublicationItemInput = Readonly<{
  publicId: string;
  mutationPublicId: string;
  knowledgeBaseId: string;
  documentJobPublicId: string | null;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  operation: DocumentPublicationOperation;
  priorLogicalPath: string | null;
  nextLogicalPath: string | null;
  affectedEvidence: Readonly<Record<string, unknown>>;
  readinessSequence: number;
  createdAt: string;
}>;

export type DocumentPublicationItem = DocumentPublicationItemInput & Readonly<{
  outcome: DocumentPublicationItemOutcome;
}>;

export type DocumentPublicationJobOutput = Readonly<{
  normalizedPath: string;
  logicalPath: string;
  action: "put" | "delete";
  entryKind: string | null;
  sourceFilePublicId: string | null;
  sourceRevisionPublicId: string | null;
  objectId: string | null;
  checksumSha256: string | null;
  byteCount: number | null;
  contentType: string | null;
  producerFingerprintSha256: string;
  navigationMutations: readonly Readonly<Record<string, unknown>>[];
}>;

export type DocumentPublicationJob = Readonly<{
  publicId: string;
  knowledgeBaseId: string;
  baseActiveRevision: number;
  targetReadinessSequence: number;
  rendererContractVersion: string;
  settingsSnapshot: Readonly<Record<string, unknown>>;
  outcome: DocumentPublicationJobOutcome;
  attemptOwner: string | null;
  attemptToken: string | null;
  attemptStartedAt: string | null;
  attemptDeadline: string | null;
  attemptCount: number;
  manifestFingerprintSha256: string | null;
  deterministicEventTime: string;
  items: readonly DocumentPublicationItem[];
}>;

export interface DocumentPublicationJobRepository {
  createItem(input: DocumentPublicationItemInput):
    Promise<DocumentPublicationItem>;
  admitOne(input: Readonly<{
    now?: string;
    rendererContractVersion: string;
    settingsSnapshot?: Readonly<Record<string, unknown>>;
  }>): Promise<DocumentPublicationJob | null>;
  readJob(publicId: string): Promise<DocumentPublicationJob | null>;
  readNonterminalJob(knowledgeBaseId: string):
    Promise<DocumentPublicationJob | null>;
  claimOne(input: Readonly<{ workerId: string; now?: string }>):
    Promise<DocumentPublicationJob | null>;
  renewAttempt(input: Readonly<{
    jobPublicId: string;
    attemptToken: string;
    renewedAt?: string;
  }>): Promise<string | null>;
  releaseAttempt(input: Readonly<{
    jobPublicId: string;
    attemptToken: string;
    releasedAt?: string;
  }>): Promise<boolean>;
  persistManifest(input: Readonly<{
    jobPublicId: string;
    attemptToken: string;
    fingerprintSha256: string;
    outputs: readonly DocumentPublicationJobOutput[];
    persistedAt?: string;
  }>): Promise<boolean>;
  failAttempt(input: Readonly<{
    jobPublicId: string;
    attemptToken: string;
    failedAt?: string;
    errorCode: string;
    retryable: boolean;
  }>): Promise<"retrying" | "failed" | "fenced">;
}

export interface DocumentPublicationActivationRepository {
  activate(input: Readonly<{
    jobPublicId: string;
    attemptToken: string;
    activatedAt?: string;
  }>): Promise<Readonly<{
    knowledgeBaseId: string;
    activeRevision: number;
    documentCount: number;
    putCount: number;
    deleteCount: number;
  }>>;
}
