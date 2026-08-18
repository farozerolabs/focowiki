export function createStorageVnextMaintenanceCancellationCleanup(input: {
  documents: {
    terminate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      outcome: "superseded";
    }): Promise<void>;
  };
}) {
  return {
    async terminate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      cancelledAt: string;
    }): Promise<void> {
      assertRequest(request);
      await input.documents.terminate({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        outcome: "superseded"
      });
    }
  };
}

function assertRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  cancelledAt: string;
}): void {
  if (!input.knowledgeBaseId || !input.operationPublicId
    || !Number.isFinite(Date.parse(input.cancelledAt))) {
    throw Object.assign(new Error("Maintenance cancellation input is invalid"), {
      code: "invalid_input"
    });
  }
}
