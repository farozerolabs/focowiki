import { describe, expect, it } from "vitest";
import { encryptRuntimeSecret } from "../src/runtime-settings/encryption.js";
import {
  unlockGenerationModelRevision
} from "../src/semantic/infrastructure/generation-model-revision.js";

describe("semantic generation model revision", () => {
  it("decrypts the pinned model credential before provider use", () => {
    const deploymentSecret = "d".repeat(32);
    const model = {
      id: "model-config-pinned",
      displayName: "Pinned model",
      apiMode: "chat_completions" as const,
      baseUrl: "https://model.example.test/v1",
      apiKey: encryptRuntimeSecret({
        value: "provider-api-key",
        secret: deploymentSecret
      }),
      configurationRevision: 3,
      apiKeyFingerprint: "fingerprint",
      modelName: "generation-model",
      contextWindowTokens: 8192,
      requestMaxTimeoutMs: 30_000,
      requestIdleTimeoutMs: 10_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 500,
      requestMinIntervalMs: 0,
      status: "active" as const,
      isActive: true,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      deletedAt: null
    };

    expect(unlockGenerationModelRevision(model, deploymentSecret)).toEqual({
      ...model,
      apiKey: "provider-api-key"
    });
  });

  it("rejects a pinned credential encrypted by another deployment", () => {
    const model = {
      id: "model-config-pinned",
      displayName: "Pinned model",
      apiMode: "chat_completions" as const,
      baseUrl: "https://model.example.test/v1",
      apiKey: encryptRuntimeSecret({
        value: "provider-api-key",
        secret: "a".repeat(32)
      }),
      configurationRevision: 3,
      apiKeyFingerprint: "fingerprint",
      modelName: "generation-model",
      contextWindowTokens: 8192,
      requestMaxTimeoutMs: 30_000,
      requestIdleTimeoutMs: 10_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 500,
      requestMinIntervalMs: 0,
      status: "active" as const,
      isActive: true,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      deletedAt: null
    };

    expect(() => unlockGenerationModelRevision(model, "b".repeat(32))).toThrow();
  });
});
