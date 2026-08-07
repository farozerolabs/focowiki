import { randomUUID } from "node:crypto";
import type {
  SearchProviderIndexDefinition,
  SearchProviderOperationReceipt,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
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
  provider: SearchProviderRuntime;
  settings: SearchProviderIndexDefinition;
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
        providerKind: config.provider.kind,
        providerIndexUid,
        schemaChecksum: input.schemaChecksum,
        settingsChecksum: input.settingsChecksum
      });
      if (reservation.projection.state === "failed") {
        throw lifecycleError("provider_task_failed");
      }
      assertProviderOwnership(reservation.projection);
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
      assertProviderOwnership(candidate);
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
      let receipt: SearchProviderOperationReceipt | null = null;
      if (continuation.providerOperationRef) {
        receipt = {
          state: "pending",
          operationRef: continuation.providerOperationRef
        };
      } else {
        receipt = await config.provider.operations.findOperationByCorrelation({
          indexUid: candidate.providerIndexUid,
          correlation: correlationPublicId
        });
        if (!receipt) {
          receipt = await config.provider.write.writeDocuments({
            indexUid: candidate.providerIndexUid,
            documents: [...input.documents],
            correlation: correlationPublicId
          });
        }
      }
      if (receipt.state === "pending") {
        await config.repository.recordProviderOperation({
          candidatePublicId: input.candidatePublicId,
          correlationPublicId,
          providerOperationRef: receipt.operationRef
        });
      }
      await pollOperation(receipt);
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
    assertProviderOwnership(candidate);
    const provider = await config.provider.admin.getIndex({
      indexUid: candidate.providerIndexUid
    });
    if (provider) {
      assertPrimaryKey(provider.primaryKey);
      if (candidate.correlationPublicId === correlationPublicId) {
        await config.repository.completeProviderOperation({
          candidatePublicId: candidate.publicId,
          correlationPublicId
        });
      }
      return;
    }
    const continuation = await config.repository.beginProviderOperation({
      candidatePublicId: candidate.publicId,
      correlationPublicId
    });
    let receipt: SearchProviderOperationReceipt;
    if (continuation.providerOperationRef) {
      receipt = {
        state: "pending",
        operationRef: continuation.providerOperationRef
      };
    } else {
      const recovered = await config.provider.admin.getIndex({
        indexUid: candidate.providerIndexUid
      });
      if (recovered) {
        assertPrimaryKey(recovered.primaryKey);
        await config.repository.completeProviderOperation({
          candidatePublicId: candidate.publicId,
          correlationPublicId
        });
        return;
      }
      receipt = await config.provider.admin.createIndex({
        indexUid: candidate.providerIndexUid,
        definition: config.settings
      });
      if (receipt.state === "pending") {
        await config.repository.recordProviderOperation({
          candidatePublicId: candidate.publicId,
          correlationPublicId,
          providerOperationRef: receipt.operationRef
        });
      }
    }
    await pollOperation(receipt);
    await assertProviderIndex(candidate.providerIndexUid);
    await config.repository.completeProviderOperation({
      candidatePublicId: candidate.publicId,
      correlationPublicId
    });
  }

  async function ensureSettings(candidatePublicId: string, expectedChecksum: string) {
    const candidate = await requireCandidate(candidatePublicId);
    assertProviderOwnership(candidate);
    const correlationPublicId = createStorageVnextSearchTaskCorrelation({
      taskKind: "settings",
      candidatePublicId,
      settingsChecksum: expectedChecksum
    });
    const current = await config.provider.admin.getIndexDefinition({
      indexUid: candidate.providerIndexUid
    });
    if (
      current
      && createStorageVnextSearchSettingsChecksum(current) === expectedChecksum
    ) {
      if (candidate.correlationPublicId === correlationPublicId) {
        await config.repository.completeProviderOperation({
          candidatePublicId,
          correlationPublicId
        });
      }
      return;
    }
    if (candidate.state !== "preparing") throw lifecycleError("settings_mismatch");
    const continuation = await config.repository.beginProviderOperation({
      candidatePublicId,
      correlationPublicId
    });
    let receipt: SearchProviderOperationReceipt;
    if (continuation.providerOperationRef) {
      receipt = {
        state: "pending",
        operationRef: continuation.providerOperationRef
      };
    } else {
      receipt = await config.provider.admin.updateIndexDefinition({
        indexUid: candidate.providerIndexUid,
        definition: config.settings
      });
      if (receipt.state === "pending") {
        await config.repository.recordProviderOperation({
          candidatePublicId,
          correlationPublicId,
          providerOperationRef: receipt.operationRef
        });
      }
    }
    await pollOperation(receipt);
    const applied = await config.provider.admin.getIndexDefinition({
      indexUid: candidate.providerIndexUid
    });
    if (
      !applied
      || createStorageVnextSearchSettingsChecksum(applied) !== expectedChecksum
    ) {
      throw lifecycleError("settings_mismatch");
    }
    await config.repository.completeProviderOperation({
      candidatePublicId,
      correlationPublicId
    });
  }

  async function pollOperation(receipt: SearchProviderOperationReceipt) {
    if (receipt.state === "completed") return;
    for (let attempt = 1; attempt <= config.maxPollAttempts; attempt += 1) {
      const operation = await config.provider.operations.getOperation({
        operationRef: receipt.operationRef
      });
      if (operation.state === "completed") return;
      if (operation.state === "failed") throw lifecycleError("provider_task_failed");
      if (attempt < config.maxPollAttempts) await sleep(config.pollIntervalMs);
    }
    throw lifecycleError("provider_task_timeout");
  }

  async function assertProviderIndex(indexUid: string) {
    const provider = await config.provider.admin.getIndex({ indexUid });
    if (!provider) throw lifecycleError("provider_index_conflict");
    assertPrimaryKey(provider.primaryKey);
  }

  async function requireCandidate(candidatePublicId: string) {
    const candidate = await config.repository.getCandidate(candidatePublicId);
    if (!candidate) throw lifecycleError("invalid_input");
    return candidate;
  }

  function assertProviderOwnership(candidate: StorageVnextSearchProjectionRecord) {
    if (candidate.providerKind !== config.provider.kind) {
      throw lifecycleError("provider_index_conflict");
    }
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

function lifecycleError(code: StorageVnextSearchCandidateLifecycleErrorCode) {
  return new StorageVnextSearchCandidateLifecycleError(code);
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
