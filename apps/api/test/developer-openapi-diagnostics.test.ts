import { Hono } from "hono";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeLogger, type RuntimeLogger } from "../src/logger.js";
import {
  installDeveloperOpenApiDiagnosticBoundary,
  safe
} from "../src/developer-openapi/route-helpers.js";

describe("Developer OpenAPI diagnostics", () => {
  it("correlates unexpected failures without logging request secrets", async () => {
    const logger = createLogger();
    const app = new Hono();
    const privateSourcePath = ["", "Users", "operator", "private", "query.ts"].join("/");
    installDeveloperOpenApiDiagnosticBoundary(app, {
      logger,
      operationIds: new Map([["GET /openapi/v2/knowledge-bases/:knowledgeBaseId/tree", "listKnowledgeBaseTree"]])
    });
    app.get("/openapi/v2/knowledge-bases/:knowledgeBaseId/tree", (context) =>
      safe(context, () => {
        throw new Error(
          "DATABASE_URL=postgres://admin:secret@db.internal/private "
          + `objectKey=generated/private/object ${privateSourcePath}`
        );
      })
    );

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-safe/tree?query=private-search-text",
      {
        headers: {
          authorization: "Bearer private-api-key",
          cookie: "session=private-cookie",
          "x-request-id": "req-diagnostic-1"
        }
      }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INTERNAL_ERROR" },
      requestId: "req-diagnostic-1"
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "Developer OpenAPI request failed",
      expect.objectContaining({
        requestId: "req-diagnostic-1",
        operationId: "listKnowledgeBaseTree",
        routeTemplate: "/openapi/v2/knowledge-bases/:knowledgeBaseId/tree",
        resourceContext: { knowledgeBaseId: "kb-safe" },
        errorClass: "Error",
        status: 500
      })
    );
    const serialized = JSON.stringify(vi.mocked(logger.error).mock.calls);
    for (const secret of [
      "private-api-key",
      "private-cookie",
      "private-search-text",
      "postgres://",
      "db.internal",
      "generated/private/object",
      privateSourcePath
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("writes redacted diagnostics through the bounded rotating runtime logger", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "focowiki-openapi-diagnostics-"));
    const app = new Hono();
    const logger = createRuntimeLogger({
      logging: {
        level: "debug",
        file: { directory: logDir, maxBytes: 900, maxFiles: 2 }
      }
    }, silentSink(), { streamName: "api" });
    installDeveloperOpenApiDiagnosticBoundary(app, {
      logger,
      operationIds: new Map([[
        "POST /openapi/v2/knowledge-bases/:knowledgeBaseId/tree",
        "listKnowledgeBaseTree"
      ]])
    });
    app.post("/openapi/v2/knowledge-bases/:knowledgeBaseId/tree", (context) =>
      safe(context, async () => {
        await context.req.json();
        throw new Error(
          "REDIS_URL=redis://private.internal:6379/0 "
          + "object_key=private/objects/tree.json C:\\private\\operator\\tree.ts"
        );
      })
    );

    try {
      for (let index = 0; index < 12; index += 1) {
        const response = await app.request(
          `/openapi/v2/knowledge-bases/kb-safe/tree?query=secret-query-${index}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer private-key-${index}`,
              cookie: `session=private-cookie-${index}`,
              "content-type": "application/json",
              "x-request-id": `req-rotation-${index}`
            },
            body: JSON.stringify({ apiKey: `body-secret-${index}` })
          }
        );
        expect(response.status).toBe(500);
      }

      const files = readdirSync(logDir)
        .filter((file) => file.startsWith("focowiki-api"))
        .sort();
      expect(files).toEqual(["focowiki-api.1.log", "focowiki-api.log"]);
      const persisted = files
        .map((file) => readFileSync(join(logDir, file), "utf8"))
        .join("\n");
      expect(persisted).toContain("Developer OpenAPI request failed");
      for (const secret of [
        "private-key-",
        "private-cookie-",
        "secret-query-",
        "body-secret-",
        "redis://",
        "private.internal",
        "private/objects/tree.json",
        "C:\\private\\operator\\tree.ts"
      ]) {
        expect(persisted).not.toContain(secret);
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

function createLogger() {
  const error = vi.fn((..._parts: unknown[]) => undefined);
  return {
    error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  } satisfies RuntimeLogger;
}

function silentSink(): RuntimeLogger {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {}
  };
}
