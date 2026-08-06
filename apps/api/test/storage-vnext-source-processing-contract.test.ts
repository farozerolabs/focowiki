import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StorageVnextSourceEventSummary } from
  "../src/storage-vnext/source-events/ports.js";

type Worker = {
  runOnce(input: {
    owner: string;
    limit: number;
    leaseExpiresAt: string;
    signal?: AbortSignal;
  }): Promise<{ claimed: number; completed: number; retried: number; terminal: number }>;
};

type WorkerFactory = (input: ReturnType<typeof createFixture>["ports"] & {
  limits: {
    maximumConcurrency: number;
    maximumSourceBytes: number;
    maximumAttempts: number;
    attemptDeadlineMilliseconds: number;
    retryDelayMilliseconds: number;
    resultRetentionMilliseconds: number;
  };
  clock: () => string;
  onFailure?: (failure: {
    operationPublicId: string;
    knowledgeBaseId: string;
    attempt: number;
    code: string;
    error: unknown;
  }) => void;
  webhooks?: { dispatch(event: Record<string, unknown>): Promise<void> };
  onWebhookError?: (error: unknown) => void;
}) => Worker;

let factory: WorkerFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/source-processing/worker.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as { createStorageVnextSourceProcessingWorker?: WorkerFactory };
  factory = loaded.createStorageVnextSourceProcessingWorker;
});

