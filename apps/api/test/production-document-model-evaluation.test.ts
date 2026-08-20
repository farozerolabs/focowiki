import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionsJsonRequest } from "@focowiki/okf";
import type {
  DocumentModelAnalysisResultFact,
  DocumentModelEvaluationRepository,
  DocumentRelationshipEvaluationFact
} from "../src/document-indexing/application/document-model-evaluation.js";
import { createDocumentResourcePermits } from
  "../src/document-indexing/application/document-resource-permits.js";
import { buildSourceContentProfile } from "../src/graph/content-profile.js";
import { createProductionDocumentModelEvaluation } from
  "../src/document-indexing/infrastructure/production-document-model-evaluation.js";
import {
  documentCandidateTokenMap,
  resolveDocumentCandidateConfirmations
} from "../src/document-indexing/infrastructure/production-document-model-evaluation-inputs.js";
import { testLexicalTokenizer } from "./helpers/test-lexical-tokenizer.js";

describe("production document model evaluation reuse", () => {
  it("reuses one combined analysis and an evidence-accurate relationship refinement", async () => {
    const repository = memoryRepository();
    const create = vi.fn(async (request: ChatCompletionsJsonRequest): Promise<unknown> => ({
      id: "provider-request-a",
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(
        request.messages[0]?.content.includes("relationship reviewer")
          ? { relationships: [{
              candidateId: "candidate-0001",
              relationType: "direct_reference",
              confidence: 0.92,
              reason: "The maintenance guide is visibly referenced."
            }] }
          : {
        suggestions: {
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: ["climate"],
          keywords: ["maintenance"]
        },
        relationships: []
      }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 24 }
    }));
    const evaluation = createProductionDocumentModelEvaluation({
      repository,
      permits: createDocumentResourcePermits({
        capacities: {
          s3_read: 1,
          generation_model: 1,
          embedding: 1,
          database_mutation: 1,
          generated_object_write: 1,
          search_provider: 1
        },
        maximumWaitersPerResource: 4
      })
    });
    const request = modelRequest(create);
    request.edges[0] = {
      ...request.edges[0]!,
      relationType: "same_specific_subject"
    };

    const first = await evaluation.analyze(request);
    const second = await evaluation.analyze(request);
    const moved = await evaluation.analyze({
      ...request,
      sourceRevisionPublicId: "source-revision-a-moved",
      source: {
        ...request.source,
        path: "pages/archive/climate.md"
      }
    });
    const delta = await evaluation.confirmDelta(request);
    const revised = await evaluation.analyze({
      ...request,
      candidates: [{
        ...request.candidates[0]!,
        sourceRevisionPublicId: "source-revision-b2",
        evidenceExcerpt: "Revised maintenance procedures for the service."
      }],
      edges: [{
        ...request.edges[0]!,
        evidence: {
          ...request.edges[0]!.evidence,
          sourceExcerpt: "See the revised Maintenance Guide."
        }
      }]
    });

    expect(first.suggestions).toEqual(second.suggestions);
    expect(first.confirmations).toEqual(second.confirmations);
    expect(first.execution.firstLayer).toMatchObject({
      reused: false,
      providerRequestCount: 1,
      providerObservations: [expect.objectContaining({
        requestId: "provider-request-a",
        finishState: "stop",
        inputTokens: 120,
        outputTokens: 24,
        errorClass: "none"
      })]
    });
    expect(second.execution.firstLayer).toMatchObject({
      reused: true,
      providerRequestCount: 0
    });
    expect(moved.execution.firstLayer).toMatchObject({
      reused: true,
      providerRequestCount: 0
    });
    expect(first.confirmations).toEqual([
      expect.objectContaining({
        targetFileId: "source-b",
        accepted: true,
        relationType: "direct_reference"
      })
    ]);
    expect(delta.confirmations).toEqual(first.confirmations);
    expect(revised.execution).toMatchObject({
      firstLayer: { reused: true, providerRequestCount: 0 },
      candidateDelta: {
        reusedDecisionCount: 0,
        evaluatedDecisionCount: 1,
        providerRequestCount: 1
      }
    });
    expect(create).toHaveBeenCalledTimes(3);
    const intrinsicRequest = JSON.stringify(create.mock.calls[0]![0]);
    const initialRelationshipRequest = JSON.stringify(create.mock.calls[1]![0]);
    const revisedRelationshipRequest = JSON.stringify(create.mock.calls[2]![0]);
    expect(intrinsicRequest).toContain("FIRST_LAYER_BODY_ONLY_SENTINEL");
    expect(intrinsicRequest).not.toContain("candidate-0001");
    expect(initialRelationshipRequest).toContain("candidate-0001");
    expect(initialRelationshipRequest).toContain("See the Maintenance Guide.");
    expect(initialRelationshipRequest).not.toContain("FIRST_LAYER_BODY_ONLY_SENTINEL");
    expect(initialRelationshipRequest).not.toContain("source-b");
    expect(initialRelationshipRequest).not.toContain("source-revision");
    expect(revisedRelationshipRequest).toContain("See the revised Maintenance Guide.");
    expect(revisedRelationshipRequest).not.toContain("FIRST_LAYER_BODY_ONLY_SENTINEL");
  });

  it("evaluates every relationship candidate in bounded provider batches", async () => {
    const repository = memoryRepository();
    const create = vi.fn(async (request: ChatCompletionsJsonRequest): Promise<unknown> => ({
      id: `provider-request-${create.mock.calls.length}`,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(
        request.messages[0]?.content.includes("relationship reviewer")
          ? { relationships: [] }
          : {
              suggestions: {
                title: "Climate Operations",
                type: "guide",
                description: "Operations guidance.",
                tags: ["climate"],
                keywords: ["maintenance"]
              },
              relationships: []
            }
      ) } }],
      usage: { prompt_tokens: 120, completion_tokens: 24 }
    }));
    const evaluation = createProductionDocumentModelEvaluation({
      repository,
      permits: createDocumentResourcePermits({
        capacities: {
          s3_read: 1,
          generation_model: 4,
          embedding: 1,
          database_mutation: 1,
          generated_object_write: 1,
          search_provider: 1
        },
        maximumWaitersPerResource: 16
      })
    });
    const request = modelRequest(create);
    request.candidates = Array.from({ length: 33 }, (_, index) => ({
      ...request.candidates[0]!,
      sourceFilePublicId: `source-${index + 1}`,
      sourceRevisionPublicId: `source-revision-${index + 1}`,
      logicalPath: `candidate-${index + 1}.md`,
      title: `Candidate ${index + 1}`
    }));
    request.edges = request.candidates.map((candidate, index) => ({
      ...request.edges[0]!,
      toFileId: candidate.sourceFilePublicId,
      reason: `Candidate evidence ${index + 1}.`
    }));

    const result = await evaluation.analyze(request);

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.execution).toMatchObject({
      firstLayer: { providerRequestCount: 1 },
      candidateDelta: {
        providerRequestCount: 1,
        evaluatedDecisionCount: 33
      }
    });
    expect(result.confirmations).toHaveLength(33);
    expect(result.confirmations.every((item) => item.accepted === false)).toBe(true);
  });

  it("maps model-selected candidate ids without using titles as identity", () => {
    const candidates = [{
      sourceFilePublicId: "source-file-constitution-1993",
      sourceRevisionPublicId: "source-revision-constitution-1993",
      logicalPath: "constitution-1993.md",
      title: "中华人民共和国宪法修正案（1993年）",
      kind: "document",
      rankingTerms: [],
      evidenceExcerpt: "1993年宪法修正内容。"
    }];
    const tokens = documentCandidateTokenMap(candidates);

    expect(resolveDocumentCandidateConfirmations([{
      targetFileId: "candidate-0001",
      accepted: true,
      relationType: "version_relation",
      weight: 0.95,
      reason: "1988年与1993年的修正内容属于同一版本序列。"
    }], tokens)).toEqual([expect.objectContaining({
      targetFileId: "source-file-constitution-1993",
      accepted: true
    })]);
  });

  it("rejects unknown and duplicate model-selected candidate ids", () => {
    const tokens = new Map([["source-file-a", "candidate-0001"]]);
    const confirmation = {
      targetFileId: "candidate-0001",
      accepted: true,
      relationType: "same_specific_subject",
      weight: 0.9,
      reason: "Both sources address the same specific subject."
    };

    expect(() => resolveDocumentCandidateConfirmations([{
      ...confirmation,
      targetFileId: "candidate-9999"
    }], tokens)).toThrow("unknown candidate id");
    expect(() => resolveDocumentCandidateConfirmations([
      confirmation, confirmation
    ], tokens)).toThrow("duplicate candidate id");
  });
});

