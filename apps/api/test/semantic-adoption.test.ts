import { describe, expect, it, vi } from "vitest";
import {
  createSemanticAdoptionService,
  semanticContractFingerprint
} from "../src/semantic/application/adoption.js";
import type { SemanticGenerationRecord } from
  "../src/semantic/application/ports.js";
import type { SemanticMaintenanceTarget } from
  "../src/semantic/domain/contracts.js";

const NOW = "2026-08-08T00:00:00.000Z";

describe("semantic adoption", () => {
  it("pages current sources into a stable candidate without publication work", async () => {
    const fixture = createFixture();
    const first = await fixture.service.planSourcePage(planRequest());

    expect(first.sourceCount).toBe(2);
    expect(first.stageCount).toBe(10);
    expect(first.nextCursor).toBe("page-2");
    expect(fixture.createCandidate).toHaveBeenCalledOnce();
    expect(fixture.createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      expectedPredecessorPublicId: "semantic-active",
      contractFingerprintSha256: semanticContractFingerprint(target())
    }));
    expect(fixture.enqueued.flatMap((batch) => batch.items)
      .map((item) => item.stageKind)).not.toContain("publication");
    expect(fixture.enqueued[0]?.items[0]?.settingsSnapshot).toMatchObject({
      semanticGenerationRole: "candidate",
      projectionContractPublicId: expect.stringContaining("semantic-contract-")
    });

    const second = await fixture.service.planSourcePage({
      ...planRequest(),
      cursor: first.nextCursor
    });
    expect(second.sourceCount).toBe(1);
    expect(second.stageCount).toBe(5);
    expect(second.nextCursor).toBeNull();
    expect(fixture.createCandidate).toHaveBeenCalledOnce();
  });

  it("clones predecessor graph facts once and plans only embedding work", async () => {
    const fixture = createFixture();
    const first = await fixture.service.planSourcePage({
      ...planRequest(),
      reusePredecessorFacts: true
    });

    expect(first.sourceCount).toBe(2);
    expect(first.stageCount).toBe(4);
    expect(fixture.cloneReusableFacts).toHaveBeenCalledOnce();
    expect(fixture.cloneReusableFacts).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      predecessorPublicId: "semantic-active",
      candidatePublicId: expect.stringContaining("semantic-generation-")
    });
    expect(fixture.enqueued.flatMap((batch) => batch.items)
      .map((item) => item.stageKind)).toEqual([
        "embedding", "vector", "embedding", "vector"
      ]);

    const second = await fixture.service.planSourcePage({
      ...planRequest(),
      reusePredecessorFacts: true,
      cursor: first.nextCursor
    });
    expect(second.stageCount).toBe(2);
    expect(fixture.cloneReusableFacts).toHaveBeenCalledOnce();
  });

  it("waits for bounded stage work, then validates and CAS-activates the candidate", async () => {
    const fixture = createFixture();
    await fixture.service.planSourcePage(planRequest());
    fixture.summary.pendingCount = 1;

    await expect(fixture.service.validateCandidate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-1"
    })).resolves.toMatchObject({ outcome: "pending" });
    expect(fixture.transitionCandidate).not.toHaveBeenCalled();

    fixture.summary.pendingCount = 0;
    fixture.summary.completedCount = fixture.summary.totalCount;
    await expect(fixture.service.validateCandidate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-1"
    })).resolves.toMatchObject({
      outcome: "ready",
      candidate: { state: "ready" }
    });
    expect(fixture.transitionCandidate).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ fromState: "building", toState: "validating" }));
    expect(fixture.transitionCandidate).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ fromState: "validating", toState: "ready" }));

    await fixture.service.activateCandidate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-1",
      activatedAt: NOW
    });
    expect(fixture.activateCandidate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      candidatePublicId: expect.stringContaining("semantic-generation-"),
      expectedPredecessorPublicId: "semantic-active",
      expectedCandidateRevision: 2,
      activatedAt: NOW
    });
  });

  it("cancels every stage and makes late candidate output ineligible", async () => {
    const fixture = createFixture();
    await fixture.service.planSourcePage(planRequest());

    await expect(fixture.service.cancel({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-1",
      requestedAt: NOW
    })).resolves.toMatchObject({ state: "cancelled" });
    expect(fixture.requestCancellation).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: expect.stringContaining("semantic-generation-"),
      sourceFilePublicIds: null,
      requestedAt: NOW
    });
  });

  it("fails the candidate when any terminal stage fails", async () => {
    const fixture = createFixture();
    await fixture.service.planSourcePage(planRequest());
    fixture.summary.failedCount = 1;

    await expect(fixture.service.validateCandidate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-1"
    })).rejects.toMatchObject({ code: "semantic_adoption_stage_failed" });
    expect(fixture.transitionCandidate).toHaveBeenCalledWith(expect.objectContaining({
      toState: "failed"
    }));
  });
});

