import type { PublicationActivationStateRepository } from "../application/ports/publication-activation-state-repository.js";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { PublicationSubtask } from "../application/ports/publication-subtask-repository.js";
import type { PublicationValidationRepository } from "../application/ports/publication-validation-repository.js";
import { RoleJobFailure } from "../domain/role-job.js";
import { GENERATED_ROOT_MANIFEST_PATHS } from "../okf/generated-graph-resources.js";
import type { ImmutableObjectWriteResult } from "../publication/immutable-object-writer.js";

type PublicationFinalizer = {
  finalize(input: { knowledgeBaseId: string; generationId: string }): Promise<void>;
};

export type PublicationTerminalPhaseHandlers = {
  object(task: PublicationSubtask): Promise<void>;
  validation(task: PublicationSubtask): Promise<void>;
  activation(task: PublicationSubtask): Promise<void>;
};

export function createPublicationTerminalPhaseHandlers(input: {
  generations: Pick<PublicationGenerationRepository, "markGenerationState" | "activateGeneration">;
  state: PublicationActivationStateRepository;
  validation: PublicationValidationRepository;
  references: Pick<
    GenerationObjectReferenceRepository,
    "findStagedByRef" | "findActiveByRef" | "stageUpsert"
  >;
  immutableObjects: {
    write(object: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }): Promise<ImmutableObjectWriteResult>;
  };
  finalizers: PublicationFinalizer[];
  validationIssueLimit: number;
  now?: () => Date;
}): PublicationTerminalPhaseHandlers {
  const now = input.now ?? (() => new Date());
  return {
    async object(task) {
      for (const finalizer of input.finalizers) {
        await finalizer.finalize(task);
      }
    },

    async validation(task) {
      const context = await requireContext(input.state, task);
      if (context.state === "active") return;
      if (context.state === "building") {
        const transitioned = await input.generations.markGenerationState({
          knowledgeBaseId: task.knowledgeBaseId,
          generationId: task.generationId,
          expectedState: "building",
          state: "validating",
          updatedAt: now().toISOString()
        });
        if (!transitioned) throw retryablePhaseError("Generation validation transition is busy");
      } else if (context.state !== "validating") {
        throw terminalPhaseError(`Generation cannot be validated from state: ${context.state}`);
      }
      const issues = await input.validation.validateChangedClosure({
        knowledgeBaseId: task.knowledgeBaseId,
        generationId: task.generationId,
        issueLimit: input.validationIssueLimit
      });
      if (issues.length > 0) {
        throw terminalPhaseError(issues
          .map((issue) => `${issue.code}:${issue.reference ?? "-"}`)
          .join(", "), "GENERATION_VALIDATION_FAILED");
      }
    },

    async activation(task) {
      const context = await requireContext(input.state, task);
      if (context.state === "active") return;
      if (context.state !== "validating") {
        throw retryablePhaseError(`Generation cannot be activated from state: ${context.state}`);
      }
      const roots = [];
      for (const path of GENERATED_ROOT_MANIFEST_PATHS) {
        const reference = await input.references.findStagedByRef({
          knowledgeBaseId: task.knowledgeBaseId,
          generationId: task.generationId,
          refKind: "root",
          refKey: path
        }) ?? await input.references.findActiveByRef({
          knowledgeBaseId: task.knowledgeBaseId,
          refKind: "root",
          refKey: path
        });
        if (!reference) {
          throw terminalPhaseError(`Required root reference is unavailable: ${path}`, "ROOT_REFERENCE_MISSING");
        }
        roots.push({
          path,
          checksumSha256: reference.checksumSha256,
          objectKey: reference.objectKey,
          contentType: reference.contentType,
          sizeBytes: reference.sizeBytes
        });
      }
      const manifest = await input.immutableObjects.write({
        body: `${JSON.stringify({
          formatVersion: 1,
          knowledgeBaseId: task.knowledgeBaseId,
          generationId: task.generationId,
          predecessorGenerationId: context.predecessorGenerationId,
          roots
        })}\n`,
        contentType: "application/json; charset=utf-8"
      });
      await input.references.stageUpsert({
        knowledgeBaseId: task.knowledgeBaseId,
        generationId: task.generationId,
        refKind: "generation_manifest",
        refKey: "root",
        fileId: `generation-manifest-${task.generationId}`,
        checksumSha256: manifest.checksumSha256,
        formatVersion: manifest.formatVersion,
        logicalPath: null,
        sourceFileId: null,
        projectionShardId: null
      });
      const activated = await input.generations.activateGeneration({
        knowledgeBaseId: task.knowledgeBaseId,
        generationId: task.generationId,
        expectedPredecessorGenerationId: context.predecessorGenerationId,
        rootManifestChecksumSha256: manifest.checksumSha256,
        rootManifestObjectKey: manifest.objectKey,
        activatedAt: now().toISOString()
      });
      if (!activated) throw retryablePhaseError("Generation activation is busy");
    }
  };
}

async function requireContext(
  state: PublicationActivationStateRepository,
  task: PublicationSubtask
) {
  const context = await state.getActivationContext({
    knowledgeBaseId: task.knowledgeBaseId,
    generationId: task.generationId
  });
  if (!context) throw terminalPhaseError("Publication generation is unavailable");
  return context;
}

function terminalPhaseError(message: string, code = "PUBLICATION_PHASE_FAILED"): RoleJobFailure {
  return new RoleJobFailure({ code, message, retryable: false });
}

function retryablePhaseError(message: string): RoleJobFailure {
  return new RoleJobFailure({ code: "PUBLICATION_PHASE_BUSY", message, retryable: true });
}
