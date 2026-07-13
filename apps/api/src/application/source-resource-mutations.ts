import { createHash } from "node:crypto";
import type { SourceResourceRepository } from "./ports/source-resource-repository.js";
import type { ApplicationRuntime } from "./ports/runtime.js";
import { createSourceResourceService } from "./source-resources.js";

export type ResourceMutationWorkerPort = {
  enqueueResourceOperationJob: (input: {
    knowledgeBaseId: string;
    operationId: string;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<unknown>;
  enqueuePublicationJob: (input: {
    knowledgeBaseId: string;
    reason: string;
    runAfter: string;
    maxAttempts: number;
  }) => Promise<unknown>;
};

export type ResourceMutationStoragePort = {
  sourceRevisionKey: (
    knowledgeBaseId: string,
    sourceFileId: string,
    revision: string
  ) => string;
  put: (input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

export function createSourceResourceMutationService(input: {
  repository: SourceResourceRepository;
  worker: ResourceMutationWorkerPort;
  storage: ResourceMutationStoragePort;
  runtime: ApplicationRuntime;
}) {
  const resources = createSourceResourceService(input.repository, input.runtime);

  async function acceptOperation(
    request: Parameters<typeof resources.acceptOperation>[0],
    maxAttempts: number
  ) {
    const result = await resources.acceptOperation(request);
    if (!result.replayed) {
      await input.worker.enqueueResourceOperationJob({
        knowledgeBaseId: request.knowledgeBaseId,
        operationId: result.operation.id,
        runAfter: input.runtime.clock.now().toISOString(),
        maxAttempts
      });
    }
    return result;
  }

  return {
    resources,
    acceptOperation,
    async updateKnowledgeBase(
      request: Parameters<typeof resources.updateKnowledgeBase>[0],
      maxAttempts: number
    ) {
      const updated = await resources.updateKnowledgeBase(request);
      if (updated?.activeReleaseId) {
        await input.worker.enqueuePublicationJob({
          knowledgeBaseId: request.knowledgeBaseId,
          reason: "metadata",
          runAfter: input.runtime.clock.now().toISOString(),
          maxAttempts
        });
      }
      return {
        knowledgeBase: updated,
        publicationQueued: Boolean(updated?.activeReleaseId)
      };
    },
    async replaceSourceContent(request: {
      knowledgeBaseId: string;
      sourceFileId: string;
      expectedResourceRevision: number;
      idempotencyKey: string;
      bytes: Uint8Array;
      relativePath?: string;
      maxAttempts: number;
    }) {
      const checksumSha256 = createHash("sha256").update(request.bytes).digest("hex");
      const objectKey = input.storage.sourceRevisionKey(
        request.knowledgeBaseId,
        request.sourceFileId,
        `sha256-${checksumSha256}`
      );
      await input.storage.put({
        key: objectKey,
        body: request.bytes,
        contentType: "text/markdown; charset=utf-8"
      });
      try {
        return await acceptOperation(
          {
            knowledgeBaseId: request.knowledgeBaseId,
            kind: "source_file_replace",
            idempotencyKey: request.idempotencyKey,
            expectedResourceRevision: request.expectedResourceRevision,
            targetKind: "source_file",
            targetId: request.sourceFileId,
            payload: {
              revisionId: input.runtime.ids.create("source-revision"),
              objectKey,
              sizeBytes: request.bytes.byteLength,
              checksumSha256,
              ...(request.relativePath ? { relativePath: request.relativePath } : {})
            }
          },
          request.maxAttempts
        );
      } catch (error) {
        await input.storage.delete(objectKey).catch(() => undefined);
        throw error;
      }
    }
  };
}
