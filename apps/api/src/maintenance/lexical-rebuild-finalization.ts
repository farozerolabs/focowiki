import type { LexicalRebuildRepository } from "../application/ports/lexical-rebuild-repository.js";
import type { LexicalRebuildWorkRepository } from "../application/ports/lexical-rebuild-work-repository.js";
import type { SearchProjectionRepository } from "../application/ports/search-projection-repository.js";
import { CONTENT_PROFILE_VERSION } from "../graph/content-profile.js";
import { GRAPH_LEXICAL_PROJECTION_VERSION } from "../graph/graph-term-document.js";

export async function runLexicalRebuildFinalization(input: {
  work: Pick<LexicalRebuildWorkRepository, "claimFinalization">;
  rebuilds: Pick<
    LexicalRebuildRepository,
    "validate" | "advancePhase" | "activate" | "complete" | "fail"
  >;
  search: Pick<SearchProjectionRepository, "cleanupUnreferencedDocuments">;
  workerId: string;
  leaseToken: string;
  now: Date;
  leaseDurationMs: number;
  retryDelayMs: number;
  cleanupBatchSize: number;
}): Promise<boolean> {
  const now = input.now.toISOString();
  const claim = await input.work.claimFinalization({
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    now,
    leaseExpiresAt: new Date(
      input.now.getTime() + input.leaseDurationMs
    ).toISOString()
  });
  if (!claim) return false;

  try {
    if (claim.phase === "validate") {
      const validation = await input.rebuilds.validate({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        contentProfileVersion: CONTENT_PROFILE_VERSION,
        graphLexicalProjectionVersion: GRAPH_LEXICAL_PROJECTION_VERSION
      });
      if (!validation.passed) {
        throw new Error(validation.reason ?? "Lexical rebuild validation failed");
      }
      await input.rebuilds.advancePhase({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        phase: "activate",
        updatedAt: now
      });
      return true;
    }
    if (claim.phase === "activate") {
      await input.rebuilds.activate({
        knowledgeBaseId: claim.knowledgeBaseId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        activatedAt: now,
        retryDelayMs: input.retryDelayMs
      });
      return true;
    }
    await input.search.cleanupUnreferencedDocuments({
      olderThan: new Date(
        input.now.getTime() - 24 * 60 * 60 * 1_000
      ).toISOString(),
      limit: input.cleanupBatchSize
    });
    await input.rebuilds.complete({
      knowledgeBaseId: claim.knowledgeBaseId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      completedAt: now
    });
    return true;
  } catch (error) {
    await input.rebuilds.fail({
      knowledgeBaseId: claim.knowledgeBaseId,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      errorCode: "LEXICAL_REBUILD_FINALIZATION_FAILED",
      errorMessage: error instanceof Error
        ? error.message
        : "Lexical rebuild finalization failed",
      failedAt: now,
      retryDelayMs: input.retryDelayMs
    });
    return true;
  }
}
