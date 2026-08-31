import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeveloperOpenApiDocument } from "../src/developer-openapi/openapi-document.js";

describe("Developer OpenAPI generation schema", () => {
  it("documents a concrete purpose for every operation", () => {
    const document = createDeveloperOpenApiDocument();
    const operations = Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem)
    );

    expect(operations).toHaveLength(42);
    for (const operation of operations) {
      expect(readObject(operation).description).toEqual(expect.stringMatching(/\S/));
    }
  });

  it("documents the request-size error for every operation with a request body", () => {
    const document = createDeveloperOpenApiDocument();
    const bodyOperations = Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem).filter((operation) => readObject(operation).requestBody)
    );

    expect(bodyOperations.length).toBeGreaterThan(0);
    for (const operation of bodyOperations) {
      expect(readObject(readObject(operation).responses)).toHaveProperty("413");
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

  it("documents how to check knowledge-base deletion completion", () => {
    const deletion = readOperation(
      createDeveloperOpenApiDocument(),
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}",
      "delete"
    );

    expect(String(deletion.description)).toMatch(/operation URL remains readable/iu);
    expect(String(deletion.description)).toMatch(/knowledge-base URL returns 404/iu);
    expect(String(deletion.description)).not.toMatch(/both.*404|pair of 404/iu);
    const accepted = readObject(readObject(deletion.responses)["202"]);
    expect(String(accepted.description)).toMatch(/operation used to check completion/iu);
    expect(String(accepted.description)).not.toMatch(/terminal|temporary operation handle/iu);
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

  it("documents mirrored graph resources with portable page paths", () => {
    const serialized = JSON.stringify(createDeveloperOpenApiDocument());

    expect(serialized).toContain("_graph/by-file/handbook/guide.json");
    expect(serialized).toContain("_graph/by-file/reference.json");
    expect(serialized).not.toContain(
      "_graph/by-file/source-file-11111111-1111-4111-8111-111111111111.json"
    );
    expect(serialized).not.toContain(
      "_graph/by-file/source-file-22222222-2222-4222-8222-222222222222.json"
    );
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
      schema: { default: "root" }
    });
    expect(operation?.parameters?.some((parameter) => parameter.name === "query"))
      .toBe(false);
  });

  it("documents the public generated-file path suffix accepted by the runtime", () => {
    const document = createDeveloperOpenApiDocument();
    const operation = readOperation(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/content",
      "get"
    );

    expect(readObject(readParameter(operation, "path").schema)).toMatchObject({
      type: "string",
      pattern: "\\.(?:md|json)$",
      example: "index.md"
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

  it("documents one bidirectional related-file result instead of duplicate directions", () => {
    const direction = readObject(readObject(
      createDeveloperOpenApiDocument().components.schemas.RelatedFile
    ).properties).direction;

    expect(readObject(direction).enum).toEqual([
      "outgoing",
      "incoming",
      "bidirectional"
    ]);
  });

  it("documents runtime search errors, required queries, and source-file search kinds", () => {
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
    expect(readObject(readParameter(search, "fileKind").schema).enum).toEqual([
      "all",
      "page"
    ]);
    expect(String(readParameter(search, "mode").description)).toContain("file data");
    expect(String(readParameter(search, "mode").description)).toContain("semantic similarity");
    expect(String(readParameter(search, "mode").description)).not.toMatch(/lane|vector family/iu);
    expect(String(readParameter(search, "query").description)).toContain("2048 UTF-8 bytes");
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
    expect(search["x-validation-detail-codes"]).toEqual(expect.arrayContaining([
      "FILE_SEARCH_QUERY_REQUIRED",
      "INVALID_FILE_SEARCH_KIND",
      "INVALID_FILE_SEARCH_RERANK_CONTROLS"
    ]));

    const response = readObject(document.components.schemas.FileSearchResponse);
    const responseProperties = readObject(response.properties);
    expect(readObject(responseProperties.searchStatus).enum).toEqual([
      "ok",
      "no_candidates"
    ]);
    expect(readObject(readObject(responseProperties.evidenceStatus).properties))
      .toMatchObject({
        completedFamilies: {
          items: {
            enum: expect.arrayContaining(["exact_path", "content_vector"])
          }
        }
      });
    expect(readObject(readObject(responseProperties.semanticStatus).properties).safeCode)
      .toMatchObject({
        anyOf: expect.arrayContaining([
          expect.objectContaining({
            enum: expect.arrayContaining(["SEMANTIC_ADOPTION_REQUIRED"])
          })
        ])
      });
    expect(readObject(readObject(responseProperties.rerankerStatus).properties).safeCode)
      .toMatchObject({
        anyOf: expect.arrayContaining([
          expect.objectContaining({
            enum: expect.arrayContaining([
              "RERANKER_DISABLED",
              "RERANKER_ABORTED",
              "RERANKER_AUTHENTICATION_FAILED",
              "RERANKER_INVALID_RESPONSE",
              "RERANKER_PROVIDER_UNAVAILABLE",
              "RERANKER_RATE_LIMITED",
              "RERANKER_RESPONSE_TOO_LARGE",
              "RERANKER_TIMEOUT"
            ])
          })
        ])
      });

    const searchResult = readObject(document.components.schemas.FileSearchResult);
    expect(readObject(readObject(searchResult.properties).matchType).enum).toEqual([
      "file_direct",
      "graph_node",
      "graph_edge",
      "graph_neighbor",
      "hybrid"
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
    expect(readObject(readObject(schemas.CreateKnowledgeBaseRequest).properties).name)
      .toMatchObject({ maxLength: 255 });
    expect(readObject(
      readObject(readObject(schemas.CreateKnowledgeBaseRequest).properties).description
    ).anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "string", maxLength: 16_384 })
    ]));
    expect(readObject(readObject(schemas.UpdateKnowledgeBaseRequest).properties).name)
      .toMatchObject({ maxLength: 255 });
    expect(readObject(
      readObject(readObject(schemas.UpdateKnowledgeBaseRequest).properties).description
    ).anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "string", maxLength: 16_384 })
    ]));
    expect(readRequestSchemaRef(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}",
      "patch"
    )).toBe("#/components/schemas/UpdateKnowledgeBaseRequest");
    expect(readResponseSchemaRef(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}",
      "patch",
      "200"
    )).toBe("#/components/schemas/KnowledgeBaseMutationResponse");
    expect(readObject(readObject(schemas.MoveSourceFileRequest).properties).relativePath)
      .toMatchObject({
        maxLength: 2_048,
        pattern: "^(?:[^/]{1,1000}/)*[^/]{1,997}\\.md$"
      });
    expect(readObject(readObject(schemas.MoveSourceDirectoryRequest).properties).relativePath)
      .toMatchObject({
        maxLength: 2_048,
        pattern: "^(?:[^/]{1,1000}/)*[^/]{1,1000}$"
      });
    expect(schemas).not.toHaveProperty("MoveSourceResourceRequest");
    expect(readRequestSchemaRef(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
      "patch"
    )).toBe("#/components/schemas/MoveSourceFileRequest");
    expect(readRequestSchemaRef(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}",
      "patch"
    )).toBe("#/components/schemas/MoveSourceDirectoryRequest");
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
      "document.waiting",
      "document.processing",
      "document.available",
      "document.error",
      "document.deleting",
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
        `/openapi/v2/knowledge-bases/knowledge-base-11111111-1111-4111-8111-111111111111/operations/${String(resourceOperation.operationId)}`
      );
    }
  });

  it("uses public runtime identity prefixes in every generated example", () => {
    const serialized = JSON.stringify(createDeveloperOpenApiDocument());

    expect(serialized).toContain("knowledge-base-11111111-1111-4111-8111-111111111111");
    expect(serialized).toContain("upload-11111111-1111-4111-8111-111111111111");
    expect(serialized).toContain("directory-11111111-1111-4111-8111-111111111111");
    expect(serialized).toContain("source-move-11111111-1111-4111-8111-111111111111");
    expect(serialized).toContain("directory-move-22222222-2222-4222-8222-222222222222");
    expect(serialized).toContain("deletion-33333333-3333-4333-8333-333333333333");
    expect(serialized).toContain("source-replace-44444444-4444-4444-8444-444444444444");
    expect(serialized).not.toMatch(/\bkb-11111111|upload-session-11111111|source-directory-11111111|resource-operation-/u);
  });

  it("publishes the upload operation handle and progressive document counters", () => {
    const document = createDeveloperOpenApiDocument();
    const createOperation = readOperation(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions",
      "post"
    );
    const responses = readObject(createOperation.responses);
    const responseExample = readObject(
      readObject(readObject(readObject(responses["201"]).content)["application/json"]).example
    );
    const session = readObject(responseExample.session);
    const actions = readObject(session.actions);
    expect(actions.operation).toBe(
      `/openapi/v2/knowledge-bases/${String(session.knowledgeBaseId)}/operations/${String(session.operationId)}`
    );

    const operationSchema = readObject(
      readObject(readObject(document.components).schemas).ResourceOperation
    );
    const operationProperties = readObject(operationSchema.properties);
    expect(readObject(operationProperties.kind).enum).toEqual([
      "upload",
      "knowledge_base_metadata",
      "source_file_metadata",
      "source_file_replace",
      "source_file_move",
      "source_directory_move",
      "source_file_delete",
      "source_directory_delete",
      "knowledge_base_delete"
    ]);
    expect(readObject(operationProperties.state).enum).toEqual([
      "processing",
      "completed",
      "failed",
      "cancelled",
      "superseded"
    ]);
    const resultProperties = readObject(readObject(operationProperties.result).properties);
    expect(Object.keys(resultProperties)).toEqual([
      "totalCount",
      "waitingCount",
      "processingCount",
      "availableCount",
      "failedCount",
      "deletingCount",
      "cancelledCount",
      "supersededCount"
    ]);
    expect(readObject(operationProperties.result).additionalProperties).toBe(false);
  });

  it("accepts one readable file ID as the only graph expansion seed", () => {
    const operation = readOperation(
      createDeveloperOpenApiDocument(),
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand",
      "get"
    );
    expect(operation["x-exactly-one-query-parameter"]).toBeUndefined();
    expect(readParameter(operation, "fileId")).toMatchObject({ required: true });
    expect((operation.parameters as Array<Record<string, unknown>>)
      .map((parameter) => parameter.name)).toEqual([
      "knowledgeBaseId", "fileId", "depth", "fanout", "limit", "cursor"
    ]);
    expect(operation["x-validation-detail-codes"]).toEqual(expect.arrayContaining([
      "GRAPH_EXPANSION_FILE_ID_REQUIRED",
      "INVALID_GRAPH_EXPANSION_DEPTH"
    ]));
  });

  it("removes duplicate and unproducible discovery fields", () => {
    const schemas = createDeveloperOpenApiDocument().components.schemas;
    const search = readObject(readObject(schemas.FileSearchResult).properties);
    expect(search).not.toHaveProperty("generatedFileId");
    expect(search).not.toHaveProperty("generatedFilePath");
    expect(search).not.toHaveProperty("nodeId");
    expect(search).not.toHaveProperty("edgeId");

    const related = readObject(readObject(schemas.RelatedFile).properties);
    expect(related).not.toHaveProperty("edgeId");
    expect(related).not.toHaveProperty("weight");
    expect(related).not.toHaveProperty("source");
    expect(related).not.toHaveProperty("evidence");

    const expansion = readObject(readObject(schemas.GraphExpansionResponse).properties);
    expect(expansion).not.toHaveProperty("query");
    expect(expansion).not.toHaveProperty("seedResults");

    const overview = readObject(readObject(schemas.GraphOverviewResponse).properties);
    const summary = readObject(readObject(overview.summary).properties);
    expect(Object.keys(summary)).toEqual(["readableFileCount", "relationshipCount"]);
    const resources = readObject(readObject(overview.resources).properties);
    expect(Object.keys(resources)).toEqual([
      "graphIndexPath", "byDirectoryPath", "byFilePath"
    ]);
    const actions = readObject(readObject(overview.readActions).properties);
    expect(Object.keys(actions)).toEqual([
      "graphIndexContent",
      "listGraphRoot",
      "listRelationshipsByDirectory",
      "listRelationshipsByFile"
    ]);
    expect(schemas).not.toHaveProperty("FileSearchNextRequestTemplates");
    expect(readObject(readObject(schemas.FileSearchResponse).properties))
      .not.toHaveProperty("nextRequestTemplates");
    expect(overview).not.toHaveProperty("message");
    expect(overview).not.toHaveProperty("nextActions");
  });

  it("keeps webhook handoffs minimal and executable", () => {
    const document = createDeveloperOpenApiDocument();
    const createWebhook = readOperation(document, "/openapi/v2/webhooks", "post");
    expect((createWebhook.parameters as Array<Record<string, unknown>>)
      .map((parameter) => parameter.name)).toEqual(["Idempotency-Key"]);
    const webhook = readObject(document.components.schemas.Webhook);
    const webhookProperties = readObject(webhook.properties);
    expect(webhookProperties).not.toHaveProperty("enabled");
    expect(webhookProperties).not.toHaveProperty("updatedAt");

    const delivery = readObject(document.components.schemas.WebhookDelivery);
    expect(readObject(delivery.properties)).toHaveProperty("payload");

    const listDeliveries = readOperation(
      document,
      "/openapi/v2/webhook-deliveries",
      "get"
    );
    expect((listDeliveries.parameters as Array<Record<string, unknown>>)
      .map((parameter) => parameter.name)).toEqual([
      "webhookId", "limit", "cursor"
    ]);
  });

  it("keeps generated tree entries limited to direct browsing fields", () => {
    const schema = readObject(
      createDeveloperOpenApiDocument().components.schemas.GeneratedTreeEntry
    );
    expect(schema.required).not.toContain("ancestors");
    expect(readObject(schema.properties)).not.toHaveProperty("ancestors");
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

  it("describes knowledge-base metadata updates as synchronous saved changes", () => {
    const operation = readOperation(
      createDeveloperOpenApiDocument(),
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}",
      "patch"
    );
    expect(operation.description).toContain("updated record is returned after the change is saved");
    expect(operation.description).not.toMatch(/background|poll/iu);

    const response = readObject(readObject(operation.responses)["200"]);
    expect(response.description).toBe("Updated knowledge-base record.");
  });

  it("shows the processing state returned by accepted resource mutations", () => {
    const document = createDeveloperOpenApiDocument();
    for (const [path, method] of [
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}", "delete"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}", "patch"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}", "delete"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content", "put"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", "patch"],
      ["/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}", "delete"]
    ] as const) {
      const response = readObject(
        readObject(readOperation(document, path, method).responses)["202"]
      );
      const example = readObject(
        readObject(readObject(response.content)["application/json"]).example
      );
      expect(readObject(example.operation).state).toBe("processing");
    }
  });

  it("publishes only upload progress fields and states that the runtime can produce", () => {
    const document = createDeveloperOpenApiDocument();
    const session = readObject(document.components.schemas.UploadSession);
    expect(readObject(readObject(session.properties).state).enum).toEqual([
      "draft",
      "manifest_building",
      "manifest_sealed",
      "uploading",
      "finalizing",
      "completed",
      "cancelled",
      "expired"
    ]);
    const counts = readObject(document.components.schemas.UploadSessionCounts);
    expect(readObject(counts.properties)).not.toHaveProperty("failed");
    expect(counts.required).not.toContain("failed");

    const entry = readObject(document.components.schemas.UploadSessionEntry);
    const properties = readObject(entry.properties);
    expect(properties).not.toHaveProperty("sourceDirectoryId");
    expect(properties).not.toHaveProperty("generatedPath");
    expect(properties).not.toHaveProperty("errorCode");
    expect(readObject(properties.disposition).enum).toEqual([
      "upload_required",
      "skipped_existing",
      "waiting_reservation",
      "rejected_deleting"
    ]);
    expect(readObject(properties.transferState).enum).toEqual([
      "missing",
      "uploaded",
      "skipped"
    ]);

    const operation = readOperation(
      document,
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}",
      "get"
    );
    expect(readObject(readParameter(operation, "transferState").schema).enum).toEqual([
      "missing",
      "uploaded"
    ]);

    const sourceFile = readObject(document.components.schemas.SourceResourceFile);
    const sourceFileProperties = readObject(sourceFile.properties);
    expect(readObject(sourceFileProperties.contentRevision)).toMatchObject({
      type: "integer",
      minimum: 0
    });
    for (const redundantField of [
      "activeRevisionId",
      "mutable",
      "deletable",
      "deleting"
    ]) {
      expect(sourceFileProperties).not.toHaveProperty(redundantField);
      expect(sourceFile.required).not.toContain(redundantField);
    }
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

function readRequestSchemaRef(
  document: ReturnType<typeof createDeveloperOpenApiDocument>,
  path: string,
  method: string
): unknown {
  const requestBody = readObject(readOperation(document, path, method).requestBody);
  const content = readObject(requestBody.content);
  return readObject(readObject(content["application/json"]).schema).$ref;
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
