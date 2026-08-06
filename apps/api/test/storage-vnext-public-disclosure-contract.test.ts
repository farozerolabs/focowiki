import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { renderOkfLog, sanitizeIndexMetadata } from "@focowiki/okf";
import { describe, expect, it } from "vitest";
import {
  sanitizeStorageVnextPublicRecord,
  sanitizeStorageVnextPublicValue
} from "../src/storage-vnext/api/public-output-sanitizer.js";
import {
  createDeveloperOpenApiError,
  writeDeveloperOpenApiError
} from "../src/developer-openapi/errors.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const privateValues = [
  "private-object-key",
  "private-checksum",
  "private-index-uid",
  "private-task-uid",
  "private-table-name",
  "private-owner-row",
  "private-lease",
  "private-generation-detail",
  "private-cleanup-key"
];

describe("storage vNext public disclosure contract", () => {
  it("removes physical storage identities from released metadata and evidence", () => {
    const responses = [
      sanitizeStorageVnextPublicRecord({
        publicId: "source-public",
        ...internalPayload()
      }),
      sanitizeStorageVnextPublicRecord({
        publicId: "generation-public",
        ...internalPayload()
      }),
      sanitizeStorageVnextPublicValue(internalPayload())
    ];
    const serialized = JSON.stringify(responses);

    expect(serialized).toContain("safe-public-value");
    expect(serialized).toContain("generation-public");
    for (const value of privateValues) {
      expect(serialized, value).not.toContain(value);
    }
  });

  it("sanitizes arbitrary Developer OpenAPI error details", async () => {
    const app = new Hono();
    app.get("/error", (context) => writeDeveloperOpenApiError(
      context,
      createDeveloperOpenApiError("VALIDATION_ERROR", 422, "Request validation failed.", {
        field: "relativePath",
        ...internalPayload()
      })
    ));

    const response = await app.request("/error", {
      headers: { "x-request-id": "request-public" }
    });
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(422);
    expect(body).toContain("relativePath");
    for (const value of privateValues) {
      expect(body, value).not.toContain(value);
    }
  });

  it("routes operation results through the shared public sanitizer", () => {
    const source = readFileSync(
      resolve(workspaceRoot, "apps/api/src/developer-openapi/source-resource-routes.ts"),
      "utf8"
    );

    expect(source).toContain("sanitizeStorageVnextPublicValue(operation.result)");
    expect(source).not.toContain("function toPublicOperationResult(");
  });

  it("removes physical identities from generated metadata and log text", () => {
    const metadata = sanitizeIndexMetadata(internalPayload());
    const log = renderOkfLog({
      entries: [{
        occurredAt: "2026-08-02T00:00:00.000Z",
        action: "Publish",
        message: [
          "safe-public-value",
          "objectKey=private-object-key",
          "checksumSha256=private-checksum",
          "indexUid=private-index-uid",
          "taskUid=private-task-uid",
          "tableName=private-table-name",
          "ownerRow=private-owner-row",
          "leaseToken=private-lease",
          "generationDetails=private-generation-detail",
          "cleanupObjectKey=private-cleanup-key"
        ].join(" ")
      }]
    });
    const serialized = JSON.stringify({ metadata, log });

    expect(serialized).toContain("safe-public-value");
    for (const value of privateValues) {
      expect(serialized, value).not.toContain(value);
    }
  });

  it("keeps the frozen Admin UI free of physical storage fields", () => {
    const source = readSourceTree(resolve(workspaceRoot, "apps/admin/src"));

    expect(source).not.toMatch(
      /\b(?:objectKey|s3ObjectKey|indexUid|taskUid|tableName|ownerRow|leaseToken|leaseOwner)\b/u
    );
  });
});

function internalPayload(): Record<string, unknown> {
  return {
    safeField: "safe-public-value",
    objectKey: "private-object-key",
    checksumSha256: "private-checksum",
    indexUid: "private-index-uid",
    taskUid: "private-task-uid",
    tableName: "private-table-name",
    ownerRow: { id: "private-owner-row" },
    leaseToken: "private-lease",
    generationDetails: { predecessorGenerationId: "private-generation-detail" },
    cleanupObjectKey: "private-cleanup-key",
    metadata: {
      safeField: "safe-public-value",
      object_key: "private-object-key",
      checksum_sha256: "private-checksum",
      index_uid: "private-index-uid",
      task_uid: "private-task-uid",
      table_name: "private-table-name",
      owner_row: "private-owner-row",
      lease_token: "private-lease",
      generation_details: "private-generation-detail",
      cleanup_object_key: "private-cleanup-key"
    },
    evidence: {
      safeField: "safe-public-value",
      objectKey: "private-object-key",
      checksumSha256: "private-checksum",
      indexUid: "private-index-uid",
      taskUid: "private-task-uid",
      tableName: "private-table-name",
      ownerRow: "private-owner-row",
      leaseToken: "private-lease",
      generationDetails: "private-generation-detail",
      cleanupObjectKey: "private-cleanup-key"
    }
  };
}

function readSourceTree(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return [readSourceTree(path)];
      return /\.(?:ts|tsx)$/u.test(entry.name) ? [readFileSync(path, "utf8")] : [];
    })
    .join("\n");
}
