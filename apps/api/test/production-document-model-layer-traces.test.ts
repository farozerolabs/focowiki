import { describe, expect, it, vi } from "vitest";
import { recordEvaluationLayers } from
  "../src/document-indexing/infrastructure/production-document-model-layer-traces.js";

describe("production document model layer traces", () => {
  it("records the first layer when the obsolete candidate-delta trace is disabled", async () => {
    const record = vi.fn(async (_value: unknown) => undefined);

    await recordEvaluationLayers({
      repository: { record } as never,
      job: job() as never,
      modelName: "general-model",
      execution: execution() as never,
      warningCount: 0,
      recordCandidateDelta: false
    });

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      layer: "first_layer",
      status: "completed",
      providerRequestCount: 1,
      serviceTimeMs: 120
    }));
  });

  it("retains the legacy combined trace behavior when explicitly requested", async () => {
    const record = vi.fn(async (_value: unknown) => undefined);

    await recordEvaluationLayers({
      repository: { record } as never,
      job: job() as never,
      modelName: "general-model",
      execution: execution() as never,
      warningCount: 0
    });

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map(([value]) =>
      (value as { layer: string }).layer)).toEqual([
      "first_layer",
      "candidate_delta"
    ]);
  });
});

function job() {
  return {
    publicId: "document-job-a",
    knowledgeBaseId: "knowledge-base-a",
    sourceRevisionPublicId: "source-revision-a"
  };
}

function execution() {
  return {
    firstLayer: {
      ownerIdentity: "first-owner-a",
      reused: false,
      providerRequestCount: 1,
      waitTimeMs: 10,
      serviceTimeMs: 120,
      providerObservations: []
    },
    candidateDelta: {
      ownerIdentity: "candidate-owner-a",
      providerRequestCount: 0,
      waitTimeMs: 0,
      serviceTimeMs: 0,
      providerObservations: []
    }
  };
}
