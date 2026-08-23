export type DocumentPublicationOperation = "create" | "replace" | "rename"
  | "move" | "delete" | "repair" | "cutover";

export function createDocumentPublicationActivationCoordinator<
  TActivationResult,
  TRecoveryResult
>(input: {
  activation: {
    activate(request: Readonly<{
      generationPublicId: string;
      expectedHeadVersion: number;
      activatedAt: string;
    }>): Promise<TActivationResult>;
  };
  recovery: {
    recoverStaleBase(request: Readonly<{
      generationPublicId: string;
      recoveredAt: string;
    }>): Promise<TRecoveryResult>;
  };
}) {
  return {
    async activate(request: Readonly<{
      operation: DocumentPublicationOperation;
      generationPublicId: string;
      expectedHeadVersion: number;
      activatedAt: string;
    }>) {
      void request.operation;
      try {
        const result = await input.activation.activate({
          generationPublicId: request.generationPublicId,
          expectedHeadVersion: request.expectedHeadVersion,
          activatedAt: request.activatedAt
        });
        return { state: "active" as const, result };
      } catch (error) {
        const code = errorCode(error);
        if (code === "publication_generation_stale_base") {
          const recovery = await input.recovery.recoverStaleBase({
            generationPublicId: request.generationPublicId,
            recoveredAt: request.activatedAt
          });
          return { state: "superseded" as const, recovery };
        }
        if (code === "publication_activation_contention_deferred") {
          return { state: "deferred" as const };
        }
        if (code === "publication_activation_deadline_deferred") {
          return { state: "deferred" as const, reason: "deadline" as const };
        }
        throw error;
      }
    }
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : "unknown";
}
