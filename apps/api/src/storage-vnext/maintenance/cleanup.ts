import type { StorageVnextProcessResourceScope } from
  "../cleanup/process-resource-scope.js";
import { createStorageVnextMaintenanceCandidatePublicId } from "./identity.js";
import type { StorageVnextMaintenanceCleanup } from "./ports.js";

type MaintenanceOutcome = "completed" | "failed" | "superseded";

export type StorageVnextMaintenanceResidue = {
  activeUnifiedIndexCount: number;
  candidateIndexCount: number;
  splitIndexCount: number;
  candidateRootCount: number;
  candidateShardCount: number;
  subtaskCount: number;
  providerTaskCount: number;
  temporaryOwnerCount: number;
  temporaryFileCount: number;
  excessPhysicalBytes: number;
};

type CleanupIdentity = {
  knowledgeBaseId: string;
  operationPublicId: string;
  candidatePublicId: string;
  outcome: MaintenanceOutcome;
};

export function createStorageVnextMaintenanceCleanup(input: {
  processResources: Pick<StorageVnextProcessResourceScope, "closeAll" | "assertIdle">;
  search: {
    cleanupMaintenance(input: CleanupIdentity & {
      promotedCandidatePublicId: string | null;
      failedCandidatePublicId: string | null;
    }): Promise<void>;
  };
  release: {
    terminateMaintenanceCandidate(input: CleanupIdentity): Promise<void>;
  };
  objects: {
    releaseMaintenanceTemporaryOwners(input: CleanupIdentity): Promise<void>;
  };
  temporaryFiles: {
    removeMaintenanceFiles(input: CleanupIdentity): Promise<void>;
  };
  residue: {
    inspect(input: CleanupIdentity): Promise<StorageVnextMaintenanceResidue>;
  };
}): StorageVnextMaintenanceCleanup {
  return {
    async terminate(request) {
      validateRequest(request);
      const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId
      });
      const identity = { ...request, candidatePublicId };
      await input.processResources.closeAll();
      input.processResources.assertIdle(0);
      if (request.outcome !== "completed") {
        await input.release.terminateMaintenanceCandidate(identity);
      }
      await input.search.cleanupMaintenance({
        ...identity,
        promotedCandidatePublicId: request.outcome === "completed"
          ? candidatePublicId : null,
        failedCandidatePublicId: request.outcome === "completed"
          ? null : candidatePublicId
      });
      await input.objects.releaseMaintenanceTemporaryOwners(identity);
      await input.temporaryFiles.removeMaintenanceFiles(identity);
      const observed = await input.residue.inspect(identity);
      assertNoResidue(request.outcome, observed);
      return {
        outcome: request.outcome,
        candidatePublicId,
        residue: observed
      };
    }
  };
}

function assertNoResidue(
  outcome: MaintenanceOutcome,
  residue: StorageVnextMaintenanceResidue
): void {
  for (const value of Object.values(residue)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw cleanupError("invalid_residue");
    }
  }
  const invalidActiveCount = outcome === "completed"
    ? residue.activeUnifiedIndexCount !== 1
    : residue.activeUnifiedIndexCount > 1;
  if (
    invalidActiveCount
    || residue.candidateIndexCount !== 0
    || residue.splitIndexCount !== 0
    || residue.candidateRootCount !== 0
    || residue.candidateShardCount !== 0
    || residue.subtaskCount !== 0
    || residue.providerTaskCount !== 0
    || residue.temporaryOwnerCount !== 0
    || residue.temporaryFileCount !== 0
    || residue.excessPhysicalBytes !== 0
  ) throw cleanupError("maintenance_residue");
}

function validateRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  outcome: MaintenanceOutcome;
}): void {
  if (
    !input.knowledgeBaseId
    || Buffer.byteLength(input.knowledgeBaseId) > 255
    || !input.operationPublicId
    || Buffer.byteLength(input.operationPublicId) > 255
    || !["completed", "failed", "superseded"].includes(input.outcome)
  ) throw cleanupError("invalid_input");
}

function cleanupError(code: string): Error {
  return Object.assign(new Error(`Storage vNext maintenance cleanup error: ${code}`), {
    code
  });
}
