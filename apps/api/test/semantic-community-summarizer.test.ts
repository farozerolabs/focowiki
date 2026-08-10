import { describe, expect, it, vi } from "vitest";
import { createSemanticCommunitySummarizer } from
  "../src/semantic/application/community-summarizer.js";

describe("semantic community summarizer", () => {
  it("reuses source-grounded entity text for a singleton without a model call", async () => {
    const resolveCompletion = vi.fn();
    const summarize = createSemanticCommunitySummarizer({
      contexts: {
        load: async () => ({
          entities: [{
            publicId: "entity-a",
            label: "Alpha",
            kind: "concept",
            description: "A source-grounded description of Alpha."
          }],
          relationships: []
        })
      },
      artifacts: inMemoryArtifacts(),
      resolveCompletion
    });

    await expect(summarize({
      stageClaim: { settingsSnapshot: {
        maximumCommunitySummaryCharacters: 8_000,
        generationModelConfigurationPublicId: "model-a",
        generationModelConfigurationRevision: 2,
        promptContractVersion: "general-purpose-graph-v2"
      } } as any,
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      partitionKey: "partition-a",
      entityPublicIds: ["entity-a"],
      signal: new AbortController().signal
    })).resolves.toBe("A source-grounded description of Alpha.");
    expect(resolveCompletion).not.toHaveBeenCalled();
  });

  it("builds a bounded domain-neutral prompt from persisted semantic facts", async () => {
    const complete = vi.fn(async (_input: { prompt: string; signal: AbortSignal }) =>
      "A connected group about shared concepts.");
    const summarize = createSemanticCommunitySummarizer({
      contexts: {
        load: async () => ({
          entities: [{
            publicId: "entity-a", label: "Alpha", kind: "concept",
            description: "First concept"
          }, {
            publicId: "entity-b", label: "Beta", kind: "topic",
            description: null
          }],
          relationships: [{
            publicId: "relationship-a-b",
            sourceEntityPublicId: "entity-a",
            targetEntityPublicId: "entity-b",
            kind: "related_to",
            description: "Alpha relates to Beta"
          }]
        })
      },
      artifacts: inMemoryArtifacts(),
      resolveCompletion: async () => ({ complete })
    });

    await expect(summarize({
      stageClaim: { settingsSnapshot: {
        maximumCommunitySummaryCharacters: 8_000,
        generationModelConfigurationPublicId: "model-a",
        generationModelConfigurationRevision: 2,
        promptContractVersion: "general-purpose-graph-v2"
      } } as any,
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      partitionKey: "partition-a",
      entityPublicIds: ["entity-a", "entity-b"],
      signal: new AbortController().signal
    })).resolves.toBe("A connected group about shared concepts.");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Alpha")
    }));
    expect(complete.mock.calls[0]![0].prompt).not.toMatch(/court|statute|legal/iu);
  });

  it("reuses a generated summary only for the same input, model, and prompt identity", async () => {
    const complete = vi.fn(async () => "Stable generated summary.");
    const artifacts = inMemoryArtifacts();
    const summarize = createSemanticCommunitySummarizer({
      contexts: {
        load: async () => ({
          entities: [{
            publicId: "entity-a", label: "Alpha", kind: "concept",
            description: "First concept"
          }, {
            publicId: "entity-b", label: "Beta", kind: "topic",
            description: "Second concept"
          }],
          relationships: []
        })
      },
      artifacts,
      resolveCompletion: async () => ({ complete })
    });
    const request = {
      stageClaim: { settingsSnapshot: {
        maximumCommunitySummaryCharacters: 8_000,
        generationModelConfigurationPublicId: "model-a",
        generationModelConfigurationRevision: 2,
        promptContractVersion: "general-purpose-graph-v2"
      } } as any,
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      partitionKey: "partition-a",
      entityPublicIds: ["entity-a", "entity-b"],
      signal: new AbortController().signal
    };

    await expect(summarize(request)).resolves.toBe("Stable generated summary.");
    await expect(summarize(request)).resolves.toBe("Stable generated summary.");
    await expect(summarize({
      ...request,
      stageClaim: { settingsSnapshot: {
        ...request.stageClaim.settingsSnapshot,
        generationModelConfigurationRevision: 3
      } } as any
    })).resolves.toBe("Stable generated summary.");

    expect(complete).toHaveBeenCalledTimes(2);
  });
});

function inMemoryArtifacts() {
  const summaries = new Map<string, string>();
  const key = (input: {
    knowledgeBaseId: string;
    inputSha256: string;
    modelConfigurationPublicId: string;
    modelConfigurationRevision: number;
    promptContractVersion: string;
  }) => JSON.stringify(input);
  return {
    find: async (input: Parameters<typeof key>[0]) => summaries.get(key(input)) ?? null,
    put: async (input: Parameters<typeof key>[0] & { summary: string }) => {
      const { summary, ...identity } = input;
      summaries.set(key(identity), summary);
    }
  };
}
