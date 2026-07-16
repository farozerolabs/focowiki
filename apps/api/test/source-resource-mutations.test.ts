import { describe, expect, it, vi } from "vitest";
import { createSourceResourceMutationService } from "../src/application/source-resource-mutations.js";
import type { SourceResourceRepository } from "../src/application/ports/source-resource-repository.js";
import type { ResourceOperationRecord } from "../src/domain/source-resource.js";
import { SourceResourceError } from "../src/domain/source-resource.js";

describe("source resource mutations", () => {
  it("uses a unique object for identical replacements so conflict cleanup cannot delete accepted content", async () => {
    const createOperation = vi.fn()
      .mockResolvedValueOnce({ operation: operation(), replayed: false })
      .mockRejectedValueOnce(new SourceResourceError("RESOURCE_REVISION_CONFLICT"));
    const put = vi.fn(async (_entry: {
      key: string;
      body: Uint8Array;
      contentType: string;
    }) => undefined);
    const remove = vi.fn(async (_key: string) => undefined);
    let sequence = 0;
    const service = createSourceResourceMutationService({
      repository: { createOperation } as unknown as SourceResourceRepository,
      worker: {
        enqueueResourceOperationJob: vi.fn(async () => null),
        enqueuePublicationJob: vi.fn(async () => null)
      },
      storage: {
        sourceRevisionKey: (_knowledgeBaseId, _sourceFileId, revision) => `revisions/${revision}.md`,
        put,
        delete: remove
      },
      runtime: {
        clock: { now: () => new Date("2026-07-15T00:00:00.000Z") },
        ids: { create: (prefix) => `${prefix}-${++sequence}` }
      }
    });
    const request = {
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-test",
      expectedResourceRevision: 1,
      bytes: new TextEncoder().encode("# Identical Markdown\n"),
      maxAttempts: 3
    };

    await expect(service.replaceSourceContent({
      ...request,
      idempotencyKey: "accepted-replacement"
    })).resolves.toMatchObject({ replayed: false });
    await expect(service.replaceSourceContent({
      ...request,
      idempotencyKey: "stale-replacement"
    })).rejects.toMatchObject({ code: "RESOURCE_REVISION_CONFLICT" });

    const storedKeys = put.mock.calls.map(([entry]) => entry.key);
    expect(storedKeys).toHaveLength(2);
    expect(storedKeys[0]).not.toBe(storedKeys[1]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(storedKeys[1]);
    expect(remove).not.toHaveBeenCalledWith(storedKeys[0]);
  });
});

function operation(): ResourceOperationRecord {
  return {
    id: "resource-operation-test",
    knowledgeBaseId: "kb-test",
    kind: "source_file_replace",
    state: "accepted",
    expectedResourceRevision: 1,
    candidateCatalogGeneration: 1,
    result: null,
    errorCode: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    completedAt: null
  };
}
