import { randomUUID } from "node:crypto";
import type {
  SearchEngineSettings,
  SearchEngineTask,
  SearchEngineTransport
} from "../../application/ports/search-engine-transport.js";
import type { StorageVnextSearchProjectionPort } from "./ports.js";
import type {
  StorageVnextSearchProjectionRecord,
  StorageVnextSearchProjectionRepository
} from "./projection-repository.js";
import {
  createStorageVnextSearchIndexUid,
  createStorageVnextSearchSettingsChecksum,
  createStorageVnextSearchTaskCorrelation
} from "./candidate-identity.js";

export { createStorageVnextSearchSettingsChecksum } from "./candidate-identity.js";

export type StorageVnextSearchCandidateLifecycleErrorCode =
  | "invalid_configuration"
  | "invalid_input"
  | "provider_index_conflict"
  | "provider_task_failed"
  | "provider_task_timeout"
  | "settings_mismatch"
  | "task_correlation_unavailable";

export class StorageVnextSearchCandidateLifecycleError extends Error {
  public constructor(
    public readonly code: StorageVnextSearchCandidateLifecycleErrorCode
  ) {
    super(`Storage vNext search candidate lifecycle error: ${code}`);
    this.name = "StorageVnextSearchCandidateLifecycleError";
  }
}

type LifecycleConfig = {
  repository: StorageVnextSearchProjectionRepository;
  transport: SearchEngineTransport;
  settings: SearchEngineSettings;
  indexUidPrefix: string;
  maxPollAttempts: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createStorageVnextSearchCandidateLifecycle(
  config: LifecycleConfig
): Pick<StorageVnextSearchProjectionPort, "prepareCandidate" | "writeDocumentBatch"> {
  assertConfig(config);
  const sleep = config.sleep ?? wait;
  const appliedSettingsChecksum = createStorageVnextSearchSettingsChecksum(
    config.settings
  );

  return {
    async prepareCandidate(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.candidatePublicId);
      assertChecksum(input.schemaChecksum);
      assertChecksum(input.settingsChecksum);
      if (input.settingsChecksum !== appliedSettingsChecksum) {
        throw lifecycleError("settings_mismatch");
      }
      const providerIndexUid = createStorageVnextSearchIndexUid({
        indexUidPrefix: config.indexUidPrefix,
        knowledgeBaseId: input.knowledgeBaseId,
        candidatePublicId: input.candidatePublicId,
        incarnationPublicId: randomUUID()
      });
      const reservation = await config.repository.reserveCandidate({
        publicId: input.candidatePublicId,
        knowledgeBaseId: input.knowledgeBaseId,
        providerIndexUid,
        schemaChecksum: input.schemaChecksum,
        settingsChecksum: input.settingsChecksum
      });
      if (reservation.projection.state === "failed") {
        throw lifecycleError("provider_task_failed");
      }
      await ensureIndex(reservation.projection);
      await ensureSettings(input.candidatePublicId, input.settingsChecksum);
      const candidate = await requireCandidate(input.candidatePublicId);
      if (candidate.state === "preparing") {
        await config.repository.markCandidateIndexing(input.candidatePublicId);
      }
    },

    async writeDocumentBatch(input) {
      assertBatch(input);
      const candidate = await requireCandidate(input.candidatePublicId);
      if (candidate.state !== "indexing") throw lifecycleError("invalid_input");
      await assertProviderIndex(candidate.providerIndexUid);
      const correlationPublicId = createStorageVnextSearchTaskCorrelation({
        taskKind: "documents",
        candidatePublicId: input.candidatePublicId,
        operationPublicId: input.operationPublicId,
        batchOrdinal: input.batchOrdinal,
        payloadChecksum: input.payloadChecksum
      });
      const continuation = await config.repository.beginDocumentBatch({
        candidatePublicId: input.candidatePublicId,
        batchOrdinal: input.batchOrdinal,
        payloadChecksum: input.payloadChecksum,
        correlationPublicId
      });
      if (continuation.outcome === "completed") return;
      let taskUid = continuation.providerTaskUid;
      if (taskUid === null) {
        const findTask = config.transport.findTaskByCorrelation;
        if (!findTask) throw lifecycleError("task_correlation_unavailable");
        const recovered = await findTask({
          indexUid: candidate.providerIndexUid,
          correlation: correlationPublicId
        });
        taskUid = recovered?.taskUid ?? null;
        if (taskUid === null) {
          taskUid = (await config.transport.addDocuments({
            indexUid: candidate.providerIndexUid,
            primaryKey: "id",
            documents: [...input.documents],
            correlation: correlationPublicId
          })).taskUid;
        }
        await config.repository.recordProviderTask({
          candidatePublicId: input.candidatePublicId,
          correlationPublicId,
          providerTaskUid: taskUid
        });
      }
      await pollTask(taskUid);
      await config.repository.completeDocumentBatch({
        candidatePublicId: input.candidatePublicId,
        batchOrdinal: input.batchOrdinal,
        payloadChecksum: input.payloadChecksum,
        correlationPublicId,
        documentCount: input.documents.length
      });
    }
  };

  async function ensureIndex(candidate: StorageVnextSearchProjectionRecord) {
    const correlationPublicId = createStorageVnextSearchTaskCorrelation({
      taskKind: "create",
      candidatePublicId: candidate.publicId
    });
    const provider = await config.transport.getIndex({
      indexUid: candidate.providerIndexUid
    });
    if (provider) {
      assertPrimaryKey(provider.primaryKey);
      if (candidate.correlationPublicId === correlationPublicId) {
        await config.repository.completeProviderTask({
          candidatePublicId: candidate.publicId,
          correlationPublicId
        });
      }
      return;
    }
    const continuation = await config.repository.beginProviderTask({
      candidatePublicId: candidate.publicId,
      correlationPublicId
    });
    let taskUid = continuation.providerTaskUid;
    if (taskUid === null) {
      const recovered = await config.transport.getIndex({
        indexUid: candidate.providerIndexUid
      });
      if (recovered) {
        assertPrimaryKey(recovered.primaryKey);
        await config.repository.completeProviderTask({
          candidatePublicId: candidate.publicId,
          correlationPublicId
        });
        return;
      }
      taskUid = (await config.transport.createIndex({
        indexUid: candidate.providerIndexUid,
        primaryKey: "id"
      })).taskUid;
      await config.repository.recordProviderTask({
        candidatePublicId: candidate.publicId,
        correlationPublicId,
        providerTaskUid: taskUid
      });
    }
    await pollTask(taskUid);
    await assertProviderIndex(candidate.providerIndexUid);
    await config.repository.completeProviderTask({
      candidatePublicId: candidate.publicId,
      correlationPublicId
    });
  }

  async function ensureSettings(candidatePublicId: string, expectedChecksum: string) {
    const candidate = await requireCandidate(candidatePublicId);
    const correlationPublicId = createStorageVnextSearchTaskCorrelation({
      taskKind: "settings",
      candidatePublicId,
      settingsChecksum: expectedChecksum
    });
    const current = await config.transport.getSettings(candidate.providerIndexUid);
    if (createStorageVnextSearchSettingsChecksum(current) === expectedChecksum) {
      if (candidate.correlationPublicId === correlationPublicId) {
        await config.repository.completeProviderTask({
          candidatePublicId,
          correlationPublicId
        });
      }
      return;
    }
    if (candidate.state !== "preparing") throw lifecycleError("settings_mismatch");
    const continuation = await config.repository.beginProviderTask({
      candidatePublicId,
      correlationPublicId
    });
    let taskUid = continuation.providerTaskUid;
    if (taskUid === null) {
      taskUid = (await config.transport.updateSettings({
        indexUid: candidate.providerIndexUid,
        settings: config.settings
      })).taskUid;
      await config.repository.recordProviderTask({
        candidatePublicId,
        correlationPublicId,
        providerTaskUid: taskUid
      });
    }
    await pollTask(taskUid);
    const applied = await config.transport.getSettings(candidate.providerIndexUid);
    if (createStorageVnextSearchSettingsChecksum(applied) !== expectedChecksum) {
      throw lifecycleError("settings_mismatch");
    }
    await config.repository.completeProviderTask({
      candidatePublicId,
      correlationPublicId
    });
  }

  async function pollTask(taskUid: number) {
    for (let attempt = 1; attempt <= config.maxPollAttempts; attempt += 1) {
      const task = await config.transport.getTask(taskUid);
      if (task.status === "succeeded") return;
      if (isTerminalFailure(task)) throw lifecycleError("provider_task_failed");
      if (attempt < config.maxPollAttempts) await sleep(config.pollIntervalMs);
    }
    throw lifecycleError("provider_task_timeout");
  }

  async function assertProviderIndex(indexUid: string) {
    const provider = await config.transport.getIndex({ indexUid });
    if (!provider) throw lifecycleError("provider_index_conflict");
    assertPrimaryKey(provider.primaryKey);
  }

  async function requireCandidate(candidatePublicId: string) {
    const candidate = await config.repository.getCandidate(candidatePublicId);
    if (!candidate) throw lifecycleError("invalid_input");
    return candidate;
  }
}