function modelRequest(
  create: (request: ChatCompletionsJsonRequest) => Promise<unknown>
) {
  const body = [
    "# Climate Operations",
    "",
    "See the Maintenance Guide.",
    "",
    "FIRST_LAYER_BODY_ONLY_SENTINEL"
  ].join("\n");
  const profile = buildSourceContentProfile({
    title: "Climate Operations",
    body,
    metadata: {},
    suggestions: null,
    tokenizer: testLexicalTokenizer
  });
  return {
    knowledgeBaseId: "knowledge-base-a",
    sourceRevisionPublicId: "source-revision-a",
    modelConfigurationPublicId: "model-config-a",
    modelConfigurationRevision: 2,
    assistance: {
      modelConfigId: "model-config-a",
      apiMode: "chat_completions" as const,
      client: {
        apiMode: "chat_completions" as const,
        structuredOutputCapability: "native_json_schema" as const,
        chat: { completions: { create } }
      },
      modelName: "general-model",
      contextWindowTokens: 32_000,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      suggestionConcurrency: 1,
      transientRetryDelayMs: 1
    },
    source: {
      fileId: "source-a",
      path: "pages/climate.md",
      title: "Climate Operations",
      type: "guide",
      profile
    },
    body,
    candidates: [{
      sourceFilePublicId: "source-b",
      sourceRevisionPublicId: "source-revision-b",
      logicalPath: "maintenance.md",
      title: "Maintenance Guide",
      kind: "guide",
      rankingTerms: ["maintenance guide"],
      evidenceExcerpt: "Maintenance procedures for the service."
    }],
    edges: [{
      fromFileId: "source-a",
      toFileId: "source-b",
      relationType: "direct_reference",
      weight: 0.9,
      reason: "The source names the maintenance guide.",
      source: "deterministic" as const,
      evidence: {
        sourceExcerpt: "See the Maintenance Guide.",
        startOffset: 22,
        endOffset: 39,
        evidenceTerms: ["Maintenance Guide"]
      }
    }],
    signal: new AbortController().signal
  };
}

