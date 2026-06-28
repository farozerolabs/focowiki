import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { createTestRedisCoordinator, loginAndReadSessionCookie } from "./support/session.js";

function createConfig(): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
    },
    database: {
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki"
    },
    redis: {
      url: "redis://127.0.0.1:6379/0"
    },
    ports: {
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    },
    publicApi: {
      baseUrl: "https://kb.example.com"
    },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    upload: {
      maxBytes: 1_048_576,
      maxFiles: 8,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    },
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      treeDefaultPageSize: 100,
      treeMaxPageSize: 500,
      cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    },
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

function uploadForm(fileName: string): FormData {
  const form = new FormData();
  form.append(
    "files",
    new Blob(["---\ntype: page\ntitle: Intro\n---\n# Intro"], { type: "text/markdown" }),
    fileName
  );
  return form;
}

async function createAuthenticatedApp(): Promise<{
  app: ReturnType<typeof createApiApp>;
  cookie: string;
}> {
  const app = createApiApp({
    config: createConfig(),
    redis: createTestRedisCoordinator()
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie };
}

describe("obsolete pre-release Admin API routes", () => {
  it.each([
    {
      method: "POST",
      path: "/admin/api/uploads",
      body: uploadForm("intro.md")
    },
    {
      method: "POST",
      path: "/admin/api/generations",
      body: JSON.stringify({ sources: [] }),
      headers: { "content-type": "application/json" }
    },
    {
      method: "GET",
      path: "/admin/api/result/tree"
    },
    {
      method: "GET",
      path: "/admin/api/result/file?path=pages%2Fintro.md"
    },
    {
      method: "POST",
      path: "/admin/api/preview",
      body: JSON.stringify({ markdown: "# Preview" }),
      headers: { "content-type": "application/json" }
    }
  ])("does not expose $method $path", async (request) => {
    const { app, cookie } = await createAuthenticatedApp();
    const requestInit: RequestInit = {
      method: request.method,
      headers: {
        cookie,
        ...request.headers
      }
    };

    if (request.body !== undefined) {
      requestInit.body = request.body;
    }

    const response = await app.request(request.path, requestInit);

    expect(response.status).toBe(404);
  });
});
