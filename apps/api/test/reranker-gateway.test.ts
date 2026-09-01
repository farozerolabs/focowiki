import { describe, expect, it, vi } from "vitest";

import { createRerankerGateway } from
  "../src/semantic/reranker/gateway.js";
import type { RerankerCandidate } from
  "../src/semantic/reranker/gateway.js";
import { encryptRuntimeSecret } from
  "../src/runtime-settings/encryption.js";

describe("bounded source-grounded reranker gateway", () => {
  it("reranks only authorized non-exact candidates, applies threshold, and preserves exact tiers", async () => {
    const transport = vi.fn(async (request) => {
      expect(request.documents).toEqual([
        "Semantic A\npages/a.md\nGrounded excerpt A",
        "Semantic B\npages/b.md\nGrounded excerpt B"
      ]);
      return { scores: [0.4, 0.9] };
    });
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => configuration(),
      transport: { rerank: transport },
      deploymentSecret: "deployment-secret",
      maximumExcerptCharacters: 100,
      maximumExcerptBytes: 400,
      maximumPayloadBytes: 4_096,
      maximumBacklog: 8
    });
    const result = await gateway.rerank({
      query: "Which source applies?",
      knowledgeBaseId: "kb-a",
      candidates: candidates(),
      rerankTopK: 3,
      rerankScoreThreshold: 0.5,
      limit: 3,
      signal: null
    });

    expect(result.status).toEqual({ state: "applied", safeCode: null });
    expect(result.metrics).toEqual({
      windowCount: 2,
      thresholdRejectedCount: 1
    });
    expect(result.candidates.map((item) => item.sourceFilePublicId)).toEqual([
      "file-exact-path", "file-exact-title", "file-b"
    ]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("preserves exact source candidates without sending empty excerpts to the model", async () => {
    const transport = vi.fn(async (request) => {
      expect(request.documents).toEqual([
        "Semantic A\npages/a.md\nGrounded excerpt A"
      ]);
      return { scores: [0.9] };
    });
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => configuration(),
      transport: { rerank: transport },
      deploymentSecret: "deployment-secret"
    });

    const result = await gateway.rerank({
      query: "Which source applies?",
      knowledgeBaseId: "kb-a",
      candidates: [
        { ...candidates()[0]!, sourceExcerpt: "", evidenceTypes: ["path"] },
        candidates()[2]!
      ],
      rerankTopK: 2,
      rerankScoreThreshold: 0.5,
      limit: 2,
      signal: null
    });

    expect(result.candidates.map((item) => item.sourceFilePublicId)).toEqual([
      "file-exact-path", "file-a"
    ]);
  });

  it.each([
    [null, "not_configured"],
    [{ ...configuration(), lifecycleStatus: "paused" as const }, "skipped"]
  ])("fails open when the active configuration is %s", async (configurationValue, state) => {
    const transport = vi.fn();
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => configurationValue,
      transport: { rerank: transport },
      deploymentSecret: "deployment-secret"
    });
    const result = await gateway.rerank({
      query: "Which source applies?",
      knowledgeBaseId: "kb-a",
      candidates: candidates(),
      rerankTopK: 3,
      rerankScoreThreshold: 0.5,
      limit: 3,
      signal: null
    });
    expect(result.status.state).toBe(state);
    expect(result.candidates).toEqual(candidates().slice(0, 3));
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails open when active configuration resolution is unavailable", async () => {
    const transport = vi.fn();
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => {
        throw new Error("repository unavailable");
      },
      transport: { rerank: transport },
      deploymentSecret: "deployment-secret"
    });

    await expect(gateway.rerank({
      query: "Which source applies?",
      knowledgeBaseId: "kb-a",
      candidates: candidates(),
      rerankTopK: 3,
      rerankScoreThreshold: 0.5,
      limit: 3,
      signal: null
    })).resolves.toEqual({
      candidates: candidates().slice(0, 3),
      status: {
        state: "degraded",
        safeCode: "RERANKER_CONFIGURATION_UNAVAILABLE"
      }
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails open atomically on invalid transport output or timeout", async () => {
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => configuration(),
      transport: { rerank: vi.fn(async () => ({ scores: [0.9] })) },
      deploymentSecret: "deployment-secret"
    });
    const result = await gateway.rerank({
      query: "Which source applies?",
      knowledgeBaseId: "kb-a",
      candidates: candidates(),
      rerankTopK: 3,
      rerankScoreThreshold: 0.5,
      limit: 3,
      signal: null
    });
    expect(result.status.state).toBe("degraded");
    expect(result.candidates).toEqual(candidates().slice(0, 3));
  });

  it("reports when an explicit positive threshold removes every non-exact candidate", async () => {
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => configuration(),
      transport: { rerank: vi.fn(async () => ({ scores: [0.1, 0.2] })) },
      deploymentSecret: "deployment-secret"
    });

    const result = await gateway.rerank({
      query: "Which source applies?",
      knowledgeBaseId: "kb-a",
      candidates: candidates().slice(2),
      rerankTopK: 2,
      rerankScoreThreshold: 0.8,
      limit: 2,
      signal: null
    });

    expect(result).toEqual({
      candidates: [],
      status: {
        state: "applied",
        safeCode: "RERANKER_ALL_BELOW_THRESHOLD"
      },
      metrics: {
        windowCount: 2,
        thresholdRejectedCount: 2
      }
    });
  });

  it("never sends foreign, generated-only, full-file, vector, or internal candidate data", async () => {
    const transport = vi.fn(async (request) => {
      const payload = JSON.stringify(request);
      expect(payload).not.toContain("foreign body");
      expect(payload).not.toContain("generated summary only");
      expect(payload).not.toContain("full private body");
      expect(payload).not.toContain("internal-entity-id");
      expect(payload).not.toContain("0.123456");
      return { scores: request.documents.map(() => 0.8) };
    });
    const gateway = createRerankerGateway({
      resolveActiveConfiguration: async () => configuration(),
      transport: { rerank: transport },
      deploymentSecret: "deployment-secret",
      maximumExcerptCharacters: 20,
      maximumExcerptBytes: 40
    });
    const untrustedCandidate: RerankerCandidate & {
      fullBody: string;
      vector: number[];
      semanticEntityPublicId: string;
    } = {
      ...candidates()[2]!,
      sourceFilePublicId: "file-generated",
      sourceGrounded: false,
      sourceExcerpt: "generated summary only",
      fullBody: "full private body",
      vector: [0.123456],
      semanticEntityPublicId: "internal-entity-id"
    };
    await gateway.rerank({
      query: "Authorized query",
      knowledgeBaseId: "kb-a",
      candidates: [
        ...candidates(),
        {
          ...candidates()[2]!,
          sourceFilePublicId: "file-foreign",
          knowledgeBaseId: "kb-b",
          sourceExcerpt: "foreign body"
        },
        untrustedCandidate
      ],
      rerankTopK: 4,
      rerankScoreThreshold: 0,
      limit: 3,
      signal: null
    });
  });
});