function memoryRepository(): DocumentModelEvaluationRepository {
  const analyses = new Map<string, DocumentModelAnalysisResultFact>();
  const relationships = new Map<string, DocumentRelationshipEvaluationFact>();
  return {
    async findAnalysis(input) {
      return analyses.get(`${input.knowledgeBaseId}\u001f${input.publicId}`) ?? null;
    },
    async findReusableAnalysis(input) {
      return [...analyses.values()].find((analysis) =>
        analysis.knowledgeBaseId === input.knowledgeBaseId
        && analysis.modelConfigurationPublicId === input.modelConfigurationPublicId
        && analysis.modelConfigurationRevision === input.modelConfigurationRevision
        && analysis.promptContractSha256 === input.promptContractSha256
        && analysis.modelInputSha256 === input.modelInputSha256
      ) ?? null;
    },
    async storeAnalysis(input) {
      const key = `${input.knowledgeBaseId}\u001f${input.publicId}`;
      if (!analyses.has(key)) analyses.set(key, input);
      return analyses.get(key)!;
    },
    async findRelationships(input) {
      return input.publicIds.flatMap((publicId) => {
        const value = relationships.get(`${input.knowledgeBaseId}\u001f${publicId}`);
        return value ? [value] : [];
      });
    },
    async findReusableRelationships(input) {
      return [...relationships.values()].filter((relationship) =>
        relationship.knowledgeBaseId === input.knowledgeBaseId
        && input.targetRevisionPublicIds.includes(
          relationship.targetRevisionPublicId
        )
        && input.evidenceFingerprintSha256s.includes(
          relationship.evidenceFingerprintSha256
        )
        && relationship.modelConfigurationPublicId
          === input.modelConfigurationPublicId
        && relationship.modelConfigurationRevision
          === input.modelConfigurationRevision
        && relationship.promptContractSha256 === input.promptContractSha256
      );
    },
    async storeRelationships(input) {
      for (const evaluation of input.evaluations) {
        const key = `${evaluation.knowledgeBaseId}\u001f${evaluation.publicId}`;
        if (!relationships.has(key)) relationships.set(key, evaluation);
      }
      return input.evaluations.map((evaluation) =>
        relationships.get(`${evaluation.knowledgeBaseId}\u001f${evaluation.publicId}`)!
      );
    }
  };
}
