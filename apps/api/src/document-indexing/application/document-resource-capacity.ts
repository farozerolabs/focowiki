import type {
  DocumentResourceKind
} from "./document-resource-permits.js";

export type DocumentResourceCapacityInput = {
  documentConcurrency: number;
  sourceObjectReadConcurrency: number;
  generationModelConcurrency: number;
  graphRagConcurrency: number;
  embeddingConcurrency: number;
  databaseConnectionLimit: number;
  searchConcurrency: number;
};

export function resolveDocumentFinalizationCapacity(input: {
  documentConcurrency: number;
  databaseConnectionLimit: number;
}): number {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new Error(`Document finalization capacity input is invalid: ${name}`);
    }
  }
  return Math.min(
    input.documentConcurrency,
    Math.max(1, input.databaseConnectionLimit - 1)
  );
}

export function resolveDocumentProjectionCapacities(input: {
  documentConcurrency: number;
}): { documentPreparation: number; scopeProjection: number } {
  if (!Number.isSafeInteger(input.documentConcurrency)
    || input.documentConcurrency < 1 || input.documentConcurrency > 1_000) {
    throw new Error("Document projection capacity input is invalid");
  }
  const scopeProjection = Math.max(1, Math.floor(input.documentConcurrency / 4));
  return {
    documentPreparation: input.documentConcurrency,
    scopeProjection
  };
}

export function deriveDocumentResourceCapacities(
  input: DocumentResourceCapacityInput
): {
  capacities: Record<DocumentResourceKind, number>;
  maximumWaitersPerResource: number;
} {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new Error(`Document resource capacity input is invalid: ${name}`);
    }
  }
  const foregroundDatabaseConnections = Math.max(
    1,
    input.databaseConnectionLimit - 1
  );
  return {
    capacities: {
      s3_read: input.sourceObjectReadConcurrency,
      generation_model: input.generationModelConcurrency,
      embedding: input.embeddingConcurrency,
      database_mutation: foregroundDatabaseConnections,
      generated_object_write: input.sourceObjectReadConcurrency,
      search_provider: input.searchConcurrency
    },
    maximumWaitersPerResource: input.documentConcurrency * 4
  };
}
