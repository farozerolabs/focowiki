import type {
  EmbeddingArtifactRepositoryPort,
  EmbeddingArtifactStorePort
} from "./artifact-ports.js";

export function createEmbeddingArtifactCleanupService(input: {
  repository: Pick<
    EmbeddingArtifactRepositoryPort,
    | "releaseReferences" | "listOrphaned" | "claimOrphaned"
    | "completeOrphanDeletion" | "abandonOrphanDeletion"
  >;
  store: Pick<EmbeddingArtifactStorePort, "deleteIfUnowned">;
  clock?: () => string;
}) {
  const clock = input.clock ?? (() => new Date().toISOString());
  return {
    async release(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      ownerPublicIds: readonly string[] | null;
    }): Promise<number> {
      return input.repository.releaseReferences({
        ...request,
        releasedAt: clock()
      });
    },

    async reconcilePage(request: {
      knowledgeBaseId: string;
      cursor: string | null;
      limit: number;
      signal?: AbortSignal;
    }): Promise<{
      inspected: number;
      deletedArtifacts: number;
      deletedObjects: number;
      nextCursor: string | null;
    }> {
      assertPageLimit(request.limit);
      throwIfAborted(request.signal);
      const page = await input.repository.listOrphaned(request);
      let deletedArtifacts = 0;
      let deletedObjects = 0;
      for (const artifact of page.items) {
        throwIfAborted(request.signal);
        const claim = await input.repository.claimOrphaned({
          knowledgeBaseId: request.knowledgeBaseId,
          artifactPublicId: artifact.publicId,
          claimedAt: clock()
        });
        if (!claim) continue;
        let objectDeleted = false;
        try {
          if (claim.descriptor) {
            await input.store.deleteIfUnowned({
              descriptor: claim.descriptor,
              ...(request.signal ? { signal: request.signal } : {})
            });
            objectDeleted = true;
            deletedObjects += 1;
          }
          if (await input.repository.completeOrphanDeletion({
            knowledgeBaseId: request.knowledgeBaseId,
            artifactPublicId: claim.artifactPublicId,
            descriptor: claim.descriptor,
            completedAt: clock()
          })) deletedArtifacts += 1;
        } catch (error) {
          if (!objectDeleted) {
            await input.repository.abandonOrphanDeletion({
              knowledgeBaseId: request.knowledgeBaseId,
              artifactPublicId: claim.artifactPublicId,
              descriptor: claim.descriptor
            });
          }
          throw error;
        }
      }
      return {
        inspected: page.items.length,
        deletedArtifacts,
        deletedObjects,
        nextCursor: page.nextCursor
      };
    }
  };
}

function assertPageLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Embedding artifact cleanup page limit is invalid");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Embedding artifact cleanup aborted", "AbortError");
  }
}
