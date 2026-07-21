import { describe, expect, it, vi } from "vitest";
import type { PublicationGenerationRepository } from "../src/application/ports/publication-generation-repository.js";
import { RoleJobReschedule, type RoleJobRecord } from "../src/domain/role-job.js";
import { createGenerationAssemblyProcessor } from "../src/worker/generation-assembly-processor.js";

describe("generation assembly processor", () => {
  it("assembles one bounded page using live runtime settings", async () => {
    const assemblePendingChanges = vi.fn().mockResolvedValue({
      generationId: "generation-1",
      assembledChangeCount: 25,
      impactCount: 80,
      hasMore: false
    });
    const processor = createGenerationAssemblyProcessor({
      generations: generationRepository(assemblePendingChanges),
      settings: vi.fn().mockResolvedValue({ batchSize: 25 }),
      now: () => new Date("2026-07-20T01:00:00.000Z")
    });

    await processor(createJob(), new AbortController().signal);

    expect(assemblePendingChanges).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      assemblerJobId: "role-job-generation-assembly-kb-1",
      limit: 25,
      assembledAt: "2026-07-20T01:00:00.000Z"
    });
  });

  it("reschedules without consuming retry budget while pending facts remain", async () => {
    const assemblePendingChanges = vi.fn().mockResolvedValue({
      generationId: "generation-1",
      assembledChangeCount: 100,
      impactCount: 240,
      hasMore: true
    });
    const processor = createGenerationAssemblyProcessor({
      generations: generationRepository(assemblePendingChanges),
      settings: vi.fn().mockResolvedValue({ batchSize: 100 }),
      now: () => new Date("2026-07-20T01:00:00.000Z")
    });

    await expect(processor(createJob(), new AbortController().signal))
      .rejects.toBeInstanceOf(RoleJobReschedule);
  });

  it("rejects unrelated publication jobs", async () => {
    const processor = createGenerationAssemblyProcessor({
      generations: generationRepository(vi.fn()),
      settings: vi.fn().mockResolvedValue({ batchSize: 100 })
    });

    await expect(processor(
      createJob({ kind: "generation_publication", generationId: "generation-1" }),
      new AbortController().signal
    )).rejects.toMatchObject({
      code: "INVALID_GENERATION_ASSEMBLY_JOB",
      retryable: false
    });
  });
});

function generationRepository(
  assemblePendingChanges: PublicationGenerationRepository["assemblePendingChanges"]
): PublicationGenerationRepository {
  return {
    getProgressSummary: vi.fn(),
    commitSourceCompletion: vi.fn(),
    commitMutation: vi.fn(),
    assemblePendingChanges,
    freezeGeneration: vi.fn(),
    markGenerationState: vi.fn(),
    activateGeneration: vi.fn(),
    failGeneration: vi.fn()
  };
}

function createJob(overrides: Partial<RoleJobRecord> = {}): RoleJobRecord {
  return {
    id: "role-job-generation-assembly-kb-1",
    role: "publication",
    kind: "generation_assembly",
    knowledgeBaseId: "kb-1",
    sourceFileId: null,
    sourceRevisionId: null,
    generationId: null,
    payload: { knowledgeBaseId: "kb-1" },
    settingsSnapshot: {},
    status: "running",
    runAfter: "2026-07-20T00:59:00.000Z",
    attemptCount: 1,
    maxAttempts: 5,
    lockedBy: "publication-worker-1",
    lockedAt: "2026-07-20T01:00:00.000Z",
    heartbeatAt: "2026-07-20T01:00:00.000Z",
    createdAt: "2026-07-20T00:59:00.000Z",
    updatedAt: "2026-07-20T01:00:00.000Z",
    ...overrides
  };
}
