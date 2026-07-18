import { describe, expect, it, vi } from "vitest";
import type { AdminRepositories, SourceFileRecord } from "../src/db/admin-repositories.js";
import type {
  SourceFileRetryAcceptance
} from "../src/application/ports/source-file-retry-repository.js";
import {
  retrySourceFile
} from "../src/application/source-file-retry.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("source-file retry service", () => {
  it("accepts retry through one repository command and returns the refreshed lifecycle", async () => {
    const acceptSourceFileRetry = vi.fn(async (): Promise<SourceFileRetryAcceptance> => ({
      outcome: "accepted",
      kind: "source_processing",
      coalesced: false,
      roleJobId: "role-job-retry-1"
    }));
    const repositories = createRepositories();

    const result = await retrySourceFile({
      repositories,
      retries: { accept: acceptSourceFileRetry },
      knowledgeBaseId: "kb-retry",
      sourceFileId: "source-retry",
      config: {}
    });

    expect(acceptSourceFileRetry).toHaveBeenCalledOnce();
    expect(acceptSourceFileRetry).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-retry",
      sourceFileId: "source-retry",
      maxAttempts: expect.any(Number)
    }));
    expect(result).toMatchObject({
      kind: "source_processing",
      scope: "source_file",
      coalesced: false,
      file: { id: "source-retry", processingStatus: "queued", terminalFailure: null }
    });
  });

  it("returns the accepted coalesced publication retry without creating competing work", async () => {
    const acceptSourceFileRetry = vi.fn(async (): Promise<SourceFileRetryAcceptance> => ({
      outcome: "accepted",
      kind: "publication",
      coalesced: true,
      roleJobId: "role-job-publication-1"
    }));
    const repositories = createRepositories();

    const result = await retrySourceFile({
      repositories,
      retries: { accept: acceptSourceFileRetry },
      knowledgeBaseId: "kb-retry",
      sourceFileId: "source-retry",
      config: {}
    });

    expect(result).toMatchObject({
      kind: "publication",
      scope: "knowledge_base_publication",
      coalesced: true
    });
    expect(acceptSourceFileRetry).toHaveBeenCalledOnce();
  });

  it("maps transactional resource conflicts without issuing a second write", async () => {
    const acceptSourceFileRetry = vi.fn(async (): Promise<SourceFileRetryAcceptance> => ({
      outcome: "resource_conflict"
    }));
    const repositories = createRepositories();

    await expect(retrySourceFile({
      repositories,
      retries: { accept: acceptSourceFileRetry },
      knowledgeBaseId: "kb-retry",
      sourceFileId: "source-retry",
      config: {}
    })).rejects.toMatchObject({
      code: "SOURCE_FILE_RETRY_RESOURCE_CONFLICT"
    });
    expect(acceptSourceFileRetry).toHaveBeenCalledOnce();
  });

});

function createRepositories(): AdminRepositories {
  const sourceFile = createSourceFile();
  return {
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [], nextCursor: null };
      },
      async createKnowledgeBase() {
        throw new Error("Not implemented");
      },
      async getKnowledgeBase(id) {
        return id === "kb-retry"
          ? {
              id,
              name: "Retry",
              description: null,
              activeGenerationId: null,
              resourceRevision: 1,
              catalogGeneration: 1,
              createdAt: NOW,
              updatedAt: NOW
            }
          : null;
      }
    },
    files: {
      async listSourceFiles() {
        return { items: [], nextCursor: null };
      },
      async updateSourceFileProcessingState() {
        return undefined;
      },
      async updateSourceFileMetadata() {
        return undefined;
      },
      async updateSourceFileModelSuggestions() {
        return undefined;
      },
      async createSourceFileEvent(input) {
        return { id: "event-retry", ...input, createdAt: NOW };
      },
      async listSourceFileEvents() {
        return { items: [], nextCursor: null };
      },
      async getSourceFile({ sourceFileId }) {
        return sourceFileId === sourceFile.id ? sourceFile : null;
      },
      async getSourceFileForProcessing({ sourceFileId }) {
        return sourceFileId === sourceFile.id ? sourceFile : null;
      }
    }
  };
}

function createSourceFile(): SourceFileRecord {
  return {
    id: "source-retry",
    knowledgeBaseId: "kb-retry",
    name: "retry.md",
    relativePath: "retry.md",
    resourceRevision: 1,
    objectKey: "source/retry.md",
    contentType: "text/markdown",
    sizeBytes: 20,
    checksumSha256: "checksum",
    metadata: {},
    processingStatus: "queued",
    processingStage: "graph_generation",
    processingStartedAt: NOW,
    processingEndedAt: null,
    generatedOutputStatus: "pending",
    terminalFailure: null,
    retryCount: 1,
    createdAt: NOW,
    deletedAt: null
  };
}