function createFixture() {
  let candidate: SemanticGenerationRecord | null = null;
  const createCandidate = vi.fn(async (input: {
    candidatePublicId: string;
    operationPublicId: string;
    expectedPredecessorPublicId: string | null;
    contractFingerprintSha256: string;
  }) => {
    candidate = {
      publicId: input.candidatePublicId,
      knowledgeBaseId: "kb-1",
      operationPublicId: input.operationPublicId,
      expectedPredecessorPublicId: input.expectedPredecessorPublicId,
      role: "candidate",
      state: "building",
      contractFingerprintSha256: input.contractFingerprintSha256,
      revision: 0
    };
    return candidate;
  });
  const transitionCandidate = vi.fn(async (input: {
    toState: SemanticGenerationRecord["state"];
  }) => {
    candidate = { ...candidate!, state: input.toState, revision: candidate!.revision + 1 };
    return candidate;
  });
  const activateCandidate = vi.fn(async () => ({
    ...candidate!, role: "active" as const, state: "active" as const,
    revision: candidate!.revision + 1
  }));
  const enqueued: Array<{ items: ReadonlyArray<{
    stageKind: string;
    settingsSnapshot: Record<string, unknown>;
  }> }> = [];
  const summary = {
    totalCount: 15,
    completedCount: 0,
    pendingCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    supersededCount: 0,
    reusedArtifactCount: 0
  };
  const requestCancellation = vi.fn(async () => 15);
  const cloneReusableFacts = vi.fn(async () => ({ sourceCount: 3, factCount: 30 }));
  const service = createSemanticAdoptionService({
    generations: {
      createCandidate,
      getCandidateByOperation: vi.fn(async () => candidate),
      transitionCandidate,
      activateCandidate,
      adoptQueryPolicy: vi.fn(async () => true),
      cloneReusableFacts
    },
    stages: {
      async enqueue(input) {
        enqueued.push(input);
        return input.items.length;
      },
      summarizeOperation: vi.fn(async () => ({ ...summary })),
      requestCancellation
    },
    catalog: {
      async listCurrentSources(input) {
        return {
          items: input.cursor
            ? [currentSource("c")]
            : [currentSource("a"), currentSource("b"), currentSource("failed", "failed")],
          nextCursor: input.cursor ? null : "page-2"
        };
      }
    }
  });
  return {
    service,
    createCandidate,
    transitionCandidate,
    activateCandidate,
    requestCancellation,
    cloneReusableFacts,
    enqueued,
    summary
  };
}

function planRequest() {
  return {
    knowledgeBaseId: "kb-1",
    operationPublicId: "maintenance-1",
    expectedPredecessorPublicId: "semantic-active",
    target: target(),
    settingsSnapshot: {
      semanticGenerationRole: "candidate",
      runtimeSettingsRevisionPublicId: "settings-1"
    },
    cursor: null,
    pageSize: 20,
    maximumAttempts: 3,
    reusePredecessorFacts: false,
    enqueuedAt: NOW
  };
}

function target(): SemanticMaintenanceTarget {
  return {
    knowledgeBaseId: "kb-1",
    generationModelConfigurationPublicId: "model-1",
    generationModelConfigurationRevision: 2,
    extractionContractVersion: "extraction-v1",
    graphSchemaVersion: "graph-v1",
    promptContractVersion: "prompt-v1",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    embeddingQueryPolicyRevisionPublicId: "embedding-revision-1",
    minimumVectorRelevance: 0.7,
    resolvedDimension: 3,
    normalization: "l2",
    artifactSchemaVersion: "artifact-v1",
    vectorSchemaVersion: "vector-v1",
    searchProviderKind: "opensearch",
    mappingFingerprintSha256: "a".repeat(64)
  };
}

function currentSource(id: string, status: "ready" | "failed" = "ready") {
  return {
    sourceFile: {
      publicId: `file-${id}`,
      knowledgeBaseId: "kb-1",
      directoryPublicId: null,
      logicalPath: `${id}.md`,
      normalizedPath: `${id}.md`,
      title: id,
      metadata: {},
      currentRevisionPublicId: `revision-${id}`,
      status,
      safeErrorCode: status === "failed" ? "SEMANTIC_STAGE_FAILED" : null,
      safeErrorMessage: status === "failed" ? "Semantic stage failed." : null,
      revision: 1,
      visibility: "current" as const
    },
    sourceRevision: {
      publicId: `revision-${id}`,
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: `file-${id}`,
      objectId: `object-${id}`,
      checksum: "b".repeat(64),
      byteCount: 10,
      contentType: "text/markdown",
      createdAt: NOW
    }
  };
}
