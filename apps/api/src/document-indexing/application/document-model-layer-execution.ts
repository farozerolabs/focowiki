import { createHash } from "node:crypto";
import type { ModelProviderObservation } from "@focowiki/okf";

export const DOCUMENT_MODEL_LAYERS = [
  "first_layer",
  "candidate_delta",
  "graphrag"
] as const;

export type DocumentModelLayer = (typeof DOCUMENT_MODEL_LAYERS)[number];

export type DocumentModelLayerExecution = {
  publicId: string;
  knowledgeBaseId: string;
  documentJobPublicId: string;
  sourceRevisionPublicId: string;
  layer: DocumentModelLayer;
  executionIdentitySha256: string;
  status: "running" | "completed" | "failed";
  modelName: string;
  selected: boolean | null;
  reused: boolean;
  providerRequestCount: number;
  waitTimeMs: number;
  serviceTimeMs: number;
  providerObservations: readonly ModelProviderObservation[];
  warningCount: number;
  errorCode: string | null;
  startedAt: string;
  endedAt: string | null;
};

export function createDocumentModelLayerExecutionIdentity(input: {
  documentJobPublicId: string;
  layer: DocumentModelLayer;
  ownerIdentity: string;
}): { publicId: string; executionIdentitySha256: string } {
  const executionIdentitySha256 = createHash("sha256")
    .update(input.ownerIdentity)
    .digest("hex");
  const identity = createHash("sha256")
    .update([
      input.documentJobPublicId,
      input.layer,
      executionIdentitySha256
    ].join("\u001f"))
    .digest("hex");
  return {
    publicId: `document-model-layer-${identity}`,
    executionIdentitySha256
  };
}

export type DocumentModelLayerExecutionRepository = {
  record(input: DocumentModelLayerExecution): Promise<void>;
};
