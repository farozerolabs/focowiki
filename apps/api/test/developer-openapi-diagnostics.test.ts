import { Hono } from "hono";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeLogger,
  type RuntimeLogger,
  type RuntimeLogSink
} from "../src/logger.js";
import {
  installDeveloperOpenApiDiagnosticBoundary,
  readDeveloperJsonObjectBody,
  safe
} from "../src/developer-openapi/route-helpers.js";
import {
  readNullableQuery,
  registerDeveloperOpenApiSourceResourceRoutes
} from "../src/developer-openapi/source-resource-routes.js";
import { createDeveloperOpenApiBodyLimit } from
  "../src/developer-openapi/security.js";
import { hasNonEmptyMarkdownBody } from
  "../src/developer-openapi/upload-session-routes.js";
import type { DeveloperOpenApiRouteServices } from
  "../src/developer-openapi/routes.js";
import type { DeveloperOpenApiApplication } from
  "../src/developer-openapi/services.js";
import { SourceResourceError } from "../src/domain/source-resource.js";
import { SourcePathValidationError } from "../src/domain/source-path.js";

describe("Developer OpenAPI diagnostics", () => {
  it("rejects JSON request bodies with invalid UTF-8 bytes", async () => {
    const app = new Hono();
    app.post("/openapi/v2/knowledge-bases", (context) =>
      safe(context, async () => ({
        body: await readDeveloperJsonObjectBody(context.req.raw)
      }))
    );

    const response = await app.request("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([
        0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22,
        0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d
      ])
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        httpStatus: 422
      }
    });
  });

  it("rejects JSON fields that are not part of the documented request schema", async () => {
    const app = new Hono();
    app.post("/openapi/v2/knowledge-bases", (context) =>
      safe(context, async () => ({
        body: await readDeveloperJsonObjectBody(context.req.raw, ["name", "description"])
      }))
    );

    const response = await app.request("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Handbook", internalFlag: true })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: { fields: ["internalFlag"] }
      }
    });
  });

  it("rejects JSON bodies sent with an undocumented media type", async () => {
    const app = new Hono();
    app.post("/openapi/v2/knowledge-bases", (context) =>
      safe(context, async () => ({
        body: await readDeveloperJsonObjectBody(context.req.raw, ["name", "description"])
      }))
    );

    const response = await app.request("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "Handbook" })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        httpStatus: 422,
        message: "An application/json request body is required."
      }
    });
  });

  it("rejects a Developer OpenAPI body above the configured source byte ceiling", async () => {
    const app = new Hono();
    app.use("/openapi/v2/*", createDeveloperOpenApiBodyLimit({
      pagination: {
        generatedContentMaxBytes: 16
      }
    }));
    app.post("/openapi/v2/knowledge-bases", (context) => context.json({ accepted: true }));

    const response = await app.request("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Handbook" })
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        httpStatus: 413
      }
    });
  });

  it("treats a zero-length Markdown request stream as an empty upload body", () => {
    const request = new Request("http://openapi.local/upload", {
      method: "PUT",
      headers: {
        "content-type": "text/markdown",
        "content-length": "0"
      },
      body: new ReadableStream({
        start(controller) {
          controller.close();
        }
      }),
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    expect(hasNonEmptyMarkdownBody(request)).toBe(false);
  });

  it("rejects an empty directory query instead of treating it as the documented root token", () => {
    expect(readNullableQuery(undefined)).toBeNull();
    expect(readNullableQuery("root")).toBeNull();
    expect(readNullableQuery("x".repeat(200))).toBe("x".repeat(200));
    expect(() => readNullableQuery("")).toThrowError("Directory filter must be `root` or a non-empty identifier.");
    expect(() => readNullableQuery("x".repeat(201))).toThrowError("Directory filter must not exceed 200 characters.");
  });

  it("returns a conflict when a concurrent knowledge-base update is busy", async () => {
    const app = new Hono();
    registerDeveloperOpenApiSourceResourceRoutes(
      app,
      {
        sourceApplication: {
          available: () => true,
          updateKnowledgeBase: vi.fn(async () => {
            throw new SourceResourceError("RESOURCE_BUSY");
          })
        }
      } as unknown as DeveloperOpenApiRouteServices,
      {} as DeveloperOpenApiApplication
    );

    const response = await app.request("/openapi/v2/knowledge-bases/kb-busy", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": "1"
      },
      body: JSON.stringify({ description: "Concurrent update" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "CONFLICT",
        httpStatus: 409,
        message: "RESOURCE_BUSY"
      }
    });
  });

  it.each([
    [
      "/openapi/v2/knowledge-bases/kb/source-directories/directory",
      "moveSourceDirectory"
    ],
    [
      "/openapi/v2/knowledge-bases/kb/source-files/source-file",
      "moveSourceFile"
    ]
  ])("rejects a null move body before calling %s", async (pathname, methodName) => {
    const mutation = vi.fn();
    const app = new Hono();
    registerDeveloperOpenApiSourceResourceRoutes(
      app,
      {
        sourceApplication: {
          available: () => true,
          [methodName]: mutation
        }
      } as unknown as DeveloperOpenApiRouteServices,
      {} as DeveloperOpenApiApplication
    );

    const response = await app.request(pathname, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "move-null-body",
        "if-match": "1"
      },
      body: "null"
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        httpStatus: 422,
        details: { field: "relativePath" }
      }
    });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("maps source path validation failures to the documented move-file error", async () => {
    const app = new Hono();
    registerDeveloperOpenApiSourceResourceRoutes(
      app,
      {
        sourceApplication: {
          available: () => true,
          moveSourceFile: vi.fn(async () => {
            throw new SourcePathValidationError("extension", "x");
          })
        }
      } as unknown as DeveloperOpenApiRouteServices,
      {} as DeveloperOpenApiApplication
    );

    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb/source-files/source-file",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "invalid-file-path",
          "if-match": "1"
        },
        body: JSON.stringify({ relativePath: "x" })
      }
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        httpStatus: 422,
        details: { field: "relativePath" }
      }
    });
  });

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
        file: {
          directory: logDir,
          maxBytes: 4_096,
          maxFiles: 2,
          maxTotalBytes: 8_192,
          retentionDays: 7
        }
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
      expect(files).toEqual(["focowiki-api.1.log.gz", "focowiki-api.log"]);
      const persisted = files
        .map((file) => file.endsWith(".gz")
          ? gunzipSync(readFileSync(join(logDir, file))).toString("utf8")
          : readFileSync(join(logDir, file), "utf8"))
        .join("\n");
      expect(persisted).toContain("developer_openapi.request_failed");
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

function silentSink(): RuntimeLogSink {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {}
  };
}
