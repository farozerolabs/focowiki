import { describe, expect, it, vi } from "vitest";
import { createDocumentSemanticEnrichment } from
  "../src/document-indexing/application/document-semantic-enrichment.js";

describe("document semantic enrichment", () => {
  it("runs the generation model even when sparse GraphRAG is not selected", async () => {
    const enrich = vi.fn(async () => ({
      artifacts: [{ kind: "model_suggestions", publicId: "suggestions-a" }],
      warnings: []
    }));
    const record = vi.fn(async () => undefined);
    const run = createDocumentSemanticEnrichment({
      select: async () => ({
        selected: false,
        decisionSha256: "a".repeat(64),
        reasons: []
      }),
      enrich,
      traces: { record },
      clock: () => "2026-08-14T03:00:00.000Z"
    });

    await expect(run(request({ modelName: "general-model" }))).resolves.toMatchObject({
      selection: { selected: false },
      modelTrace: {
        status: "completed",
        modelName: "general-model",
        warningCount: 0
      },
      warnings: [],
      artifacts: [{ kind: "model_suggestions", publicId: "suggestions-a" }]
    });
    expect(enrich).toHaveBeenCalledOnce();
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      trace: expect.objectContaining({ status: "completed" })
    }));
  });

  it("records not-required only when no generation model is configured", async () => {
    const enrich = vi.fn();
    const record = vi.fn(async () => undefined);
    const run = createDocumentSemanticEnrichment({
      select: async () => ({
        selected: false,
        decisionSha256: "d".repeat(64),
        reasons: []
      }),
      enrich,
      traces: { record },
      clock: () => "2026-08-14T03:00:00.000Z"
    });

    await expect(run(request({ modelName: null }))).resolves.toMatchObject({
      modelTrace: { status: "not_required", modelName: null }
    });
    expect(enrich).not.toHaveBeenCalled();
  });

  it("records running and completed around real model work with real warnings", async () => {
    const traces: unknown[] = [];
    const times = [
      "2026-08-14T03:00:01.000Z",
      "2026-08-14T03:00:02.000Z"
    ];
    const run = createDocumentSemanticEnrichment({
      select: async () => ({
        selected: true,
        decisionSha256: "b".repeat(64),
        reasons: ["stable_sample"]
      }),
      enrich: async () => ({
        artifacts: [{ kind: "semantic_facts", publicId: "facts-a" }],
        warnings: ["partial_entity_evidence"]
      }),
      traces: { async record(input) { traces.push(input.trace); } },
      clock: () => times.shift()!
    });

    const result = await run(request({ modelName: "general-model" }));

    expect(traces).toEqual([
      expect.objectContaining({ status: "running", modelName: "general-model" }),
      expect.objectContaining({
        status: "completed",
        modelName: "general-model",
        warningCount: 1
      })
    ]);
    expect(result.modelTrace).toEqual(traces[1]);
    expect(result.warnings).toEqual(["partial_entity_evidence"]);
  });

  it("records a safe failed trace and rethrows the enrichment failure", async () => {
    const traces: unknown[] = [];
    const error = Object.assign(new Error("provider unavailable"), {
      code: "MODEL_TEMPORARILY_UNAVAILABLE"
    });
    const run = createDocumentSemanticEnrichment({
      select: async () => ({
        selected: true,
        decisionSha256: "c".repeat(64),
        reasons: ["structural_bridge"]
      }),
      enrich: async () => { throw error; },
      traces: { async record(input) { traces.push(input.trace); } },
      clock: (() => {
        const times = [
          "2026-08-14T03:00:03.000Z",
          "2026-08-14T03:00:04.000Z"
        ];
        return () => times.shift()!;
      })()
    });

    await expect(run(request({ modelName: "general-model" }))).rejects.toBe(error);
    expect(traces).toEqual([
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_TEMPORARILY_UNAVAILABLE"
      })
    ]);
  });
});

function request(input: { modelName: string | null }) {
  return {
    documentJobPublicId: "document-job-a",
    knowledgeBaseId: "knowledge-base-a",
    sourceFilePublicId: "source-file-a",
    sourceRevisionPublicId: "source-revision-a",
    logicalPath: "guide.md",
    body: "# General guide\n\nContent.",
    contentProfile: { headingOutline: ["General guide"], definitions: [] },
    modelName: input.modelName,
    signal: new AbortController().signal
  };
}
