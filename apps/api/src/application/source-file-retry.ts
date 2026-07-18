import {
  resolveWorkerConfig,
  type RuntimeConfig,
  type WorkerRuntimeConfig
} from "../config.js";
import type { SourceFileRetryRepository } from "./ports/source-file-retry-repository.js";

export type SourceFileRetryPorts<TFile> = {
  files?: {
    getSourceFile?: (request: {
      knowledgeBaseId: string;
      sourceFileId: string;
    }) => Promise<TFile | null>;
  };
};

export type SourceFileRetryResult<TFile> = {
  file: TFile;
  kind: "source_processing" | "publication";
  scope: "source_file" | "knowledge_base_publication";
  coalesced: boolean;
};

export class SourceFileRetryServiceError extends Error {
  public constructor(
    public readonly code:
      | "SOURCE_FILE_NOT_FOUND"
      | "SOURCE_FILE_RETRY_BACKEND_UNAVAILABLE"
      | "SOURCE_FILE_RETRY_RESOURCE_CONFLICT"
      | "SOURCE_FILE_RETRY_NOT_ALLOWED"
  ) {
    super(code);
    this.name = "SourceFileRetryServiceError";
  }
}

export async function retrySourceFile<TFile>(input: {
  repositories: SourceFileRetryPorts<TFile>;
  retries: SourceFileRetryRepository | null;
  knowledgeBaseId: string;
  sourceFileId: string;
  config: Pick<RuntimeConfig, "worker">;
  worker?: WorkerRuntimeConfig | undefined;
}): Promise<SourceFileRetryResult<TFile>> {
  const files = input.repositories.files;
  if (!files?.getSourceFile || !input.retries) {
    throw new SourceFileRetryServiceError("SOURCE_FILE_RETRY_BACKEND_UNAVAILABLE");
  }

  const worker = input.worker ?? resolveWorkerConfig(input.config);
  const acceptance = await input.retries.accept({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    runAfter: new Date().toISOString(),
    maxAttempts: worker.jobMaxAttempts
  });
  if (acceptance.outcome === "not_found") {
    throw new SourceFileRetryServiceError("SOURCE_FILE_NOT_FOUND");
  }
  if (acceptance.outcome === "not_allowed") {
    throw new SourceFileRetryServiceError("SOURCE_FILE_RETRY_NOT_ALLOWED");
  }
  if (acceptance.outcome === "resource_conflict") {
    throw new SourceFileRetryServiceError("SOURCE_FILE_RETRY_RESOURCE_CONFLICT");
  }
  const updated = await files.getSourceFile({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId
  });
  if (!updated) {
    throw new SourceFileRetryServiceError("SOURCE_FILE_RETRY_RESOURCE_CONFLICT");
  }
  return {
    file: updated,
    kind: acceptance.kind,
    scope: acceptance.kind === "publication" ? "knowledge_base_publication" : "source_file",
    coalesced: acceptance.coalesced
  };
}
