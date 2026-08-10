import { describe, expect, it, vi } from "vitest";

import type {
  RerankerConfigurationPrivate
} from "../src/semantic/reranker/configuration.js";
import type {
  RerankerConfigurationRepository,
  RerankerRevisionWrite
} from "../src/semantic/reranker/repository.js";
import { createRerankerConfigurationService } from
  "../src/semantic/reranker/service.js";

describe("reranker configuration application service", () => {
  it("encrypts secrets, preserves omitted credentials, audits actions, and never schedules maintenance", async () => {
    const repository = memoryRepository();
    const audit = vi.fn(async () => undefined);
    const maintenance = vi.fn();
    const transport = { rerank: vi.fn(async (request) => {
      expect(request.apiKey).toBe("reranker-secret");
      return { scores: [0.8] };
    }) };
    const service = createRerankerConfigurationService({
      repository,
      transport,
      audit: { append: audit },
      deploymentSecret: "deployment-secret",
      createPublicId: ids("config", "revision-a", "revision-b"),
      now: () => "2026-08-09T00:00:00.000Z"
    });

    const created = await service.create(draft(), "admin-a");
    expect(created).toMatchObject({
      publicId: "reranker-config-config",
      revisionPublicId: "reranker-revision-revision-a",
      apiKeyConfigured: true,
      validationStatus: "not_tested",
      lifecycleStatus: "draft"
    });
    const updated = await service.update(created.publicId, 1, {
      ...draft(), displayName: "Updated reranker", apiKey: null
    }, "admin-a");
    expect(updated).toMatchObject({ revision: 2, apiKeyConfigured: true });
    await expect(service.test(created.publicId, "admin-a"))
      .resolves.toMatchObject({ validationStatus: "valid" });
    await expect(service.activate(created.publicId, 2, "admin-a"))
      .resolves.toMatchObject({ lifecycleStatus: "active" });
    expect(maintenance).not.toHaveBeenCalled();

    const serialized = JSON.stringify({
      values: await service.list(),
      audits: audit.mock.calls
    });
    expect(serialized).not.toContain("reranker-secret");
    expect(serialized).not.toContain("encryptedApiKey");
    expect(serialized).not.toContain("limit");
    expect(serialized).not.toContain("rerankTopK");
    expect(serialized).not.toContain("rerankScoreThreshold");
  });
});

function draft() {
  return {
    displayName: "Primary reranker",
    authenticationMode: "api_key" as const,
    baseUrl: "https://reranker.example/v1",
    apiKey: "reranker-secret",
    modelName: "rerank-model",
    timeoutMs: 1_500,
    retryCount: 1,
    minimumIntervalMs: 20,
    concurrency: 4
  };
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

function memoryRepository(): RerankerConfigurationRepository & {
  values: RerankerConfigurationPrivate[];
} {
  const values: RerankerConfigurationPrivate[] = [];
  return {
    values,
    async create(input) {
      const value = fromWrite(input, 1);
      values.push(value);
      return structuredClone(value);
    },
    async createRevision(input) {
      const index = values.findIndex((value) =>
        value.publicId === input.configurationPublicId);
      const value = fromWrite(input, input.expectedConfigurationRevision + 1);
      values[index] = value;
      return structuredClone(value);
    },
    async get(publicId) {
      return structuredClone(values.find((value) => value.publicId === publicId) ?? null);
    },
    async getRevision(revisionPublicId) {
      return structuredClone(values.find((value) =>
        value.revisionPublicId === revisionPublicId) ?? null);
    },
    async getActive() {
      return structuredClone(values.find((value) =>
        value.lifecycleStatus === "active") ?? null);
    },
    async list() {
      return structuredClone(values);
    },
    async recordValidation(input) {
      const value = values.find((item) => item.publicId === input.configurationPublicId)!;
      value.validationStatus = input.status;
      value.validationFingerprintSha256 = input.validationFingerprintSha256;
      value.safeValidationErrorCode = input.safeValidationErrorCode;
      return structuredClone(value);
    },
    async setLifecycle(input) {
      const value = values.find((item) => item.publicId === input.configurationPublicId)!;
      value.lifecycleStatus = input.status;
      value.revision += 1;
      return structuredClone(value);
    },
    async delete(input) {
      const index = values.findIndex((value) =>
        value.publicId === input.configurationPublicId);
      if (index < 0) return false;
      values.splice(index, 1);
      return true;
    }
  };
}

function fromWrite(
  input: RerankerRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
  },
  revision: number
): RerankerConfigurationPrivate {
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
    timeoutMs: input.timeoutMs,
    retryCount: input.retryCount,
    minimumIntervalMs: input.minimumIntervalMs,
    concurrency: input.concurrency,
    validationStatus: "not_tested",
    validationFingerprintSha256: null,
    safeValidationErrorCode: null,
    lifecycleStatus: "draft",
    createdAt: input.createdAt
  };
}