describe("storage vNext source/model processing contract", () => {
  it("claims a bounded source batch and streams the current revision into one durable handoff", async () => {
    const fixture = createFixture();
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest(1))).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      terminal: 0
    });

    expect(fixture.workflow.claim).toHaveBeenCalledWith({
      kinds: ["source"],
      owner: "source-worker-one",
      limit: 1,
      leaseExpiresAt: "2026-08-01T00:05:00.000Z"
    });
    expect(fixture.bodyStore.readVerifiedStream).toHaveBeenCalledWith(expect.objectContaining({
      objectId: fixture.revision.objectId,
      checksum: fixture.revision.checksum,
      byteCount: fixture.revision.byteCount,
      maxBytes: 1_048_576,
      signal: expect.any(AbortSignal)
    }));
    expect(fixture.model.extract).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevisionPublicId: fixture.revision.publicId,
      attemptPublicId: expect.stringMatching(/^source-model-attempt-[0-9a-f]{64}$/u),
      body: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) })
    }));
    expect(fixture.handoff.apply).toHaveBeenCalledWith(expect.objectContaining({
      operationPublicId: fixture.work.publicId,
      sourceRevisionPublicId: fixture.revision.publicId,
      node: expect.objectContaining({ publicId: "node-source-processing" }),
      edges: []
    }));
    expect(fixture.catalog.updateSourceFileState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "processing", revisionCheck: { expectedRevision: 1 } })
    );
    expect(fixture.catalog.updateSourceFileState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "ready", revisionCheck: { expectedRevision: 2 } })
    );
    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      publicId: fixture.work.publicId,
      owner: "source-worker-one",
      result: expect.objectContaining({
        state: "completed",
        resultCode: "SOURCE_PROCESSING_COMPLETED",
        correlationPublicId: fixture.revision.publicId,
        summary: {
          sourceFilePublicId: fixture.sourceFile.publicId,
          sourceRevisionPublicId: fixture.revision.publicId,
          candidatePublicId: "candidate-source-processing",
          releaseOperationPublicId: "release-source-processing"
        }
      })
    }));
    expect(fixture.persistedBodyWrites).toBe(0);
  });

  it("enqueues the released source lifecycle events without changing processing output", async () => {
    const fixture = createFixture();
    const dispatch = vi.fn(async (_event: Record<string, unknown>) => undefined);
    const worker = createWorker(fixture, undefined, { dispatch });

    await expect(worker.runOnce(runRequest(1))).resolves.toMatchObject({ completed: 1 });

    expect(dispatch.mock.calls.map(([event]) => event.eventType)).toEqual([
      "source_file.accepted",
      "source_file.progress",
      "source_file.completed"
    ]);
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
      eventType: "source_file.completed",
      payload: {
        knowledgeBaseId: fixture.work.knowledgeBaseId,
        sourceFileId: fixture.sourceFile.publicId,
        sourceRevisionId: fixture.revision.publicId
      }
    }));
    expect(fixture.events.record.mock.calls.map(([event]) => ({
      publicId: event.publicId,
      stageKey: event.stageKey,
      sequence: event.sequence,
      severity: event.severity
    }))).toEqual([
      {
        publicId: expect.stringMatching(/^source-event-accepted-/u),
        stageKey: "upload_storage",
        sequence: 10,
        severity: "info"
      },
      {
        publicId: expect.stringMatching(/^source-event-progress-/u),
        stageKey: "metadata_resolution",
        sequence: 20,
        severity: "info"
      },
      {
        publicId: expect.stringMatching(/^source-event-completed-/u),
        stageKey: "generation_activation",
        sequence: 30,
        severity: "info"
      }
    ]);
  });

  it("rejects a claim larger than the configured concurrency before touching durable work", async () => {
    const fixture = createFixture();
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest(3))).rejects.toMatchObject({
      code: "invalid_limit"
    });
    expect(fixture.workflow.claim).not.toHaveBeenCalled();
  });

  it("terminalizes a stale source revision without reading or invoking the model", async () => {
    const fixture = createFixture();
    fixture.currentRevision.publicId = "revision-newer";
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest(1))).resolves.toMatchObject({
      terminal: 1,
      completed: 0
    });
    expect(fixture.bodyStore.readVerifiedStream).not.toHaveBeenCalled();
    expect(fixture.model.extract).not.toHaveBeenCalled();
    expect(fixture.handoff.apply).not.toHaveBeenCalled();
    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        state: "superseded",
        resultCode: "SOURCE_REVISION_SUPERSEDED"
      })
    }));
  });

  it("terminalizes deleted knowledge-base work without creating graph or release state", async () => {
    const fixture = createFixture();
    fixture.knowledgeBase.visibility = "deleted";
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest(1))).resolves.toMatchObject({ terminal: 1 });
    expect(fixture.handoff.apply).not.toHaveBeenCalled();
    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        state: "deleted",
        resultCode: "KNOWLEDGE_BASE_DELETED"
      })
    }));
  });

  it("releases a retryable model timeout with a safe code and stable attempt identity", async () => {
    const fixture = createFixture();
    const onFailure = vi.fn();
    const timeout = Object.assign(new Error("Provider details must not persist"), {
      name: "TimeoutError"
    });
    fixture.model.extract.mockRejectedValueOnce(timeout);
    const worker = createWorker(fixture, onFailure);

    await expect(worker.runOnce(runRequest(1))).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      terminal: 0
    });
    expect(fixture.workflow.releaseForRetry).toHaveBeenCalledWith({
      publicId: fixture.work.publicId,
      owner: "source-worker-one",
      nextAttemptAt: "2026-08-01T00:01:00.000Z",
      reasonCode: "SOURCE_MODEL_TIMEOUT"
    });
    expect(fixture.events.record.mock.calls.map(([event]) => event.stageKey)).toEqual([
      "upload_storage",
      "metadata_resolution"
    ]);
    expect(fixture.workflow.complete).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith({
      operationPublicId: fixture.work.publicId,
      knowledgeBaseId: fixture.work.knowledgeBaseId,
      attempt: fixture.work.attempt,
      code: "SOURCE_MODEL_TIMEOUT",
      error: timeout
    });
  });

  it("stores only a bounded safe failure after retry exhaustion", async () => {
    const fixture = createFixture();
    fixture.work.attempt = 3;
    fixture.model.extract.mockRejectedValueOnce(new Error("private provider payload"));
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest(1))).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 0,
      terminal: 1
    });
    expect(fixture.catalog.updateSourceFileState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "failed",
        safeErrorCode: "SOURCE_MODEL_FAILED",
        safeErrorMessage: null
      })
    );
    expect(fixture.workflow.complete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        state: "failed",
        resultCode: "SOURCE_MODEL_FAILED",
        safeMessage: null,
        summary: expect.not.objectContaining({ error: expect.anything() })
      })
    }));
    expect(fixture.events.record).toHaveBeenLastCalledWith(expect.objectContaining({
      stageKey: "llm_suggestion",
      severity: "error",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:00.000Z"
    }));
  });

  it("closes and retries when a model returns before consuming the verified body", async () => {
    const fixture = createFixture();
    let streamClosed = false;
    fixture.bodyStore.readVerifiedStream.mockResolvedValueOnce({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: fixture.body };
          },
          async return() {
            streamClosed = true;
            return { done: true as const, value: undefined };
          }
        };
      }
    });
    fixture.model.extract.mockResolvedValueOnce(fixture.modelResult);
    const worker = createWorker(fixture);

    await expect(worker.runOnce(runRequest(1))).resolves.toMatchObject({
      retried: 1,
      completed: 0
    });
    expect(streamClosed).toBe(true);
    expect(fixture.handoff.apply).not.toHaveBeenCalled();
    expect(fixture.workflow.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "SOURCE_MODEL_FAILED"
    }));
  });

  it("aborts the active request and releases durable work during role shutdown", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    fixture.model.extract.mockImplementationOnce(async (input: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw input.signal.reason;
    });
    const worker = createWorker(fixture);

    const running = worker.runOnce({ ...runRequest(1), signal: controller.signal });
    await vi.waitFor(() => expect(fixture.model.extract).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Role shutdown", "AbortError"));

    await expect(running).resolves.toMatchObject({ retried: 1, completed: 0 });
    expect(fixture.workflow.releaseForRetry).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "SOURCE_MODEL_TIMEOUT"
    }));
  });
});

