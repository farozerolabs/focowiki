import { describe, expect, it, vi } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type {
  StorageVnextAdminCoreApplication,
  StorageVnextAdminCoreResult
} from "../src/storage-vnext/api/admin-core-application.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

describe("admin source deletion", () => {
  it("keeps the released success response while delegating deletion to vNext", async () => {
    const deleteSourceFile = vi.fn(async () => success({
      accepted: true,
      operationId: "deletion-source-file"
    }));
    const app = createApp(deleteSourceFile);
    const cookie = await loginAndReadSessionCookie(app);

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages%2Fintro.md",
      {
        method: "DELETE",
        headers: withTrustedAdminOrigin({ cookie })
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      operationId: "deletion-source-file"
    });
    expect(deleteSourceFile).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-001",
      logicalPath: "pages/intro.md"
    });
  });

  it("keeps the released invalid-deletion response", async () => {
    const deleteSourceFile = vi.fn(async () => failure("FILE_NOT_DELETABLE"));
    const app = createApp(deleteSourceFile);
    const cookie = await loginAndReadSessionCookie(app);

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=index.md",
      {
        method: "DELETE",
        headers: withTrustedAdminOrigin({ cookie })
      }
    );

    expect(response.status).toBe(400);
  });

  it("keeps the released not-found response", async () => {
    const deleteSourceFile = vi.fn(async () => failure("NOT_FOUND"));
    const app = createApp(deleteSourceFile);
    const cookie = await loginAndReadSessionCookie(app);

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages%2Fmissing.md",
      {
        method: "DELETE",
        headers: withTrustedAdminOrigin({ cookie })
      }
    );

    expect(response.status).toBe(404);
  });
});

function createApp(
  deleteSourceFile: StorageVnextAdminCoreApplication["deleteSourceFile"]
) {
  return createApiApp({
    config: testConfig(),
    redis: createTestRedisCoordinator(),
    storageVnextAdminCore: {
      ...unavailableCoreApplication(),
      deleteSourceFile
    }
  });
}

function unavailableCoreApplication(): StorageVnextAdminCoreApplication {
  const unavailable = async () => failure("DATABASE_REPOSITORY_UNAVAILABLE");
  return {
    createKnowledgeBase: unavailable,
    getKnowledgeBase: unavailable,
    deleteKnowledgeBase: unavailable,
    readGeneratedContent: unavailable,
    deleteSourceFile: unavailable,
    listFiles: unavailable,
    getFile: unavailable
  };
}

function success<T>(value: T): StorageVnextAdminCoreResult<T> {
  return { ok: true, value };
}

function failure(
  code: "DATABASE_REPOSITORY_UNAVAILABLE" | "NOT_FOUND" | "FILE_NOT_DELETABLE"
): StorageVnextAdminCoreResult<never> {
  return { ok: false, code };
}

function testConfig() {
  return parseRuntimeConfig({
    APP_ENV: "development",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "admin-secret",
    DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:55432/focowiki",
    REDIS_URL: "redis://127.0.0.1:56379/0",
    PUBLIC_BASE_URL: "https://openapi.example.com",
    SEARCH_PROVIDER: "meilisearch",
    SEARCH_INDEX_PREFIX: "focowiki_test",
    MEILI_HOST: "http://127.0.0.1:57700",
    S3_ENDPOINT: "https://s3.example.com",
    S3_REGION: "us-east-1",
    S3_BUCKET: "test",
    S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret",
    S3_PREFIX: "test"
  });
}
