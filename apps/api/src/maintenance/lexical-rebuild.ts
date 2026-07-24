import { randomUUID } from "node:crypto";
import { persistBodySearchProjection } from "../application/body-search-projection.js";
import type { LexicalRebuildRepository } from "../application/ports/lexical-rebuild-repository.js";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import type { SearchProjectionRepository } from "../application/ports/search-projection-repository.js";
import type { FileGraphRepository } from "../db/admin-repositories.js";
import { CONTENT_PROFILE_VERSION } from "../graph/content-profile.js";
import { createGraphNode } from "../graph/graph-node-profile.js";
import {
  buildGraphTermDocument,
  GRAPH_LEXICAL_PROJECTION_VERSION
} from "../graph/graph-term-document.js";
import { mapWithConcurrency } from "../runtime/bounded.js";
import { BODY_SEARCH_SCHEMA_VERSION } from "../search/body-search-document.js";
import { BODY_SEGMENTATION_VERSION } from "../search/body-segmentation.js";
import type { StorageAdapter } from "../storage/s3.js";

export type LexicalRebuildEvent =
  | { type: "bootstrap"; scheduledCount: number }
  | {
      type: "claim";
      knowledgeBaseId: string;
      targetGenerationId: string;
      phase: string;
      leaseRecovered: boolean;
    }
  | {
      type: "lease_recovery";
      knowledgeBaseId: string;
      targetGenerationId: string;
      phase: string;
    }
  | {
      type: "slice_completed";
      knowledgeBaseId: string;
      phase: string;
      processed: number;
      processedSourceCount: number;
      totalSourceCount: number;
    }
  | {
      type: "validation";
      knowledgeBaseId: string;
      passed: boolean;
    }
  | {
      type: "activation";
      knowledgeBaseId: string;
      targetGenerationId: string;
    }
  | {
      type: "rebase";
      knowledgeBaseId: string;
      targetGenerationId: string;
    }
  | {
      type: "cleanup";
      knowledgeBaseId: string;
      deletedDocumentCount: number;
    }
  | {
      type: "retry";
      knowledgeBaseId: string;
      phase: string;
      attemptCount: number;
      maxAttempts: number;
      errorCode: string;
    }
  | {
      type: "failure";
      knowledgeBaseId: string;
      phase: string;
      attemptCount: number;
      maxAttempts: number;
      errorCode: string;
    }
  | {
      type: "rollback";
      knowledgeBaseId: string;
      targetGenerationId: string;
      outcome: "active_generation_preserved";
    };

