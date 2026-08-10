import { createHash } from "node:crypto";
import type { StorageVnextMaintenanceRequest } from "./ports.js";

export function createStorageVnextMaintenanceRequestHash(
  request: StorageVnextMaintenanceRequest
): string {
  const identity = [
    "storage-vnext-maintenance-v3",
    request.knowledgeBaseId,
    request.searchProviderKind,
    request.trigger,
    request.idempotencyKey,
    request.semanticAdoption
      ? JSON.stringify(request.semanticAdoption)
      : ""
  ].join("\0");
  return createHash("sha256").update(identity).digest("hex");
}

export function createStorageVnextMaintenanceCandidatePublicId(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
}): string {
  const identity = [
    "storage-vnext-maintenance-candidate-v1",
    input.knowledgeBaseId,
    input.operationPublicId
  ].join("\0");
  return `maintenance-candidate-${createHash("sha256").update(identity).digest("hex")}`;
}

export function createStorageVnextMaintenanceRootPublicId(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
}): string {
  const identity = [
    "storage-vnext-maintenance-root-v1",
    input.knowledgeBaseId,
    input.operationPublicId
  ].join("\0");
  return `maintenance-root-${createHash("sha256").update(identity).digest("hex")}`;
}
