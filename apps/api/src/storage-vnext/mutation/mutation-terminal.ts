import { createHash } from "node:crypto";
import type {
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import type { StorageVnextWorkflowWritePort } from "../workflow/ports.js";
import type {
  StorageVnextMutationTerminalOutcome,
  StorageVnextMutationTerminalRepository
} from "./ports.js";

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getLiveCandidate" | "terminateCandidate"
>;

export function createStorageVnextMutationTerminalCoordinator(input: {
  repository: StorageVnextMutationTerminalRepository;
  releases: ReleasePort;
  workflow: Pick<StorageVnextWorkflowWritePort, "releaseForRetry">;
}) {
  const terminate = async (request: {
    knowledgeBaseId: string;
    operationPublicId: string;
    outcome: StorageVnextMutationTerminalOutcome;
    resultCode: string;
    successorOperationPublicId: string | null;
    completedAt: string;
    resultExpiresAt: string;
  }) => {
    const candidate = await input.releases.getLiveCandidate(request.knowledgeBaseId);
    if (candidate?.operationPublicId === request.operationPublicId) {
      const converged = await input.releases.terminateCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: candidate.publicId,
        outcome: request.outcome,
        reasonCode: request.resultCode,
        safeMessage: null,
        eventPublicId: mutationEventPublicId(request),
        eventExpiresAt: request.resultExpiresAt,
        terminatedAt: request.completedAt
      });
      if (!converged) throw terminalError("terminal_convergence_failed");
      return;
    }
    const converged = await input.repository.terminateMutation(request);
    if (!converged) throw terminalError("mutation_missing");
  };
  return {
    cancelMutation(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      completedAt: string;
      resultExpiresAt: string;
    }) {
      return terminate({
        ...request,
        outcome: "cancelled",
        resultCode: "MUTATION_CANCELLED",
        successorOperationPublicId: null
      });
    },

    supersedeMutation(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      successorOperationPublicId: string;
      completedAt: string;
      resultExpiresAt: string;
    }) {
      return terminate({
        ...request,
        outcome: "superseded",
        resultCode: "MUTATION_SUPERSEDED"
      });
    },

    failMutation(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      resultCode: string;
      completedAt: string;
      resultExpiresAt: string;
    }) {
      return terminate({
        ...request,
        outcome: "failed",
        successorOperationPublicId: null
      });
    },

    timeoutMutation(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      completedAt: string;
      resultExpiresAt: string;
    }) {
      return terminate({
        ...request,
        outcome: "timed_out",
        resultCode: "MUTATION_TIMED_OUT",
        successorOperationPublicId: null
      });
    },

    retryMutation(request: {
      operationPublicId: string;
      owner: string;
      nextAttemptAt: string;
      reasonCode: string;
    }) {
      return input.workflow.releaseForRetry({
        publicId: request.operationPublicId,
        owner: request.owner,
        nextAttemptAt: request.nextAttemptAt,
        reasonCode: request.reasonCode
      });
    }
  };
}

function mutationEventPublicId(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  outcome: string;
  resultCode: string;
}): string {
  return `mutation-event-${createHash("sha256").update([
    input.knowledgeBaseId,
    input.operationPublicId,
    input.outcome,
    input.resultCode
  ].join("\0")).digest("hex")}`;
}

function terminalError(code: string): Error {
  return Object.assign(new Error(`Storage vNext mutation terminal error: ${code}`), {
    code
  });
}
