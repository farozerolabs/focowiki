import { describe, expect, it, vi } from "vitest";
import { createModelAssistanceGateway } from "../src/runtime-settings/model-assistance-gateway.js";
import type { ResourceBudget } from "../src/runtime/resource-budget.js";

describe("model assistance gateway", () => {
  it("reuses one provider client and process budget for one model revision", async () => {
    const run = vi.fn();
    const budget: ResourceBudget = {
      async run<T>(operation: () => Promise<T>): Promise<T> {
        run();
        return operation();
      },
      recordRetry: vi.fn(),
      snapshot: vi.fn()
    };
    const createClient = vi.fn(() => ({ responses: { create: vi.fn() } }));
    const gateway = createModelAssistanceGateway({
      budget,
      createClient: createClient as never
    });
    const snapshot = runtimeSnapshot();

    const first = gateway.resolve(snapshot);
    const second = gateway.resolve(snapshot);

    expect(first?.client).toBe(second?.client);
    expect(createClient).toHaveBeenCalledOnce();
    await first?.requestRunner!.run(async () => "ok");
    expect(run).toHaveBeenCalledOnce();
  });
});

function runtimeSnapshot() {
  return {
    activeModel: {
      id: "model-1",
      apiMode: "responses" as const,
      apiKey: "secret",
      apiKeyFingerprint: "fingerprint",
      baseUrl: "https://model.example/v1",
      modelName: "model-1",
      contextWindowTokens: 32_000,
      requestMaxTimeoutMs: 30_000,
      requestIdleTimeoutMs: 10_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 1_000,
      requestMinIntervalMs: 0,
      updatedAt: "2026-07-20T00:00:00.000Z"
    }
  } as never;
}
