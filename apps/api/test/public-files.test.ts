import { describe, expect, it } from "vitest";
import { createPublicOpenApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";

function createConfig(publicApi?: Partial<RuntimeConfig["publicApi"]>): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
      sessionSecret: "session-secret"
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
      baseUrl: "https://kb.example.com/base",
      authRequired: true,
      apiKey: "public-secret",
      ...publicApi
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
      generationBatchSize: 50
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      cursorTtlSeconds: 900
    },
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

describe("Public file API compatibility boundary", () => {
  it("does not require old unscoped single-bundle public paths", async () => {
    const app = createPublicOpenApiApp({ config: createConfig() });

    for (const path of [
      "/index.md",
      "/schema.md",
      "/pages/intro.md",
      "/sources/intro.md",
      "/_index/search.json"
    ]) {
      const response = await app.request(path, {
        headers: {
          authorization: "Bearer public-secret"
        }
      });

      expect(response.status).toBe(404);
    }
  });

  it("still keeps admin routes out of the public OpenAPI app", async () => {
    const app = createPublicOpenApiApp({ config: createConfig() });
    const response = await app.request("/admin/api/session", {
      headers: {
        authorization: "Bearer public-secret"
      }
    });

    expect(response.status).toBe(404);
  });

  it("rejects unsafe paths before any public route lookup", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig({
        authRequired: false,
        apiKey: null
      })
    });
    const traversal = await app.request("/kb/kb-001/pages/%5Csecret.md");
    const encodedTraversal = await app.request("/kb/kb-001/pages/%252e%252e/secret.md");

    await expect(traversal.json()).resolves.toEqual({
      error: { code: "INVALID_PATH" }
    });
    await expect(encodedTraversal.json()).resolves.toEqual({
      error: { code: "INVALID_PATH" }
    });
    expect(traversal.status).toBe(400);
    expect(encodedTraversal.status).toBe(400);
  });
});