function createWorker(
  fixture: ReturnType<typeof createFixture>,
  onFailure?: NonNullable<Parameters<WorkerFactory>[0]["onFailure"]>,
  webhooks?: NonNullable<Parameters<WorkerFactory>[0]["webhooks"]>
): Worker {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext source processing worker is unavailable");
  return factory({
    ...fixture.ports,
    limits: {
      maximumConcurrency: 2,
      maximumSourceBytes: 1_048_576,
      maximumAttempts: 3,
      attemptDeadlineMilliseconds: 30_000,
      retryDelayMilliseconds: 60_000,
      resultRetentionMilliseconds: 86_400_000
    },
    clock: () => "2026-08-01T00:00:00.000Z",
    ...(onFailure ? { onFailure } : {}),
    ...(webhooks ? { webhooks } : {})
  });
}

function createFixture() {
  const body = Buffer.from("# Current source\n", "utf8");
  const revision = {
    publicId: "revision-source-processing",
    sourceFilePublicId: "file-source-processing",
    knowledgeBaseId: "kb-source-processing",
    objectId: `source-sha256:${createHash("sha256").update(body).digest("hex")}`,
    checksum: createHash("sha256").update(body).digest("hex"),
    byteCount: body.byteLength,
    contentType: "text/markdown; charset=utf-8",
    createdAt: "2026-08-01T00:00:00.000Z"
  };
  const currentRevision = { ...revision };
  const sourceFile = {
    publicId: "file-source-processing",
    knowledgeBaseId: "kb-source-processing",
    directoryPublicId: null,
    logicalPath: "Current.md",
    normalizedPath: "current.md",
    title: "Current",
    metadata: {},
    currentRevisionPublicId: revision.publicId,
    status: "pending",
    safeErrorCode: null,
    safeErrorMessage: null,
    revision: 1,
    visibility: "current" as const
  };
  const knowledgeBase = {
    publicId: "kb-source-processing",
    name: "Source processing",
    description: null,
    revision: 1,
    visibility: "current" as "current" | "deleted",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
  const work = {
    publicId: "operation-source-processing",
    knowledgeBaseId: "kb-source-processing",
    kind: "source" as const,
    state: "running" as const,
    operationRevision: 1,
    settingsRevisionPublicId: "settings-source-processing",
    attempt: 1,
    leaseOwner: "source-worker-one",
    leaseExpiresAt: "2026-08-01T00:05:00.000Z",
    nextAttemptAt: null,
    safeErrorCode: null,
    checkpoint: { sourceRevisionPublicId: revision.publicId },
    idempotency: {
      key: "source-processing-revision",
      requestHash: "a".repeat(64),
      expiresAt: "2026-08-02T00:00:00.000Z"
    }
  };
  const workflow = {
    claim: vi.fn(async () => [work]),
    saveCheckpoint: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    releaseForRetry: vi.fn(async () => undefined)
  };
  const catalog = {
    getKnowledgeBase: vi.fn(async () => knowledgeBase),
    getSourceFile: vi.fn(async () => sourceFile),
    getSourceRevision: vi.fn(async () => revision),
    getCurrentSourceRevision: vi.fn(async () => currentRevision),
    updateSourceFileState: vi.fn(async (input: { status: string }) => {
      sourceFile.status = input.status;
      sourceFile.revision += 1;
      return { ...sourceFile };
    })
  };
  let persistedBodyWrites = 0;
  const bodyStore = {
    readVerifiedStream: vi.fn<() => Promise<AsyncIterable<Uint8Array>>>(
      async () => chunks(body)
    )
  };
  const modelResult = {
    metadata: { headingCount: 1 },
    node: {
      publicId: "node-source-processing",
      knowledgeBaseId: "kb-source-processing",
      sourceFilePublicId: "file-source-processing",
      sourceRevisionPublicId: revision.publicId,
      logicalPath: "Current.md",
      label: "Current",
      kind: "document",
      metadata: {},
      evidence: [],
      revision: 1
    },
    edges: []
  };
  const model = {
    extract: vi.fn(async (input: {
      body: AsyncIterable<Uint8Array>;
      signal: AbortSignal;
    }) => {
      const received: Uint8Array[] = [];
      for await (const chunk of input.body) received.push(chunk);
      expect(Buffer.concat(received.map((chunk) => Buffer.from(chunk)))).toEqual(body);
      return modelResult;
    })
  };
  const handoff = {
    apply: vi.fn(async () => ({
      outcome: "candidate" as const,
      candidatePublicId: "candidate-source-processing",
      releaseOperationPublicId: "release-source-processing"
    }))
  };
  const events = {
    record: vi.fn(async (_event: StorageVnextSourceEventSummary) => undefined)
  };
  return {
    body,
    revision,
    currentRevision,
    sourceFile,
    knowledgeBase,
    work,
    workflow,
    catalog,
    bodyStore,
    model,
    modelResult,
    handoff,
    get persistedBodyWrites() {
      return persistedBodyWrites;
    },
    events,
    ports: { workflow, catalog, bodyStore, model, handoff, events }
  };
}

function runRequest(limit: number) {
  return {
    owner: "source-worker-one",
    limit,
    leaseExpiresAt: "2026-08-01T00:05:00.000Z"
  };
}

async function* chunks(body: Uint8Array): AsyncGenerator<Uint8Array> {
  yield body.slice(0, 5);
  yield body.slice(5);
}