function assertConfig(config: LifecycleConfig) {
  if (
    !Number.isSafeInteger(config.maxPollAttempts) || config.maxPollAttempts < 1
    || !Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs < 0
    || !/^[A-Za-z0-9_-]+$/u.test(config.indexUidPrefix)
    || config.indexUidPrefix.length > 80
  ) throw lifecycleError("invalid_configuration");
}

function assertBatch(input: {
  candidatePublicId: string; operationPublicId: string; batchOrdinal: number;
  payloadChecksum: string; compressedBytes: number; documents: readonly unknown[];
}) {
  if (
    !Number.isSafeInteger(input.batchOrdinal) || input.batchOrdinal < 0
    || !Number.isSafeInteger(input.compressedBytes) || input.compressedBytes < 0
    || input.documents.length === 0
  ) throw lifecycleError("invalid_input");
  assertId(input.candidatePublicId);
  assertId(input.operationPublicId);
  assertChecksum(input.payloadChecksum);
}

function assertChecksum(value: string) {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw lifecycleError("invalid_input");
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) throw lifecycleError("invalid_input");
}

function assertPrimaryKey(primaryKey: string | null) {
  if (primaryKey !== "id") throw lifecycleError("provider_index_conflict");
}

function isTerminalFailure(task: SearchEngineTask) {
  return task.status === "failed" || task.status === "canceled" || task.status === "unknown";
}

function lifecycleError(code: StorageVnextSearchCandidateLifecycleErrorCode) {
  return new StorageVnextSearchCandidateLifecycleError(code);
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
