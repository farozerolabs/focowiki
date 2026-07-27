import type { SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";

export type LexicalRebuildClaim = {
  knowledgeBaseId: string;
  baseGenerationId: string;
  targetGenerationId: string;
  leaseRecovered: boolean;
  state: "running" | "validating" | "activating";
  phase: "documents" | "reconcile" | "validate" | "activate" | "cleanup";
  sourceCursor: string | null;
  processedSourceCount: number;
  totalSourceCount: number;
};

export type LexicalRebuildSource = {
  sourceFileId: string;
  sourceRevisionId: string;
  relativePath: string;
  objectKey: string;
  title: string;
  summary: string | null;
  sourceUrl: string | null;
  metadata: SourceMetadataDefaults;
  suggestions: SourceModelSuggestions | null;
};

export type LexicalRebuildRepository = {
  bootstrap: (input: {
    searchSchemaVersion: string;
    tokenizerContractVersion: string;
    segmentationVersion: string;
    contentProfileVersion: string;
    graphLexicalProjectionVersion: string;
    now: string;
  }) => Promise<number>;
  claimNext: (input: {
    workerId: string;
    leaseToken: string;
    targetGenerationId: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<LexicalRebuildClaim | null>;
  listSourceBatch: (input: {
    knowledgeBaseId: string;
    targetGenerationId: string | null;
    afterSourceFileId: string | null;
    limit: number;
  }) => Promise<LexicalRebuildSource[]>;
  removeStaleGenerationReferences: (input: {
    knowledgeBaseId: string;
    targetGenerationId: string;
  }) => Promise<number>;
  heartbeat: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    heartbeatAt: string;
    leaseExpiresAt: string;
  }) => Promise<void>;
  recordDocumentProgress: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    sourceCursor: string;
    processedCount: number;
    updatedAt: string;
  }) => Promise<void>;
  advancePhase: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    phase: LexicalRebuildClaim["phase"];
    updatedAt: string;
  }) => Promise<void>;
  validate: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    contentProfileVersion: string;
    graphLexicalProjectionVersion: string;
  }) => Promise<{ passed: boolean; reason: string | null }>;
  activate: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    activatedAt: string;
    retryDelayMs: number;
  }) => Promise<"activated" | "rebased" | "deferred">;
  complete: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    completedAt: string;
  }) => Promise<void>;
  fail: (input: {
    knowledgeBaseId: string;
    workerId: string;
    leaseToken: string;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
    retryDelayMs: number;
  }) => Promise<{
    attemptCount: number;
    maxAttempts: number;
    terminal: boolean;
  }>;
};
