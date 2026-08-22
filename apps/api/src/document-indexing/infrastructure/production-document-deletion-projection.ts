import type { S3Client } from "@aws-sdk/client-s3";
import type { RuntimeConfig, WorkerRuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import { isPostgresDocumentDeletionPublicationActive } from
  "./postgres-document-deletion-publication-facts.js";

export function createProductionDocumentDeletionProjection(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  workerConfig: Required<WorkerRuntimeConfig>;
  resourceCapacity: DocumentResourceCapacityInput;
  s3: S3Client;
  ownership: ReturnType<typeof createPostgresStorageVnextOwnershipRepository>;
}) {
  const publicationGenerationCoordinator = {
    isDeletionActive(action: DocumentResourceDeletionAction) {
      return isPostgresDocumentDeletionPublicationActive({
        transaction: input.sql as never,
        knowledgeBaseId: action.knowledgeBaseId,
        operationPublicId: action.operationPublicId
      });
    }
  };
  return {
    async reconcile(request: {
      action: DocumentResourceDeletionAction;
      pageSize: number;
      now: string;
      signal: AbortSignal;
    }) {
      request.signal.throwIfAborted();
      const active = await publicationGenerationCoordinator
        .isDeletionActive(request.action);
      return {
        done: false,
        processedSourceCount: 0,
        checkpoint: {
          phase: active
            ? "deactivate" as const : "reconcile_projection" as const,
          cursor: null,
          affectedSourceCount: request.action.checkpoint.affectedSourceCount
        }
      };
    }
  };
}
