import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import type { SourceResourceFileRecord } from "../src/domain/source-resource.js";
import type { StorageVnextCatalogRepository } from
  "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextImmutableBodyStore } from
  "../src/storage-vnext/ownership/s3-immutable-body-store.js";
import type { StorageVnextReleaseReadPort } from
  "../src/storage-vnext/release/ports.js";
import type { StorageVnextAdminCoreApplication } from
  "../src/storage-vnext/api/admin-core-application.js";
import type { StorageVnextAdminMutationApplication } from
  "../src/storage-vnext/api/admin-mutation-application.js";
import { createPostgresStorageVnextAdminCore } from
  "../src/storage-vnext/api/postgres-admin-core.js";
import type {
  StorageVnextAdminResourceRead
} from "../src/storage-vnext/api/postgres-admin-resources.js";
import type { StorageVnextSourceEventSummary } from
  "../src/storage-vnext/source-events/ports.js";

describe("PostgreSQL storage vNext Admin core", () => {
  it.each([
    ["model invocation", { modelInvocationStatus: "not_recorded" }],
    ["started time", { startedFrom: "2026-08-01T00:00:00.000Z" }],
    ["ended time", { endedTo: "2026-08-02T00:00:00.000Z" }],
    ["error state", { errorState: "without_error" }],
    ["error code", { errorCodeQuery: "SOURCE" }],
    ["action state", { actionState: "none" }]
  ] as const)("passes the %s filter to the bounded resource query", async (_label, filters) => {
    const fixture = createFixture();

    const result = await fixture.application.listFiles({
      knowledgeBaseId: "kb-filter",
      limit: 20,
      cursor: null,
      filters
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{ id: "source-file-filter" }],
        nextCursor: null
      }
    });
    expect(fixture.listCalls).toEqual([
      expect.objectContaining({ filters: expect.objectContaining(filters) })
    ]);
  });

  it("returns processing timestamps that match the values used by the list", async () => {
    const fixture = createFixture({
      processingStatus: "completed",
      generatedOutputStatus: "visible",
      generatedPath: "page.md",
      updatedAt: "2026-08-01T00:05:00.000Z"
    });

    const result = await fixture.application.listFiles({
      knowledgeBaseId: "kb-filter",
      limit: 20,
      cursor: null,
      filters: {}
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{
          processingStartedAt: "2026-08-01T00:00:00.000Z",
          processingEndedAt: "2026-08-01T00:05:00.000Z"
        }]
      }
    });
  });

  it("returns the requested bounded source event page in file detail", async () => {
    const fixture = createFixture();

    const result = await fixture.application.getFile({
      knowledgeBaseId: "kb-filter",
      sourceFileId: "source-file-filter",
      limit: 2,
      cursor: "events-cursor"
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        events: {
          items: [
            { id: "source-event-one", stageKey: "upload_storage" },
            { id: "source-event-two", stageKey: "metadata_resolution" }
          ],
          nextCursor: "events-next"
        }
      }
    });
    expect(fixture.eventCalls).toEqual([{
      knowledgeBaseId: "kb-filter",
      sourceFileId: "source-file-filter",
      limit: 2,
      cursor: "events-cursor"
    }]);
  });
});

function createFixture(overrides: Partial<SourceResourceFileRecord> = {}): {
  application: StorageVnextAdminCoreApplication;
  listCalls: Array<Parameters<StorageVnextAdminResourceRead["listSourceFiles"]>[0]>;
  eventCalls: unknown[];
} {
  const listCalls: Array<Parameters<StorageVnextAdminResourceRead["listSourceFiles"]>[0]> = [];
  const eventCalls: unknown[] = [];
  const sourceFile: SourceResourceFileRecord = {
    id: "source-file-filter",
    knowledgeBaseId: "kb-filter",
    directoryId: null,
    name: "page.md",
    relativePath: "page.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 12,
    checksumSha256: "a".repeat(64),
    resourceRevision: 1,
    contentRevision: 1,
    activeRevisionId: "source-revision-filter",
    processingStatus: "queued",
    currentStage: "metadata_resolution",
    terminalFailure: null,
    generatedOutputStatus: "pending",
    generatedPath: null,
    deleting: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
  const resources: StorageVnextAdminResourceRead = {
    async listDirectories() {
      return { items: [], nextCursor: null };
    },
    async getDirectory() {
      return null;
    },
    async listSourceFiles(input) {
      listCalls.push(input);
      return { items: [sourceFile], nextCursor: null };
    },
    async getSourceFile() {
      return sourceFile;
    }
  };
  const application = createPostgresStorageVnextAdminCore({
    sql: (async () => []) as unknown as DatabaseClient,
    catalog: {} as StorageVnextCatalogRepository,
    releases: {} as StorageVnextReleaseReadPort,
    resources,
    sourceEvents: {
      async list(input: unknown) {
        eventCalls.push(input);
        return {
          items: [
            adminEvent("source-event-one", "upload_storage", 10),
            adminEvent("source-event-two", "metadata_resolution", 20)
          ],
          nextCursor: "events-next"
        };
      }
    },
    mutations: {} as StorageVnextAdminMutationApplication,
    bodies: {} as StorageVnextImmutableBodyStore,
    maximumGeneratedBytes: 1_048_576
  });
  return { application, listCalls, eventCalls };
}

function adminEvent(
  publicId: string,
  stageKey: StorageVnextSourceEventSummary["stageKey"],
  sequence: number
) {
  return {
    publicId,
    knowledgeBaseId: "kb-filter",
    sourceFilePublicId: "source-file-filter",
    sourceRevisionPublicId: "source-revision-filter",
    sequence,
    stageKey,
    messageKey: `sourceFiles.phase.${stageKey}`,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    severity: "info" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z"
  };
}