function configuration() {
  return {
    publicId: "reranker-config-a",
    revisionPublicId: "reranker-revision-a",
    revision: 1,
    displayName: "Reranker",
    authenticationMode: "api_key" as const,
    baseUrl: "https://reranker.example/v1",
    encryptedApiKey: encryptRuntimeSecret({
      value: "reranker-secret",
      secret: "deployment-secret"
    }),
    apiKeyConfigured: true,
    modelName: "rerank-model",
    timeoutMs: 1_000,
    retryCount: 0,
    minimumIntervalMs: 0,
    concurrency: 2,
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-09T00:00:00.000Z"
  };
}

function candidates() {
  return [
    candidate("file-exact-path", "exact_path", "Exact path"),
    candidate("file-exact-title", "exact_title", "Exact title"),
    candidate("file-a", "fused", "Semantic A", "Grounded excerpt A"),
    candidate("file-b", "fused", "Semantic B", "Grounded excerpt B")
  ];
}

function candidate(
  sourceFilePublicId: string,
  priority: "exact_path" | "exact_title" | "fused",
  title: string,
  sourceExcerpt = "Grounded excerpt"
) {
  return {
    knowledgeBaseId: "kb-a",
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    logicalPath: `pages/${sourceFilePublicId.replace("file-", "")}.md`,
    title,
    sourceExcerpt,
    sourceGrounded: true,
    priority,
    evidenceTypes: ["content"] as const
  };
}
