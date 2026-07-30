import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeveloperOpenApiDocument } from "../src/developer-openapi/openapi-document.js";

describe("Developer OpenAPI generation schema", () => {
  it("documents a concrete purpose for every operation", () => {
    const document = createDeveloperOpenApiDocument();
    const operations = Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem)
    );

    expect(operations).toHaveLength(43);
    for (const operation of operations) {
      expect(readObject(operation).description).toEqual(expect.stringMatching(/\S/));
    }
  });

  it("describes file and directory changes without internal resource-operation labels", () => {
    const document = createDeveloperOpenApiDocument();
    for (const [path, operationId] of [
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations", "listResourceOperations"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations/{operationId}", "getResourceOperation"]
    ] as const) {
      const operation = readOperation(document, path, "get");
      expect(operation.operationId).toBe(operationId);
      expect(operation.tags).toEqual(["File and Directory Changes"]);
      expect(operation.summary).toEqual(expect.stringMatching(/file (?:and|or) directory change/i));
      expect(operation.summary).not.toEqual(expect.stringMatching(/resource operation/i));
    }
  });

  it("exposes final generated-file contracts without legacy bundle components", () => {
    const document = createDeveloperOpenApiDocument();
    const schemas = document.components.schemas;
    const serialized = JSON.stringify(document);

    expect(schemas).toHaveProperty("GeneratedTreeEntry");
    expect(schemas).toHaveProperty("GeneratedFile");
    expect(schemas).not.toHaveProperty("BundleTreeEntry");
    expect(schemas).not.toHaveProperty("BundleFile");
    expect(serialized).not.toContain("BundleTreeEntry");
    expect(serialized).not.toContain("BundleFile");
    expect(serialized).not.toContain("Bundle file identifier");
  });

  it("documents the same default tree parent used by the runtime", () => {
    const document = createDeveloperOpenApiDocument();
    const operation = document.paths["/openapi/v2/knowledge-bases/{knowledgeBaseId}/tree"]?.get as {
      parameters?: Array<{
        name?: string;
        in?: string;
        schema?: { default?: unknown };
      }>;
    } | undefined;
    const parentPath = operation?.parameters?.find((parameter) =>
      parameter.name === "parentPath"
    );

    expect(parentPath).toMatchObject({
      in: "query",
      schema: { default: "pages" }
    });
  });

  it("keeps checksums in upload requests and out of response schemas", () => {
    const schemas = createDeveloperOpenApiDocument().components.schemas;
    expect(schemas.UploadManifestEntryRequest?.properties).toHaveProperty("checksumSha256");
    for (const responseSchema of ["UploadSessionEntry", "SourceResourceFile", "GeneratedFile"]) {
      expect(schemas[responseSchema]?.properties).not.toHaveProperty("checksumSha256");
      expect(schemas[responseSchema]?.required).not.toContain("checksumSha256");
    }
  });

  it("documents runtime search errors, required queries, and all searchable file kinds", () => {
    const document = createDeveloperOpenApiDocument();
    const errorCode = readObject(readObject(document.components.schemas.Error).properties).error;
    const errorCodeSchema = readObject(readObject(readObject(errorCode).properties).code);
    expect(errorCodeSchema.enum).toEqual(expect.arrayContaining([
      "SEARCH_TIMEOUT",
      "SEARCH_UNAVAILABLE",
      "SEARCH_OVERLOADED"
    ]));

    const search = readOperation(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search",
      "get"
    );
    expect(readParameter(search, "query")).toMatchObject({ required: true });
    expect(readObject(readParameter(search, "fileKind").schema).enum).toContain("history_page");
    expect(readObject(readObject(document.components.schemas.FileSearchResult).properties).score)
      .toMatchObject({ type: "number" });
    expect(readObject(document.components.schemas.FileSearchResult).required)
      .toContain("matchType");
    expect(readObject(search.responses)).toHaveProperty("504");
    expect(readObject(readObject(search.responses)["503"])["x-error-codes"]).toEqual([
      "DATABASE_REPOSITORY_UNAVAILABLE",
      "SEARCH_UNAVAILABLE",
      "SEARCH_OVERLOADED"
    ]);
  });

  it("leaves deployment-controlled graph defaults and limits out of the static contract", () => {
    const document = createDeveloperOpenApiDocument();
    for (const path of [
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search",
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand"
    ]) {
      const operation = readOperation(document, path, "get");
      const graphDepth = readObject(readParameter(operation, "graphDepth").schema);
      const graphFanout = readObject(readParameter(operation, "graphFanout").schema);
      expect(graphDepth).not.toHaveProperty("default");
      expect(graphFanout).not.toHaveProperty("default");
      expect(graphFanout).not.toHaveProperty("maximum");
    }
  });

  it("matches upload, mutation, webhook, and retry response behavior", () => {
    const document = createDeveloperOpenApiDocument();
    const schemas = document.components.schemas;
    const manifestEntry = readObject(schemas.UploadManifestEntryRequest);
    expect(manifestEntry.required).not.toContain("checksumSha256");
    expect(readObject(readObject(manifestEntry.properties).checksumSha256))
      .toHaveProperty("anyOf");
    const uploadEntryId = readObject(
      readObject(readObject(schemas.UploadSessionEntry).properties).id
    );
    expect(uploadEntryId.description).not.toContain("multipart");

    expect(readObject(schemas.UpdateKnowledgeBaseRequest)).toMatchObject({
      minProperties: 1
    });
    expect(readObject(schemas.UploadSession).required).toEqual(expect.arrayContaining([
      "errorCode",
      "completedAt",
      "createdAt",
      "updatedAt"
    ]));
    expect(readObject(schemas.CreateUploadSessionResponse).required).toEqual([
      "session",
      "transport"
    ]);
    expect(readObject(readObject(schemas.UploadSessionResponse).properties))
      .not.toHaveProperty("transport");
    expect(
      readResponseSchemaRef(
        document,
        "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions",
        "post",
        "201"
      )
    ).toBe("#/components/schemas/CreateUploadSessionResponse");
    expect(
      readResponseSchemaRef(
        document,
        "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/seal",
        "post",
        "200"
      )
    ).toBe("#/components/schemas/UploadSessionResponse");

    const webhookRequest = readObject(schemas.WebhookCreateRequest);
    const webhookEvents = readObject(readObject(webhookRequest.properties).events);
    expect(webhookEvents).toMatchObject({ minItems: 1, uniqueItems: true });
    expect(readObject(webhookEvents.items).enum).toEqual([
      "source_file.accepted",
      "source_file.progress",
      "source_file.completed",
      "source_file.failed",
      "generation.activated",
      "file.deleted",
      "knowledge_base.deleted"
    ]);
    expect(readObject(readObject(webhookRequest.properties).url))
      .toMatchObject({ pattern: "^[Hh][Tt][Tt][Pp][Ss]://" });

    const retryResponse = readObject(schemas.SourceFileRetryResponse);
    expect(readObject(retryResponse.properties)).toHaveProperty("retry");
    const retryResponses = readObject(
      readOperation(
        document,
        "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry",
        "post"
      ).responses
    );
    expect(retryResponses).not.toHaveProperty("413");
    expect(retryResponses).not.toHaveProperty("422");
    expect(readObject(schemas.DeleteResponse).required).toEqual(["deleted", "webhookId"]);
    expect(
      readObject(
        readOperation(
          document,
          "/openapi/v2/webhook-deliveries/{deliveryId}/redeliver",
          "post"
        ).responses
      )
    ).toHaveProperty("409");
  });

  it("keeps the documented upload sequence internally consistent", () => {
    const document = createDeveloperOpenApiDocument();
    const createRequest = readObject(
      readOperation(
        document,
        "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions",
        "post"
      )["x-request-example"]
    );
    const manifestRequest = readObject(
      readOperation(
        document,
        "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries",
        "post"
      )["x-request-example"]
    );
    const contentRequest = readObject(
      readOperation(
        document,
        "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries/{entryId}/content",
        "put"
      )["x-request-example"]
    );
    const createBody = readObject(createRequest.body);
    const manifestEntries = readObject(manifestRequest.body).entries as unknown[];
    const manifestEntry = readObject(manifestEntries[0]);
    const content = String(contentRequest.body);

    expect(createBody.declaredFileCount).toBe(manifestEntries.length);
    expect(createBody.declaredByteCount).toBe(Buffer.byteLength(content));
    expect(manifestEntry.declaredSize).toBe(Buffer.byteLength(content));
    expect(manifestEntry.checksumSha256).toBe(
      createHash("sha256").update(content).digest("hex")
    );
  });

  it("keeps asynchronous operation links aligned with their response IDs", () => {
    const document = createDeveloperOpenApiDocument();
    for (const [path, method] of [
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}", "patch"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}", "delete"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content", "put"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", "patch"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", "delete"]
    ] as const) {
      const operation = readOperation(document, path, method);
      const responses = readObject(operation.responses);
      const example = readObject(
        readObject(readObject(readObject(responses["202"]).content)["application/json"]).example
      );
      const resourceOperation = readObject(example.operation);
      const actions = readObject(resourceOperation.actions);
      expect(actions.self).toBe(
        `/openapi/v2/knowledge-bases/kb-11111111-1111-4111-8111-111111111111/operations/${String(resourceOperation.operationId)}`
      );
    }
  });

  it("publishes the graph seed exclusivity rule as machine-readable contract metadata", () => {
    const operation = readOperation(
      createDeveloperOpenApiDocument(),
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand",
      "get"
    );
    expect(operation["x-exactly-one-query-parameter"]).toEqual([
      "fileId",
      "nodeId",
      "edgeId",
      "query"
    ]);
  });

  it("requires ancestor arrays on every generated tree entry", () => {
    const schema = readObject(
      createDeveloperOpenApiDocument().components.schemas.GeneratedTreeEntry
    );
    expect(schema.required).toEqual(expect.arrayContaining(["ancestors"]));
  });

  it("documents generated-content limits, source-content headers, and the complete contract response", () => {
    const document = createDeveloperOpenApiDocument();
    for (const path of [
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/content",
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content"
    ]) {
      expect(readObject(readOperation(document, path, "get").responses)).toHaveProperty("413");
    }

    const sourceContent = readObject(
      readObject(
        readOperation(
          document,
          "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content",
          "get"
        ).responses
      )["200"]
    );
    expect(readObject(sourceContent.headers)).toEqual(expect.objectContaining({
      ETag: expect.any(Object),
      "X-Content-Revision": expect.any(Object)
    }));

    const contractResponse = readObject(
      readObject(readOperation(document, "/openapi/v2/openapi.json", "get").responses)["200"]
    );
    const schema = readObject(readObject(readObject(contractResponse.content)["application/json"]).schema);
    expect(readObject(schema.properties)).toEqual(expect.objectContaining({
      openapi: expect.any(Object),
      info: expect.any(Object),
      paths: expect.any(Object),
      servers: expect.any(Object),
      security: expect.any(Object),
      tags: expect.any(Object),
      components: expect.any(Object)
    }));
  });
});

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOperation(
  document: ReturnType<typeof createDeveloperOpenApiDocument>,
  path: string,
  method: string
): Record<string, unknown> {
  return readObject(readObject(document.paths[path])[method]);
}

function readParameter(
  operation: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  return readObject(parameters.find((parameter) => readObject(parameter).name === name));
}

function readResponseSchemaRef(
  document: ReturnType<typeof createDeveloperOpenApiDocument>,
  path: string,
  method: string,
  status: string
): unknown {
  const response = readObject(readObject(readOperation(document, path, method).responses)[status]);
  const content = readObject(response.content);
  return readObject(readObject(content["application/json"]).schema).$ref;
}
