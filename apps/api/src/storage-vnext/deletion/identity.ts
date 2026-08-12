import { createHash } from "node:crypto";
import type { StorageVnextDeletionRequest } from "./ports.js";

export function createStorageVnextDeletionRequestHash(
  request: StorageVnextDeletionRequest
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    kind: request.kind,
    knowledgeBaseId: request.knowledgeBaseId,
    targetPublicId: request.targetPublicId,
    expectedResourceRevision: request.expectedResourceRevision
  })).digest("hex");
}
