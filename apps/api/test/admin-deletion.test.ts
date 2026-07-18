import { describe, expect, it, vi } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";
import type {
  ActiveGenerationFile,
  ActiveGenerationReadRepository
} from "../src/application/ports/active-generation-read-repository.js";
import type { PublicationGenerationRepository } from "../src/application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../src/application/ports/role-job-repository.js";
import type { SourceResourceRepository } from "../src/application/ports/source-resource-repository.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import { createApiApp } from "../src/server.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

describe("admin source deletion", () => {
  it("hides a source page and schedules bounded inverse work", async () => {
    const fixture = createFixture();
    const cookie = await loginAndReadSessionCookie(fixture.app);
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages%2Fintro.md",
      {
        method: "DELETE",
        headers: withTrustedAdminOrigin({ cookie })
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      publicationQueued: true
    });
    expect(fixture.acceptSourceFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-001",
        sourceFileId: "source-001",
        expectedResourceRevision: 7
      })
    );
    expect(fixture.commitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-001",
        sourceFileId: "source-001",
        kind: "source_deleted",
        previousPath: "intro.md",
        path: null,
        deletionIntentId: "deletion-intent-001"
      })
    );
    expect(fixture.cancelSourceJobsForDeletionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ deletionIntentId: "deletion-intent-001" })
    );
    expect(fixture.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "maintenance",
        kind: "hard_delete",
        knowledgeBaseId: "kb-001",
        payload: expect.objectContaining({
          targetKind: "source_file",
          sourceFileId: "source-001",
          deletionIntentId: "deletion-intent-001"
        })
      })
    );
  });

  it("rejects generated roots because they have no source identity", async () => {
    const fixture = createFixture({ file: activeFile({
      fileId: "generated-index",
      refKind: "root",
      refKey: "index.md",
      path: "index.md",
      sourceFileId: null
    }) });
    const cookie = await loginAndReadSessionCookie(fixture.app);
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=index.md",
      { method: "DELETE", headers: withTrustedAdminOrigin({ cookie }) }
    );

    expect(response.status).toBe(400);
    expect(fixture.acceptSourceFileDeletion).not.toHaveBeenCalled();
  });

  it("returns not found when the active generation has no matching path", async () => {
    const fixture = createFixture({ file: null });
    const cookie = await loginAndReadSessionCookie(fixture.app);
    const response = await fixture.app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages%2Fmissing.md",
      { method: "DELETE", headers: withTrustedAdminOrigin({ cookie }) }
    );

    expect(response.status).toBe(404);
    expect(fixture.acceptSourceFileDeletion).not.toHaveBeenCalled();
  });
});

