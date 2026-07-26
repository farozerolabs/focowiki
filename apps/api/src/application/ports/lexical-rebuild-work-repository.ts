import type { OkfGraphNode, SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import type { GraphTermDocument } from "../../graph/graph-term-document.js";
import type { BodySearchDocument } from "../../search/body-search-document.js";
import type { LexicalRebuildClaim } from "./lexical-rebuild-repository.js";

export type LexicalRebuildSettingsSnapshot = {
  concurrency: number;
  sourceReadConcurrency: number;
  databaseWriteConcurrency: number;
  claimBatchSize: number;
  databaseBatchSize: number;
  maxInFlightSourceBytes: number;
};

export type LexicalRebuildWorkClaim = {
  knowledgeBaseId: string;
  targetGenerationId: string;
  sourceFileId: string;
  sourceRevisionId: string;
  logicalPath: string;
  leaseToken: string;
  attemptCount: number;
  maxAttempts: number;
  settingsRevision: number;
  settings: LexicalRebuildSettingsSnapshot;
};

export type LexicalRebuildWorkSource = LexicalRebuildWorkClaim & {
  relativePath: string;
  objectKey: string;
  sizeBytes: number;
  checksumSha256: string;
  title: string;
  summary: string | null;
  sourceUrl: string | null;
  metadata: SourceMetadataDefaults;
  suggestions: SourceModelSuggestions | null;
};

export type LexicalRebuildProjectionResult = {
  claim: LexicalRebuildWorkClaim;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
  searchDocument: BodySearchDocument;
  graphNode: OkfGraphNode;
  graphTermDocument: GraphTermDocument;
  sourceReadBytes: number;
  sourceReadLatencyMs: number;
  sourceReadRetries: number;
};

export type LexicalRebuildProgress = {
  knowledgeBaseId: string;
  targetGenerationId: string | null;
  state: string;
  phase: string;
  completed: number;
  pending: number;
  running: number;
  retrying: number;
  failed: number;
  total: number;
  sourceReadRetries: number;
  databaseRetries: number;
  recentFilesPerSecond: number | null;
  sourceReadLatencyMs: number | null;
  databaseBatchLatencyMs: number | null;
  lastProgressAt: string | null;
  lastHeartbeatAt: string | null;
  estimatedCompletionAt: string | null;
};

export type LexicalRebuildWorkRepository = {
  planNext: (input: {
    targetGenerationId: string;
    settingsRevision: number;
    settings: LexicalRebuildSettingsSnapshot;
    maxAttempts: number;
    now: string;
  }) => Promise<{
    knowledgeBaseId: string;
    targetGenerationId: string;
    planned: number;
    cancelled: number;
    readyForValidation: boolean;
  } | null>;
  claimBatch: (input: {
    workerId: string;
    leaseTokenPrefix: string;
    limit: number;
    settingsRevision: number;
    settings: LexicalRebuildSettingsSnapshot;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<LexicalRebuildWorkClaim[]>;
  loadSources: (claims: LexicalRebuildWorkClaim[]) => Promise<LexicalRebuildWorkSource[]>;
  heartbeat: (input: {
    workerId: string;
    claims: LexicalRebuildWorkClaim[];
    heartbeatAt: string;
    leaseExpiresAt: string;
  }) => Promise<number>;
  persistBatch: (input: {
    workerId: string;
    results: LexicalRebuildProjectionResult[];
    completedAt: string;
  }) => Promise<void>;
  retry: (input: {
    workerId: string;
    claims: LexicalRebuildWorkClaim[];
    stage: "source_read" | "database_write" | "derive";
    errorCode: string;
    errorMessage: string;
    failedAt: string;
    retryDelayMs: number;
  }) => Promise<void>;
  claimFinalization: (input: {
    workerId: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<LexicalRebuildClaim | null>;
  listProgress: () => Promise<LexicalRebuildProgress[]>;
};
