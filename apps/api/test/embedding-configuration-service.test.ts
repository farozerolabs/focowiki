import { describe, expect, it, vi } from "vitest";
import type {
  EmbeddingConfigurationPrivate
} from "../src/semantic/embedding/configuration.js";
import type {
  EmbeddingConfigurationRepository,
  EmbeddingRevisionWrite
} from "../src/semantic/embedding/repository.js";
import {
  EmbeddingConfigurationServiceError,
  createEmbeddingConfigurationService
} from "../src/semantic/embedding/service.js";
import { EmbeddingTransportError } from
  "../src/semantic/embedding/openai-compatible-transport.js";

describe("embedding configuration application service", () => {
  it("encrypts creates, preserves omitted update keys, validates, and activates revisions", async () => {
    const repository = createMemoryRepository();
    const transport = { embed: vi.fn(async (request) => {
      expect(request.apiKey).toBe("embedding-secret");
      return {
        modelName: request.modelName,
        dimension: 3,
        vectors: [[1, 0, 0]],
        inputTokens: 3,
        totalTokens: 3
      };
    }) };
    const events: unknown[] = [];
    const service = createEmbeddingConfigurationService({
      repository,
      transport,
      audit: { append: async (event) => { events.push(event); } },
      deploymentSecret: "deployment-secret",
      createPublicId: idSequence("config", "revision-1", "revision-2"),
      now: () => "2026-08-08T00:00:00.000Z"
    });

    const created = await service.create(draft(), "admin-a");
    expect(created).toMatchObject({
      publicId: "embedding-config-config",
      revisionPublicId: "embedding-revision-revision-1",
      revision: 1,
      apiKeyConfigured: true,
      validationStatus: "not_tested",
      lifecycleStatus: "draft"
    });
    expect(JSON.stringify(created)).not.toContain("embedding-secret");
    expect(repository.values[0]?.encryptedApiKey).not.toContain("embedding-secret");

    const updated = await service.update(created.publicId, created.revision, {
      ...draft(),
      displayName: "Updated embedding",
      apiKey: null
    }, "admin-a");
    expect(updated).toMatchObject({
      revisionPublicId: "embedding-revision-revision-2",
      revision: 2,
      displayName: "Updated embedding",
      apiKeyConfigured: true
    });
    await expect(service.test(created.publicId, "admin-a"))
      .resolves.toMatchObject({ validationStatus: "valid", resolvedDimension: 3 });
    await expect(service.activate(created.publicId, 2, "admin-a"))
      .resolves.toMatchObject({ lifecycleStatus: "active", revision: 3 });
    await expect(service.delete(created.publicId, 3, "admin-a"))
      .rejects.toMatchObject({ code: "configuration_in_use" });

    const serialized = JSON.stringify({ events, values: await service.list() });
    expect(serialized).not.toContain("embedding-secret");
    expect(serialized).not.toContain("encryptedApiKey");
  });

  it("records safe validation failures without provider payloads", async () => {
    const repository = createMemoryRepository();
    const service = createEmbeddingConfigurationService({
      repository,
      transport: {
        embed: vi.fn(async () => {
          throw new EmbeddingTransportError("authentication_failed", false);
        })
      },
      audit: { append: vi.fn(async () => undefined) },
      deploymentSecret: "deployment-secret",
      createPublicId: idSequence("failed", "failed-revision"),
      now: () => "2026-08-08T00:00:00.000Z"
    });
    const created = await service.create(draft(), null);
    await expect(service.test(created.publicId, null)).rejects.toMatchObject({
      name: EmbeddingConfigurationServiceError.name,
      code: "authentication_failed"
    });
    await expect(service.get(created.publicId)).resolves.toMatchObject({
      validationStatus: "invalid",
      safeValidationErrorCode: "authentication_failed",
      resolvedDimension: null
    });
  });

  it("adopts a threshold-only query-policy revision without another model call", async () => {
    const repository = createMemoryRepository();
    const transport = { embed: vi.fn(async () => ({
      modelName: "embedding-model",
      dimension: 3,
      vectors: [[1, 0, 0]],
      inputTokens: 3,
      totalTokens: 3
    })) };
    const service = createEmbeddingConfigurationService({
      repository,
      transport,
      audit: { append: vi.fn(async () => undefined) },
      deploymentSecret: "deployment-secret",
      createPublicId: idSequence("config", "revision-1", "revision-2"),
      now: () => "2026-08-08T00:00:00.000Z"
    });

    const created = await service.create(draft(), null);
    const tested = await service.test(created.publicId, null);
    const updated = await service.update(created.publicId, tested.revision, {
      ...draft(),
      apiKey: null,
      minimumVectorRelevance: 0.42
    }, null);

    expect(transport.embed).toHaveBeenCalledTimes(1);
    expect(updated).toMatchObject({
      revisionPublicId: "embedding-revision-revision-2",
      queryPolicyRevisionPublicId: "embedding-revision-revision-2",
      vectorProducingRevisionPublicId: "embedding-revision-revision-1",
      minimumVectorRelevance: 0.42,
      validationStatus: "valid",
      resolvedDimension: 3
    });
  });

  it("guards pause and delete while referenced and supports pause-resume-delete lifecycle", async () => {
    const repository = createMemoryRepository();
    const service = createEmbeddingConfigurationService({
      repository,
      transport: { embed: vi.fn() },
      audit: { append: vi.fn(async () => undefined) },
      deploymentSecret: "deployment-secret",
      createPublicId: idSequence("lifecycle", "lifecycle-revision"),
      now: () => "2026-08-08T00:00:00.000Z"
    });
    const created = await service.create(draft(), null);
    repository.references = 1;
    await expect(service.pause(created.publicId, 1, null))
      .rejects.toMatchObject({ code: "configuration_in_use" });
    await expect(service.delete(created.publicId, 1, null))
      .rejects.toMatchObject({ code: "configuration_in_use" });
    repository.references = 0;
    await expect(service.pause(created.publicId, 1, null))
      .resolves.toMatchObject({ lifecycleStatus: "paused", revision: 2 });
    await expect(service.resume(created.publicId, 2, null))
      .resolves.toMatchObject({ lifecycleStatus: "draft", revision: 3 });
    await expect(service.delete(created.publicId, 3, null)).resolves.toBe(true);
    await expect(service.get(created.publicId)).resolves.toBeNull();
  });

  it("reports a missing configuration before pause or resume revision checks", async () => {
    const service = createEmbeddingConfigurationService({
      repository: createMemoryRepository(),
      transport: { embed: vi.fn() },
      audit: { append: vi.fn(async () => undefined) },
      deploymentSecret: "deployment-secret"
    });

    await expect(service.pause("embedding-config-missing", 1, null))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(service.resume("embedding-config-missing", 1, null))
      .rejects.toMatchObject({ code: "not_found" });
  });
});

