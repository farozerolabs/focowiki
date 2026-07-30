import { gzipSync } from "node:zlib";
import type {
  SearchEngineDocument,
  SearchEngineTransport
} from "../application/ports/search-engine-transport.js";
import type {
  SearchProjectionStateRepository,
  SearchProjectionWork
} from "../application/ports/search-projection-state-repository.js";

export type SearchIndexingWorkOutcome =
  | "submitted"
  | "processing"
  | "succeeded"
  | "retry"
  | "failed"
  | "lost";

export type SearchIndexingFailureEvent = {
  workId: string;
  knowledgeBaseId: string;
  generationId: string | null;
  epoch: number;
  indexKind: SearchProjectionWork["indexKind"];
  workKind: SearchProjectionWork["workKind"];
  attemptNumber: number;
  maxAttempts: number;
  code: string;
  message: string;
  outcome: "retry" | "failed" | "lost";
};

export type SearchIndexingLifecycle = {
  prepareIndex?: (work: SearchProjectionWork) => Promise<void>;
  deleteDocuments?: (work: SearchProjectionWork) => Promise<void>;
  validateIndex?: (work: SearchProjectionWork) => Promise<void>;
  activateIndex?: (
    work: SearchProjectionWork
  ) => Promise<void | { taskUid: number }>;
  cleanupIndex?: (work: SearchProjectionWork) => Promise<void>;
  completeSubmittedTask?: (work: SearchProjectionWork) => Promise<void>;
};

export async function processSearchIndexingWork(input: {
  work: SearchProjectionWork;
  repository: SearchProjectionStateRepository;
  transport: SearchEngineTransport;
  resolveIndexUid: (work: SearchProjectionWork) => string;
  loadDocuments: (
    work: SearchProjectionWork
  ) => Promise<SearchEngineDocument[]>;
  lifecycle?: SearchIndexingLifecycle;
  now?: () => Date;
  leaseDurationMs: number;
  retryDelayMs: number;
  maxDocumentCount?: number;
  maxCompressedBytes?: number;
  onFailure?: (
    event: SearchIndexingFailureEvent,
    error?: unknown
  ) => void;
}): Promise<SearchIndexingWorkOutcome> {
  if (input.work.state === "submitted") {
    return pollSubmittedWork(input);
  }
  if (input.work.state !== "queued" && input.work.state !== "retry") {
    return "lost";
  }
  if (input.work.workKind !== "documents") {
    return processLifecycleWork(input);
  }

  try {
    const indexUid = input.resolveIndexUid(input.work);
    const recovered = await input.transport.findTaskByCorrelation?.({
      indexUid,
      correlation: input.work.taskCorrelation
    });
    if (recovered) {
      return persistSubmitted(input, recovered.taskUid);
    }
    const documents = await input.loadDocuments(input.work);
    if (documents.length !== input.work.documentCount) {
      return persistRetry(input, {
        code: "SEARCH_INDEX_BATCH_STALE",
        message: "Search indexing batch must be planned again"
      });
    }
    assertBoundedDocuments({
      documents,
      maxDocumentCount: input.maxDocumentCount ?? 2_000,
      maxCompressedBytes: input.maxCompressedBytes ?? 16 * 1_024 * 1_024
    });
    const task = await input.transport.addDocuments({
      indexUid,
      primaryKey: "id",
      documents,
      correlation: input.work.taskCorrelation
    });
    return persistSubmitted(input, task.taskUid);
  } catch (error) {
    return persistRetry(input, classifyFailure(error), error);
  }
}

async function persistSubmitted(
  input: {
    work: SearchProjectionWork;
    repository: SearchProjectionStateRepository;
    now?: () => Date;
    leaseDurationMs: number;
  },
  taskUid: number
): Promise<"submitted" | "lost"> {
  const submittedAt = now(input.now);
  const persisted = await input.repository.markSubmitted({
    work: input.work,
    taskUid,
    submittedAt,
    leaseExpiresAt: new Date(
      Date.parse(submittedAt) + input.leaseDurationMs
    ).toISOString()
  });
  return persisted ? "submitted" : "lost";
}

