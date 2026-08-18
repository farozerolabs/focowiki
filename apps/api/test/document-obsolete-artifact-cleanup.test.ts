import { describe, expect, it, vi } from "vitest";
import { createDocumentObsoleteArtifactCleanupWorker } from
  "../src/document-indexing/application/document-obsolete-artifact-cleanup.js";

describe("document obsolete artifact cleanup", () => {
  it("rechecks current ownership before deleting a physical artifact", async () => {
    const remove = vi.fn();
    const complete = vi.fn(async () => true);
    const audit = vi.fn(async () => undefined);
    const worker = createDocumentObsoleteArtifactCleanupWorker({
      actions: actionPort({ attempt: 1, maximumAttempts: 3 }),
      ownership: { async isCurrentOwner() { return true; } },
      providers: { remove },
      audit: { record: audit },
      complete,
      retry: vi.fn(),
      fail: vi.fn()
    });

    await expect(worker.run(batchRequest())).resolves.toMatchObject({
      claimed: 1,
      skippedCurrent: 1,
      completed: 1
    });
    expect(remove).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      result: "success",
      reasonCode: "current_owner_present"
    }));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("bounds retries and exposes the terminal provider failure", async () => {
    const retry = vi.fn();
    const fail = vi.fn(async () => true);
    const audit = vi.fn(async () => undefined);
    const worker = createDocumentObsoleteArtifactCleanupWorker({
      actions: actionPort({ attempt: 3, maximumAttempts: 3 }),
      ownership: { async isCurrentOwner() { return false; } },
      providers: { async remove() { throw coded("provider_unavailable"); } },
      audit: { record: audit },
      complete: vi.fn(),
      retry,
      fail
    });

    await expect(worker.run(batchRequest())).resolves.toMatchObject({
      terminalFailed: 1,
      retried: 0
    });
    expect(retry).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      safeErrorCode: "provider_unavailable"
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      result: "failure",
      reasonCode: "provider_unavailable"
    }));
  });

  it("converges when the provider finds a current physical owner", async () => {
    const complete = vi.fn(async () => true);
    const retry = vi.fn();
    const audit = vi.fn(async () => undefined);
    const worker = createDocumentObsoleteArtifactCleanupWorker({
      actions: actionPort({ attempt: 2, maximumAttempts: 3 }),
      ownership: { async isCurrentOwner() { return false; } },
      providers: { async remove() { throw coded("owners_present"); } },
      audit: { record: audit },
      complete,
      retry,
      fail: vi.fn()
    });

    await expect(worker.run(batchRequest())).resolves.toMatchObject({
      skippedCurrent: 1,
      completed: 1,
      retried: 0
    });
    expect(retry).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      result: "success",
      reasonCode: "current_owner_present"
    }));
  });

  it("does not silently complete when durable audit recording fails", async () => {
    const retry = vi.fn(async () => true);
    const complete = vi.fn();
    const worker = createDocumentObsoleteArtifactCleanupWorker({
      actions: actionPort({ attempt: 1, maximumAttempts: 3 }),
      ownership: { async isCurrentOwner() { return false; } },
      providers: { async remove() {} },
      audit: { async record() { throw coded("audit_unavailable"); } },
      complete,
      retry,
      fail: vi.fn()
    });

    await expect(worker.run(batchRequest())).resolves.toMatchObject({
      retried: 1,
      completed: 0
    });
    expect(complete).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      safeErrorCode: "audit_unavailable"
    }));
  });
});

function actionPort(overrides: { attempt: number; maximumAttempts: number }) {
  return {
    async claim() {
      return [{
        publicId: "cleanup-a",
        knowledgeBaseId: "knowledge-base-a",
        sourceRevisionPublicId: "source-revision-old",
        searchProviderKind: null,
        plane: "object_storage" as const,
        resourceKind: "generated_object" as const,
        resourcePublicId: "object-old",
        attempt: overrides.attempt,
        maximumAttempts: overrides.maximumAttempts
      }];
    }
  };
}

function batchRequest() {
  return {
    owner: "cleanup-worker-a",
    searchProviderKind: "opensearch" as const,
    limit: 10,
    now: "2026-08-14T05:00:00.000Z",
    leaseExpiresAt: "2026-08-14T05:01:00.000Z",
    retryDelayMilliseconds: 1_000,
    signal: new AbortController().signal
  };
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