function createFixture(options: { file?: ActiveGenerationFile | null } = {}) {
  const file = options.file === undefined ? activeFile({
    fileId: "generated-source-001",
    refKind: "page",
    refKey: "source-001",
    path: "pages/intro.md",
    sourceFileId: "source-001"
  }) : options.file;
  const acceptSourceFileDeletion = vi.fn(async () => ({
    operation: {
      id: "resource-operation-001",
      knowledgeBaseId: "kb-001",
      kind: "source_file_delete" as const,
      state: "processing" as const,
      expectedResourceRevision: 7,
      candidateCatalogGeneration: 2,
      result: null,
      errorCode: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      completedAt: null
    },
    replayed: false,
    deletionIntentId: "deletion-intent-001",
    sourceFileId: "source-001",
    sourceMutation: {
      sourceFileId: "source-001",
      sourceRevisionId: "source-revision-001",
      kind: "source_deleted" as const,
      previousPath: "intro.md",
      path: null,
      resourceRevision: 8
    }
  }));
  const sourceResources = {
    getSourceFile: vi.fn(async () => ({
      id: "source-001",
      knowledgeBaseId: "kb-001",
      directoryId: null,
      name: "intro.md",
      relativePath: "intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 8,
      checksumSha256: "a".repeat(64),
      resourceRevision: 7,
      contentRevision: 1,
      activeRevisionId: "source-revision-001",
      processingStatus: "completed" as const,
      currentStage: "projection_generation" as const,
      terminalFailure: null,
      generatedOutputStatus: "visible" as const,
      generatedPath: "pages/intro.md",
      deleting: false,
      createdAt: "2026-07-17T00:00:00.000Z"
    })),
    acceptSourceFileDeletion
  } as unknown as SourceResourceRepository;
  const repositories = {
    knowledgeBases: {
      async getKnowledgeBase() {
        return {
          id: "kb-001",
          name: "Docs",
          description: null,
          activeGenerationId: "generation-active",
          resourceRevision: 1,
          catalogGeneration: 1,
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z"
        };
      }
    },
    sourceResources
  } as unknown as AdminRepositories;
  const activeGenerationReads: ActiveGenerationReadRepository = {
    async withActiveGeneration(_knowledgeBaseId, reader) {
      return reader({
        knowledgeBaseId: "kb-001",
        generationId: "generation-active",
        async findFileById() { return file; },
        async findFileByPath(path) { return file?.path === path ? file : null; },
        async findFilesBySourceIds() { return file ? [file] : []; },
        async findProjection() { return null; },
        async getGraphSummary() {
          return { nodeCount: 0, edgeCount: 0, graphIndexAvailable: false, persisted: true };
        },
        async listTree() { return { items: [], nextCursor: null }; },
        async listTreeAncestors() { return new Map(); },
        async search() { return { items: [], nextCursor: null }; },
        async listRelated() { return { items: [], nextCursor: null }; },
        async listRelatedForSources(input) {
          return new Map(input.sourceFileIds.map((sourceFileId) => [sourceFileId, []]));
        }
      });
    }
  };
  const enqueue = vi.fn(async () => null);
  const cancelSourceJobsForDeletionIntent = vi.fn(async () => 1);
  const roleJobs = {
    enqueue,
    cancelSourceJobsForDeletionIntent
  } as unknown as RoleJobRepository;
  const commitMutation = vi.fn(async () => ({
    generationId: "generation-next",
    changeFactCreated: true,
    scheduledPublication: true
  }));
  const publicationGenerations = {
    commitMutation
  } as unknown as PublicationGenerationRepository;
  const storage: StorageAdapter = {
    keyspace: createStorageKeyspace("test"),
    async putObject() {},
    async headObjectMetadata() { return null; },
    async getObjectText() { return null; }
  };
  const app = createApiApp({
    config: testConfig(),
    repositories,
    redis: createTestRedisCoordinator(),
    storage,
    activeGenerationReads,
    roleJobs,
    publicationGenerations
  });
  return {
    app,
    acceptSourceFileDeletion,
    commitMutation,
    enqueue,
    cancelSourceJobsForDeletionIntent
  };
}

function activeFile(input: {
  fileId: string;
  refKind: string;
  refKey: string;
  path: string;
  sourceFileId: string | null;
}): ActiveGenerationFile {
  return {
    generationId: "generation-active",
    fileId: input.fileId,
    refKind: input.refKind,
    refKey: input.refKey,
    lastChangedGenerationId: "generation-active",
    path: input.path,
    sourceFileId: input.sourceFileId,
    objectKey: `generated/${input.fileId}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 8,
    checksumSha256: "b".repeat(64),
    title: "Intro",
    summary: null,
    payload: {}
  };
}

function testConfig() {
  return parseRuntimeConfig({
    APP_ENV: "development",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin-secret",
    DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:55432/focowiki",
    REDIS_URL: "redis://127.0.0.1:56379/0",
    PUBLIC_BASE_URL: "https://openapi.example.com",
    S3_ENDPOINT: "https://s3.example.com",
    S3_REGION: "us-east-1",
    S3_BUCKET: "test",
    S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret",
    S3_PREFIX: "test"
  });
}