function draft() {
  return {
    displayName: "Primary embedding",
    authenticationMode: "api_key" as const,
    baseUrl: "https://embedding.example/v1",
    apiKey: "embedding-secret",
    modelName: "embedding-model",
    requestedDimension: 3,
    normalization: "l2" as const,
    maximumInputTokens: 8_192,
    batchSize: 32,
    timeoutMs: 10_000,
    retryCount: 2,
    minimumIntervalMs: 20,
    concurrency: 4,
    maximumResponseBytes: 8_388_608,
    minimumVectorRelevance: 0.7
  };
}

function idSequence(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

function createMemoryRepository(): EmbeddingConfigurationRepository & {
  values: EmbeddingConfigurationPrivate[];
  references: number;
} {
  const values: EmbeddingConfigurationPrivate[] = [];
  const repository: EmbeddingConfigurationRepository & {
    values: EmbeddingConfigurationPrivate[];
    references: number;
  } = {
    values,
    references: 0,
    async create(input: EmbeddingRevisionWrite & {
      configurationPublicId: string;
      revisionPublicId: string;
      createdAt: string;
    }) {
      const value = fromWrite(input, 1);
      values.push(value);
      return structuredClone(value);
    },
    async createRevision(input: EmbeddingRevisionWrite & {
      configurationPublicId: string;
      revisionPublicId: string;
      createdAt: string;
      expectedConfigurationRevision: number;
      reuseValidationFromRevisionPublicId: string | null;
    }) {
      const index = values.findIndex((value) => value.publicId === input.configurationPublicId);
      if (index < 0) throw new Error("missing");
      const prior = values[index]!;
      const value = fromWrite(input, input.expectedConfigurationRevision + 1);
      if (input.reuseValidationFromRevisionPublicId) {
        Object.assign(value, {
          validationStatus: prior.validationStatus,
          resolvedDimension: prior.resolvedDimension,
          validationFingerprintSha256: prior.validationFingerprintSha256,
          safeValidationErrorCode: prior.safeValidationErrorCode
        });
      }
      values[index] = value;
      return structuredClone(value);
    },
    async get(publicId: string) {
      const value = values.find((item) => item.publicId === publicId);
      return value ? structuredClone(value) : null;
    },
    async getRevision(revisionPublicId: string) {
      const value = values.find((item) => item.revisionPublicId === revisionPublicId);
      return value ? structuredClone(value) : null;
    },
    async list() {
      return structuredClone(values);
    },
    async recordValidation(input: {
      configurationPublicId: string;
      revisionPublicId: string;
      status: "valid" | "invalid";
      resolvedDimension: number | null;
      validationFingerprintSha256: string | null;
      safeValidationErrorCode: string | null;
    }) {
      const value = values.find((item) => item.publicId === input.configurationPublicId)!;
      Object.assign(value, {
        validationStatus: input.status,
        resolvedDimension: input.resolvedDimension,
        validationFingerprintSha256: input.validationFingerprintSha256,
        safeValidationErrorCode: input.safeValidationErrorCode
      });
      return structuredClone(value);
    },
    async setLifecycle(input: {
      configurationPublicId: string;
      status: "active" | "draft" | "paused";
      expectedConfigurationRevision: number;
    }) {
      const value = values.find((item) => item.publicId === input.configurationPublicId)!;
      value.lifecycleStatus = input.status;
      value.revision += 1;
      return structuredClone(value);
    },
    async delete(input: { configurationPublicId: string }) {
      const index = values.findIndex((value) => value.publicId === input.configurationPublicId);
      if (index < 0) return false;
      values.splice(index, 1);
      return true;
    },
    async countReferences() {
      return repository.references;
    }
  };
  return repository;
}

function fromWrite(
  input: EmbeddingRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
  },
  revision: number
): EmbeddingConfigurationPrivate {
  return {
    publicId: input.configurationPublicId,
    revisionPublicId: input.revisionPublicId,
    revision,
    displayName: input.displayName,
    authenticationMode: input.authenticationMode,
    baseUrl: input.baseUrl,
    encryptedApiKey: input.encryptedApiKey,
    apiKeyConfigured: input.encryptedApiKey !== null,
    modelName: input.modelName,
    requestedDimension: input.requestedDimension,
    resolvedDimension: null,
    normalization: input.normalization,
    maximumInputTokens: input.maximumInputTokens,
    batchSize: input.batchSize,
    timeoutMs: input.timeoutMs,
    retryCount: input.retryCount,
    minimumIntervalMs: input.minimumIntervalMs,
    concurrency: input.concurrency,
    maximumResponseBytes: input.maximumResponseBytes,
    minimumVectorRelevance: input.minimumVectorRelevance,
    vectorProducingRevisionPublicId: input.vectorProducingRevisionPublicId,
    queryPolicyRevisionPublicId: input.revisionPublicId,
    validationStatus: "not_tested",
    validationFingerprintSha256: null,
    safeValidationErrorCode: null,
    lifecycleStatus: "draft",
    createdAt: input.createdAt
  };
}
