import { describe, expect, it } from "vitest";
import {
  GRAPHRAG_RESPONSE_SCHEMA,
  type GraphRagAdapterRequest,
  type GraphRagAdapterResponse
} from "../src/semantic/graphrag/contracts.js";
import {
  createGraphRagExtractionGateway
} from "../src/semantic/graphrag/extraction-gateway.js";
import {
  createSemanticSourceChunks,
  semanticChunkManifestHash
} from "../src/semantic/graphrag/source-chunks.js";
import type { GraphRagPythonPool } from "../src/semantic/graphrag/python-pool.js";

describe("semantic GraphRAG extraction gateway", () => {
  it("prepares prompts, completes bounded chunks, and returns owned facts", async () => {
    const operations: string[] = [];
    const pool = fakePool(async (request) => {
      operations.push(request.operation);
      if (request.operation === "prepare") {
        const source = request.source as { canonicalInputHash: string; chunks: Array<{ id: string }> };
        return ok(request, {
          canonicalInputHash: source.canonicalInputHash,
          promptRevision: "general-purpose-graph-v2",
          prompts: source.chunks.map((chunk) => ({
            chunkId: chunk.id,
            prompt: `Extract ${chunk.id}`
          }))
        });
      }
      const source = request.source as { chunks: Array<{ id: string }> };
      const evidenceId = source.chunks[0]!.id;
      return ok(request, {
        entities: [{
          entityId: "adapter-a",
          canonicalName: "Alpha System",
          normalizedName: "alpha system",
          entityType: "SYSTEM",
          descriptions: ["A described system."]
        }],
        mentions: [{
          mentionId: "mention-a",
          entityId: "adapter-a",
          sourceFileId: "file-a",
          sourceRevisionId: "revision-a",
          evidenceId
        }],
        relationships: []
      });
    });
    const prompts: string[] = [];
    const gateway = createGraphRagExtractionGateway({
      pool,
      selectSkeleton: selectEveryChunk,
      maximumChunkCharacters: 32,
      model: {
        async complete(input) {
          prompts.push(input.prompt);
          return '("entity"<|TUPLE|>"Alpha System"<|TUPLE|>"SYSTEM"<|TUPLE|>"A described system.")<|COMPLETE|>';
        }
      }
    });
    const result = await gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "systems/alpha.md",
      markdown: "# Alpha System\n\nA described system used by a team.",
      signal: new AbortController().signal
    });
    expect(operations).toEqual(["prepare", "extract"]);
    expect(prompts).toHaveLength(result.chunks.length);
    expect(result.generationRequestCount).toBe(prompts.length);
    expect(result.desiredFacts.entities).toHaveLength(1);
    expect(result.desiredFacts.evidence[0]).toMatchObject({
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "systems/alpha.md"
    });
  });

  it("creates stable chunks and rejects sources beyond the configured manifest", () => {
    const input = {
      sourceRevisionPublicId: "revision-a",
      markdown: "First paragraph.\n\nSecond paragraph.",
      maximumChunkCharacters: 18,
      maximumChunks: 2
    };
    const first = createSemanticSourceChunks(input);
    expect(createSemanticSourceChunks(input)).toEqual(first);
    expect(semanticChunkManifestHash(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => createSemanticSourceChunks({
      ...input,
      markdown: "a".repeat(100),
      maximumChunks: 2
    })).toThrow("bounded extraction manifest");
  });

  it("rejects reordered prompt manifests before any model call", async () => {
    let modelCalls = 0;
    const gateway = createGraphRagExtractionGateway({
      pool: fakePool(async (request) => ok(request, {
        canonicalInputHash: (request.source as { canonicalInputHash: string }).canonicalInputHash,
        promptRevision: "general-purpose-graph-v2",
        prompts: [{ chunkId: "wrong", prompt: "unsafe" }]
      })),
      selectSkeleton: selectEveryChunk,
      model: { async complete() { modelCalls += 1; return "unused"; } }
    });
    await expect(gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "alpha.md",
      markdown: "Alpha",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "semantic_prompt_manifest_invalid", retryable: false });
    expect(modelCalls).toBe(0);
  });

  it("uses only the configured bounded completion concurrency", async () => {
    let active = 0;
    let peak = 0;
    const gateway = createGraphRagExtractionGateway({
      pool: fakePool(async (request) => request.operation === "prepare"
        ? ok(request, {
            canonicalInputHash:
              (request.source as { canonicalInputHash: string }).canonicalInputHash,
            promptRevision: "general-purpose-graph-v2",
            prompts: (request.source as { chunks: Array<{ id: string }> }).chunks
              .map((chunk) => ({ chunkId: chunk.id, prompt: `Extract ${chunk.id}` }))
          })
        : ok(request, { entities: [], mentions: [], relationships: [] })),
      selectSkeleton: selectEveryChunk,
      maximumChunkCharacters: 12,
      maximumChunks: 4,
      completionConcurrency: 2,
      model: {
        async complete() {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return "<|COMPLETE|>";
        }
      }
    });

    await gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "alpha.md",
      markdown: "First block.\nSecond block.\nThird block.",
      signal: new AbortController().signal
    });

    expect(peak).toBe(2);
  });

  it("records generation service time without counting scarce-permit queue wait", async () => {
    let clock = 0;
    const gateway = createGraphRagExtractionGateway({
      pool: fakePool(async (request) => request.operation === "prepare"
        ? ok(request, {
            canonicalInputHash:
              (request.source as { canonicalInputHash: string }).canonicalInputHash,
            promptRevision: "general-purpose-graph-v2",
            prompts: (request.source as { chunks: Array<{ id: string }> }).chunks
              .map((chunk) => ({ chunkId: chunk.id, prompt: `Extract ${chunk.id}` }))
          })
        : ok(request, { entities: [], mentions: [], relationships: [] })),
      selectSkeleton: selectEveryChunk,
      maximumChunks: 1,
      now: () => clock,
      requestRunner: {
        async run(task) {
          clock = 1_000;
          return task();
        }
      },
      model: {
        async complete() {
          clock = 1_075;
          return "<|COMPLETE|>";
        }
      }
    });

    const result = await gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "alpha.md",
      markdown: "Alpha",
      signal: new AbortController().signal
    });

    expect(result.generationRequestCount).toBe(1);
    expect(result.generationServiceTimeMilliseconds).toBe(75);
  });

  it("halves retry chunks without exceeding the bounded manifest", async () => {
    const gateway = createGraphRagExtractionGateway({
      pool: fakePool(async (request) => request.operation === "prepare"
        ? ok(request, {
            canonicalInputHash:
              (request.source as { canonicalInputHash: string }).canonicalInputHash,
            promptRevision: "general-purpose-graph-v2",
            prompts: (request.source as { chunks: Array<{ id: string }> }).chunks
              .map((chunk) => ({ chunkId: chunk.id, prompt: `Extract ${chunk.id}` }))
          })
        : ok(request, { entities: [], mentions: [], relationships: [] })),
      selectSkeleton: selectEveryChunk,
      maximumChunkCharacters: 16,
      maximumChunks: 10,
      retryAttempt: 2,
      model: { async complete() { return "<|COMPLETE|>"; } }
    });

    const result = await gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "alpha.md",
      markdown: "abcdefghijklmnopqrstuvwxyz012345",
      signal: new AbortController().signal
    });

    expect(result.chunks).toHaveLength(4);
    expect(result.chunks.every((chunk) => chunk.text.length <= 8)).toBe(true);
  });

  it("records complete coverage without Python or generation work when not selected", async () => {
    let poolCalls = 0;
    let modelCalls = 0;
    const gateway = createGraphRagExtractionGateway({
      pool: fakePool(async (request) => {
        poolCalls += 1;
        return ok(request, {});
      }),
      selectSkeleton: ({ chunks }) => ({
        policyVersion: "semantic-skeleton-policy-v2",
        selected: false,
        selectedChunkIds: [],
        reasons: [],
        decisionSha256: "a".repeat(64),
        sourceChunkCount: chunks.length
      }),
      model: {
        async complete() {
          modelCalls += 1;
          return "unused";
        }
      }
    });

    const result = await gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "notes/ordinary.md",
      markdown: "# Notes\n\nAn ordinary source remains fully searchable.",
      signal: new AbortController().signal
    });

    expect(result.selection).toMatchObject({
      selected: false,
      selectedChunkIds: [],
      sourceChunkCount: result.chunks.length
    });
    expect(result.desiredFacts.entities).toEqual([]);
    expect(result.desiredFacts.relationships).toEqual([]);
    expect(result.generationRequestCount).toBe(0);
    expect(result.generationServiceTimeMilliseconds).toBe(0);
    expect(poolCalls).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it("sends only selected bounded chunks to the adapter and model", async () => {
    let preparedChunkCount = 0;
    let modelCalls = 0;
    const gateway = createGraphRagExtractionGateway({
      pool: fakePool(async (request) => {
        const source = request.source as {
          canonicalInputHash: string;
          chunks: Array<{ id: string }>;
        };
        if (request.operation === "prepare") {
          preparedChunkCount = source.chunks.length;
          return ok(request, {
            canonicalInputHash: source.canonicalInputHash,
            promptRevision: "general-purpose-graph-v2",
            prompts: source.chunks.map((chunk) => ({
              chunkId: chunk.id,
              prompt: `Extract ${chunk.id}`
            }))
          });
        }
        return ok(request, { entities: [], mentions: [], relationships: [] });
      }),
      maximumChunkCharacters: 12,
      maximumChunks: 8,
      selectSkeleton: ({ chunks }) => ({
        policyVersion: "semantic-skeleton-policy-v2",
        selected: true,
        selectedChunkIds: [chunks[1]!.id],
        reasons: ["structural_bridge"],
        decisionSha256: "b".repeat(64),
        sourceChunkCount: chunks.length
      }),
      model: {
        async complete() {
          modelCalls += 1;
          return "<|COMPLETE|>";
        }
      }
    });

    const result = await gateway.extract({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "architecture/map.md",
      markdown: "First block.\nSecond block.\nThird block.",
      signal: new AbortController().signal
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(preparedChunkCount).toBe(1);
    expect(modelCalls).toBe(1);
    expect(result.generationRequestCount).toBe(1);
    expect(result.selection.selectedChunkIds).toEqual([result.chunks[1]!.id]);
  });
});

function fakePool(
  run: (request: GraphRagAdapterRequest) => Promise<GraphRagAdapterResponse>
): GraphRagPythonPool {
  return {
    start: async () => undefined,
    run: async (request) => run(request),
    close: async () => undefined,
    stats: () => ({ size: 1, busy: 0, queued: 0, restarts: 0 })
  };
}

function ok(
  request: GraphRagAdapterRequest,
  result: Record<string, unknown>
): GraphRagAdapterResponse {
  return {
    schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
    requestId: request.requestId,
    ok: true,
    result
  };
}

function selectEveryChunk(input: { chunks: readonly { id: string }[] }) {
  return {
    policyVersion: "semantic-skeleton-policy-v2",
    selected: true,
    selectedChunkIds: input.chunks.map((chunk) => chunk.id),
    reasons: ["stable_sample" as const],
    decisionSha256: "c".repeat(64),
    sourceChunkCount: input.chunks.length
  };
}