export async function runLexicalRebuildSlice(input: {
  rebuilds: LexicalRebuildRepository;
  search: SearchProjectionRepository;
  graph: Pick<FileGraphRepository, "upsertGraphNode" | "upsertGraphTermDocument">;
  storage: Pick<StorageAdapter, "getObjectText">;
  tokenizer: LexicalTokenizer;
  workerId: string;
  leaseToken: string;
  now: string;
  leaseExpiresAt: string;
  batchSize: number;
  concurrency: number;
  retryDelayMs: number;
  cleanupRetentionMs?: number;
  leaseDurationMs?: number;
  clock?: () => Date;
  onEvent?: (event: LexicalRebuildEvent) => void;
}): Promise<{
  knowledgeBaseId: string | null;
  phase: string;
  processed: number;
  completed: boolean;
  failed: boolean;
}> {
  const scheduledCount = await input.rebuilds.bootstrap({
    searchSchemaVersion: BODY_SEARCH_SCHEMA_VERSION,
    tokenizerContractVersion: input.tokenizer.contractVersion,
    segmentationVersion: BODY_SEGMENTATION_VERSION,
    contentProfileVersion: CONTENT_PROFILE_VERSION,
    graphLexicalProjectionVersion: GRAPH_LEXICAL_PROJECTION_VERSION,
    now: input.now
  });
  emitEvent(input.onEvent, {
    type: "bootstrap",
    scheduledCount
  });
  const claim = await input.rebuilds.claimNext({
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    targetGenerationId: `generation-lexical-${randomUUID()}`,
    now: input.now,
    leaseExpiresAt: input.leaseExpiresAt
  });
  if (!claim) {
    return {
      knowledgeBaseId: null,
      phase: "idle",
      processed: 0,
      completed: false,
      failed: false
    };
  }
  emitEvent(input.onEvent, {
    type: "claim",
    knowledgeBaseId: claim.knowledgeBaseId,
    targetGenerationId: claim.targetGenerationId,
    phase: claim.phase,
    leaseRecovered: claim.leaseRecovered
  });
  if (claim.leaseRecovered) {
    emitEvent(input.onEvent, {
      type: "lease_recovery",
      knowledgeBaseId: claim.knowledgeBaseId,
      targetGenerationId: claim.targetGenerationId,
      phase: claim.phase
    });
  }
  try {
    if (claim.phase === "documents" || claim.phase === "reconcile") {
      if (claim.phase === "reconcile") {
        await input.rebuilds.removeStaleGenerationReferences({
          knowledgeBaseId: claim.knowledgeBaseId,
          targetGenerationId: claim.targetGenerationId
        });
      }
      const sources = await input.rebuilds.listSourceBatch({
        knowledgeBaseId: claim.knowledgeBaseId,
        targetGenerationId: claim.phase === "reconcile"
          ? claim.targetGenerationId
          : null,
        afterSourceFileId: claim.sourceCursor,
        limit: input.batchSize
      });
      if (sources.length === 0) {
        await input.rebuilds.advancePhase({
          knowledgeBaseId: claim.knowledgeBaseId,
          workerId: input.workerId,
          leaseToken: input.leaseToken,
          phase: claim.phase === "documents" ? "reconcile" : "validate",
          updatedAt: input.now
        });
        emitSliceCompleted(input.onEvent, claim, 0);
        return result(claim.knowledgeBaseId, claim.phase, 0, false, false);
      }
      const processingChunkSize = Math.max(
        1,
        Math.min(sources.length, Math.max(input.concurrency, 50))
      );
      let progressAt = input.now;
      for (let offset = 0; offset < sources.length; offset += processingChunkSize) {
        const chunk = sources.slice(offset, offset + processingChunkSize);
        await mapWithConcurrency(chunk, input.concurrency, async (source) => {
          const body = await input.storage.getObjectText(source.objectKey);
          if (body === null) throw new Error("A lexical rebuild source object is unavailable");
          const node = createGraphNode({
            sourceFileId: source.sourceFileId,
            sourceRelativePath: source.relativePath,
            metadata: source.metadata,
            body,
            suggestions: source.suggestions,
            tokenizer: input.tokenizer
          });
          const document = await persistBodySearchProjection({
            repository: input.search,
            tokenizer: input.tokenizer,
            knowledgeBaseId: claim.knowledgeBaseId,
            sourceFileId: source.sourceFileId,
            sourceRevisionId: source.sourceRevisionId,
            relativePath: source.relativePath,
            title: node.title,
            summary: node.summary ?? node.description ?? source.summary,
            body,
            completedAt: input.now
          });
          await input.search.attachGenerationReference({
            knowledgeBaseId: claim.knowledgeBaseId,
            generationId: claim.targetGenerationId,
            sourceFileId: source.sourceFileId,
            sourceRevisionId: source.sourceRevisionId,
            searchDocumentId: document.documentId,
            searchSchemaVersion: document.searchSchemaVersion,
            tokenizerContractVersion: document.tokenizerContractVersion,
            segmentationVersion: document.segmentationVersion,
            logicalPath: `pages/${source.relativePath}`,
            title: node.title,
            summary: node.summary ?? node.description ?? source.summary,
            sourceUrl: source.sourceUrl,
            metadata: node.metadata ?? {}
          });
          await input.graph.upsertGraphNode({
            knowledgeBaseId: claim.knowledgeBaseId,
            node
          });
          await input.graph.upsertGraphTermDocument({
            knowledgeBaseId: claim.knowledgeBaseId,
            document: buildGraphTermDocument({
              sourceFileId: source.sourceFileId,
              sourceRevisionId: source.sourceRevisionId,
              title: node.title,
              body,
              headings: node.headings ?? [],
              phrases: readProfileTerms(node.metadata ?? {}, "evidencePhrases"),
              entities: node.entities ?? [],
              explicitReferences: node.explicitReferences ?? [],
              supplementalTerms: [
                ...(node.subjects ?? []),
                ...(node.tags ?? []),
                ...(node.keywords ?? []),
                ...(node.relationshipHints ?? [])
              ],
              tokenizer: input.tokenizer
            })
          });
        });
        const heartbeatAt = (input.clock?.() ?? new Date()).toISOString();
        if (Date.parse(heartbeatAt) > Date.parse(progressAt)) {
          progressAt = heartbeatAt;
        }
        const leaseDurationMs = input.leaseDurationMs ?? Math.max(
          1_000,
          Date.parse(input.leaseExpiresAt) - Date.parse(input.now)
        );
        await input.rebuilds.heartbeat({
          knowledgeBaseId: claim.knowledgeBaseId,
          workerId: input.workerId,
          leaseToken: input.leaseToken,
          heartbeatAt,
          leaseExpiresAt: new Date(
            Date.parse(heartbeatAt) + leaseDurationMs
          ).toISOString()
        });
      }
      await input.rebuilds.recordDocumentProgress({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        sourceCursor: sources.at(-1)!.sourceFileId,
        processedCount: sources.length,
        updatedAt: progressAt
      });
      emitSliceCompleted(input.onEvent, claim, sources.length);
      return result(claim.knowledgeBaseId, claim.phase, sources.length, false, false);
    }
    if (claim.phase === "validate") {
      const validation = await input.rebuilds.validate({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        contentProfileVersion: CONTENT_PROFILE_VERSION,
        graphLexicalProjectionVersion: GRAPH_LEXICAL_PROJECTION_VERSION
      });
      emitEvent(input.onEvent, {
        type: "validation",
        knowledgeBaseId: claim.knowledgeBaseId,
        passed: validation.passed
      });
      if (!validation.passed) throw new Error(validation.reason ?? "Lexical rebuild validation failed");
      await input.rebuilds.advancePhase({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        phase: "activate",
        updatedAt: input.now
      });
      return result(claim.knowledgeBaseId, claim.phase, 0, false, false);
    }
    if (claim.phase === "activate") {
      const activation = await input.rebuilds.activate({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        activatedAt: input.now
      });
      emitEvent(input.onEvent, activation === "activated"
        ? {
            type: "activation",
            knowledgeBaseId: claim.knowledgeBaseId,
            targetGenerationId: claim.targetGenerationId
          }
        : {
            type: "rebase",
            knowledgeBaseId: claim.knowledgeBaseId,
            targetGenerationId: claim.targetGenerationId
          });
      return result(claim.knowledgeBaseId, claim.phase, 0, false, false);
    }
    const cleanupRetentionMs = Math.max(
      0,
      input.cleanupRetentionMs ?? 24 * 60 * 60 * 1_000
    );
    const deletedDocumentCount = await input.search.cleanupUnreferencedDocuments({
      olderThan: new Date(
        Date.parse(input.now) - cleanupRetentionMs
      ).toISOString(),
      limit: input.batchSize
    });
    await input.rebuilds.complete({
      knowledgeBaseId: claim.knowledgeBaseId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      completedAt: input.now
    });
    emitEvent(input.onEvent, {
      type: "cleanup",
      knowledgeBaseId: claim.knowledgeBaseId,
      deletedDocumentCount
    });
    return result(claim.knowledgeBaseId, claim.phase, 0, true, false);
  } catch (error) {
    const errorCode = "LEXICAL_REBUILD_SLICE_FAILED";
    const failure = await input.rebuilds.fail({
      knowledgeBaseId: claim.knowledgeBaseId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      errorCode,
      errorMessage: error instanceof Error ? error.message : "Lexical rebuild failed",
      failedAt: input.now,
      retryDelayMs: input.retryDelayMs
    });
    emitEvent(input.onEvent, failure.terminal
      ? {
          type: "failure",
          knowledgeBaseId: claim.knowledgeBaseId,
          phase: claim.phase,
          attemptCount: failure.attemptCount,
          maxAttempts: failure.maxAttempts,
          errorCode
        }
      : {
          type: "retry",
          knowledgeBaseId: claim.knowledgeBaseId,
          phase: claim.phase,
          attemptCount: failure.attemptCount,
          maxAttempts: failure.maxAttempts,
          errorCode
        });
    if (failure.terminal) {
      emitEvent(input.onEvent, {
        type: "rollback",
        knowledgeBaseId: claim.knowledgeBaseId,
        targetGenerationId: claim.targetGenerationId,
        outcome: "active_generation_preserved"
      });
    }
    return result(claim.knowledgeBaseId, claim.phase, 0, false, true);
  }
}

function emitSliceCompleted(
  onEvent: ((event: LexicalRebuildEvent) => void) | undefined,
  claim: {
    knowledgeBaseId: string;
    phase: string;
    processedSourceCount: number;
    totalSourceCount: number;
  },
  processed: number
): void {
  emitEvent(onEvent, {
    type: "slice_completed",
    knowledgeBaseId: claim.knowledgeBaseId,
    phase: claim.phase,
    processed,
    processedSourceCount: Math.min(
      claim.totalSourceCount,
      claim.processedSourceCount + processed
    ),
    totalSourceCount: claim.totalSourceCount
  });
}

function emitEvent(
  onEvent: ((event: LexicalRebuildEvent) => void) | undefined,
  event: LexicalRebuildEvent
): void {
  onEvent?.(event);
}

function readProfileTerms(metadata: Record<string, unknown>, key: string): string[] {
  const profile = metadata.contentProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return [];
  const value = (profile as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function result(
  knowledgeBaseId: string,
  phase: string,
  processed: number,
  completed: boolean,
  failed: boolean
) {
  return { knowledgeBaseId, phase, processed, completed, failed };
}
