import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import {
  RoleJobFailure,
  RoleJobReschedule,
  type RoleJobRecord
} from "../domain/role-job.js";

export type GenerationAssemblySettings = {
  batchSize: number;
};

export function createGenerationAssemblyProcessor(input: {
  generations: PublicationGenerationRepository;
  settings: () => Promise<GenerationAssemblySettings>;
  continuationDelayMs?: number;
  now?: () => Date;
}) {
  const continuationDelayMs = input.continuationDelayMs ?? 1;
  const now = input.now ?? (() => new Date());
  assertPositiveInteger(continuationDelayMs, "continuationDelayMs");

  return async (job: RoleJobRecord, signal: AbortSignal): Promise<void> => {
    assertGenerationAssemblyJob(job);
    if (signal.aborted) {
      throw continuation(now(), continuationDelayMs);
    }
    const settings = await input.settings();
    assertPositiveInteger(settings.batchSize, "batchSize");
    const result = await input.generations.assemblePendingChanges({
      knowledgeBaseId: job.knowledgeBaseId,
      assemblerJobId: job.id,
      limit: settings.batchSize,
      assembledAt: now().toISOString()
    });
    if (result.hasMore) {
      throw continuation(now(), continuationDelayMs);
    }
  };
}

function assertGenerationAssemblyJob(job: RoleJobRecord): void {
  if (
    job.role !== "publication" ||
    job.kind !== "generation_assembly" ||
    job.generationId !== null ||
    !job.lockedBy
  ) {
    throw new RoleJobFailure({
      code: "INVALID_GENERATION_ASSEMBLY_JOB",
      message: "Generation assembly job identifiers are invalid",
      retryable: false
    });
  }
}

function continuation(now: Date, delayMs: number): RoleJobReschedule {
  return new RoleJobReschedule(new Date(now.getTime() + delayMs).toISOString());
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