async function processLifecycleWork(input: {
  work: SearchProjectionWork;
  repository: SearchProjectionStateRepository;
  lifecycle?: SearchIndexingLifecycle;
  now?: () => Date;
  leaseDurationMs: number;
  retryDelayMs: number;
}): Promise<SearchIndexingWorkOutcome> {
  const handler = input.work.workKind === "prepare_index"
    ? input.lifecycle?.prepareIndex
    : input.work.workKind === "delete_documents"
      ? input.lifecycle?.deleteDocuments
      : input.work.workKind === "validate"
        ? input.lifecycle?.validateIndex
        : input.work.workKind === "activate"
          ? input.lifecycle?.activateIndex
          : input.lifecycle?.cleanupIndex;
  if (!handler) {
    return persistRetry(input, {
      code: "SEARCH_INDEX_WORK_UNSUPPORTED",
      message: "Search indexing work cannot be processed"
    });
  }
  try {
    const task = await handler(input.work);
    if (task) {
      const submittedAt = now(input.now);
      const persisted = await input.repository.markSubmitted({
        work: input.work,
        taskUid: task.taskUid,
        submittedAt,
        leaseExpiresAt: new Date(
          Date.parse(submittedAt) + input.leaseDurationMs
        ).toISOString()
      });
      return persisted ? "submitted" : "lost";
    }
    const completedAt = now(input.now);
    const persisted = await input.repository.markSucceeded({
      work: input.work,
      completedAt
    });
    return persisted ? "succeeded" : "lost";
  } catch (error) {
    return persistRetry(input, classifyFailure(error), error);
  }
}

async function pollSubmittedWork(input: {
  work: SearchProjectionWork;
  repository: SearchProjectionStateRepository;
  transport: SearchEngineTransport;
  lifecycle?: SearchIndexingLifecycle;
  now?: () => Date;
  retryDelayMs: number;
}): Promise<SearchIndexingWorkOutcome> {
  if (input.work.taskUid === null) {
    return persistRetry(input, {
      code: "SEARCH_INDEX_TASK_MISSING",
      message: "Search indexing task state is incomplete"
    });
  }
  try {
    const task = await input.transport.getTask(input.work.taskUid);
    if (task.status === "succeeded") {
      await input.lifecycle?.completeSubmittedTask?.(input.work);
      const persisted = await input.repository.markSucceeded({
        work: input.work,
        completedAt: now(input.now)
      });
      return persisted ? "succeeded" : "lost";
    }
    if (task.status === "enqueued" || task.status === "processing") {
      return "processing";
    }
    return persistRetry(input, {
      code: task.errorCode
        ?? (task.status === "canceled"
          ? "SEARCH_INDEX_TASK_CANCELED"
          : task.status === "unknown"
            ? "SEARCH_INDEX_TASK_UNKNOWN"
            : "SEARCH_INDEX_TASK_FAILED"),
      message: "Search indexing task did not complete"
    });
  } catch (error) {
    return persistRetry(input, classifyFailure(error), error);
  }
}

async function persistRetry(
  input: {
    work: SearchProjectionWork;
    repository: SearchProjectionStateRepository;
    now?: () => Date;
    retryDelayMs: number;
    onFailure?: (
      event: SearchIndexingFailureEvent,
      error?: unknown
    ) => void;
  },
  failure: { code: string; message: string },
  error?: unknown
): Promise<"retry" | "failed" | "lost"> {
  const failedAt = now(input.now);
  const outcome = await input.repository.retryOrFail({
    work: input.work,
    code: failure.code,
    message: failure.message,
    retryAt: new Date(
      Date.parse(failedAt) + input.retryDelayMs
    ).toISOString(),
    failedAt
  });
  input.onFailure?.({
    workId: input.work.id,
    knowledgeBaseId: input.work.knowledgeBaseId,
    generationId: input.work.generationId,
    epoch: input.work.epoch,
    indexKind: input.work.indexKind,
    workKind: input.work.workKind,
    attemptNumber: input.work.attemptCount + 1,
    maxAttempts: input.work.maxAttempts,
    code: failure.code,
    message: failure.message,
    outcome
  }, error);
  return outcome;
}

function assertBoundedDocuments(input: {
  documents: SearchEngineDocument[];
  maxDocumentCount: number;
  maxCompressedBytes: number;
}): void {
  if (
    input.documents.length === 0
    || input.documents.length > input.maxDocumentCount
  ) {
    throw new Error("Search document batch is outside the configured count limit");
  }
  const compressedBytes = gzipSync(
    Buffer.from(JSON.stringify(input.documents), "utf8")
  ).byteLength;
  if (compressedBytes > input.maxCompressedBytes) {
    throw new Error("Search document batch exceeds the configured byte limit");
  }
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
} {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return {
      code: error.code.slice(0, 120),
      message: "Search indexing is temporarily unavailable"
    };
  }
  return {
    code: "SEARCH_INDEXING_FAILED",
    message: error instanceof Error
      ? safeMessage(error.message)
      : "Search indexing could not be completed"
  };
}

function safeMessage(value: string): string {
  if (
    value === "Search document batch is outside the configured count limit"
    || value === "Search document batch exceeds the configured byte limit"
  ) {
    return value;
  }
  return "Search indexing could not be completed";
}

function now(clock: (() => Date) | undefined): string {
  return (clock?.() ?? new Date()).toISOString();
}
