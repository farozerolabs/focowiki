import { describe, expect, it, vi } from "vitest";
import { createDocumentModelGraphEnrichment } from
  "../src/document-indexing/application/document-model-graph-enrichment.js";
import { createDocumentModelRelationshipDeltaEnrichment } from
  "../src/document-indexing/application/document-model-graph-enrichment.js";
import { documentModelCandidateTerms } from
  "../src/document-indexing/application/document-model-graph-edge-resolution.js";
import { buildSourceContentProfile } from
  "../src/graph/content-profile.js";
import { testLexicalTokenizer } from "./helpers/test-lexical-tokenizer.js";

describe("document model and file-graph enrichment", () => {
  it("drops oversized profile phrases before candidate lookup", () => {
    const profile = buildSourceContentProfile({
      title: "Bounded title",
      body: "# Bounded title\n\nUseful text.",
      metadata: {},
      suggestions: null,
      tokenizer: testLexicalTokenizer
    });

    expect(documentModelCandidateTerms("Bounded title", {
      ...profile,
      subjects: ["法".repeat(300), "useful subject"]
    })).toEqual(expect.arrayContaining(["Bounded title", "useful subject"]));
    expect(documentModelCandidateTerms("Bounded title", {
      ...profile,
      subjects: ["法".repeat(300), "useful subject"]
    })).not.toContain("法".repeat(300));
  });

  it("runs suggestions and grounded relation confirmation before GraphRAG inputs", async () => {
    const events: string[] = [];
    const analyze = vi.fn(async (request: {
      candidates: readonly { sourceFilePublicId: string }[];
    }) => {
      events.push("analyze");
      return {
        suggestions: {
          title: "Constitutional Amendment 1993",
          type: "amendment",
          description: "An amendment to the Constitution.",
          tags: ["constitution"],
          keywords: ["constitutional amendment"]
        },
        confirmations: request.candidates.map((candidate) => ({
          targetFileId: candidate.sourceFilePublicId,
          accepted: true,
          relationType: "version_relation",
          weight: 0.94,
          reason: "The 1993 amendment visibly revises the earlier constitutional text."
        })),
        warnings: [],
        execution: modelExecution()
      };
    });
    const run = createDocumentModelGraphEnrichment({
      tokenizer: testLexicalTokenizer,
      candidates: {
        async find() {
          events.push("candidates");
          return [{
            sourceFilePublicId: "source-file-constitution",
            sourceRevisionPublicId: "source-revision-constitution",
            logicalPath: "01_constitution/constitution.md",
            title: "Constitution",
            kind: "document",
            rankingTerms: ["constitution", "constitutional amendment"],
            evidenceExcerpt: "The amendment updates the constitution."
          }, {
            sourceFilePublicId: "source-file-generic",
            sourceRevisionPublicId: "source-revision-generic",
            logicalPath: "general.md",
            title: "General",
            kind: "page",
            rankingTerms: ["document", "general"],
            evidenceExcerpt: "a".repeat(8_192)
          }];
        }
      },
      model: {
        analyze
      }
    });
    const body = [
      "# Constitutional Amendment 1993",
      "",
      "This amendment revises the Constitution and records the 1993 changes."
    ].join("\n");
    const contentProfile = buildSourceContentProfile({
      title: "Constitutional Amendment 1993",
      body,
      metadata: {},
      suggestions: null,
      tokenizer: testLexicalTokenizer
    });

    const result = await run({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-file-amendment",
      sourceRevisionPublicId: "source-revision-amendment",
      logicalPath: "01_constitution/amendment-1993.md",
      title: "Constitutional Amendment 1993",
      type: "document",
      tags: [],
      body,
      metadata: {},
      contentProfile,
      modelName: "general-model",
      candidateLimit: 16,
      acceptedEdgeLimit: 8,
      genericPhraseThreshold: 4,
      signal: new AbortController().signal
    });

    expect(events).toEqual(["candidates", "analyze"]);
    expect(result.contentProfile.keywords).toContain("constitutional");
    expect(result.relationCandidates).toEqual([
      expect.objectContaining({
        target: "01_constitution/constitution.md",
        targetSourceFilePublicId: "source-file-constitution",
        relationType: "version_relation",
        confidence: 0.94,
        source: "model_confirmed"
      })
    ]);
    expect(result.relationCandidates[0]!.sourceExcerpt)
      .toContain("Constitution");
    expect(result.evaluatedCandidates.map((candidate) =>
      candidate.sourceRevisionPublicId)).toEqual([
      "source-revision-constitution",
      "source-revision-generic"
    ]);
    expect(result.graphSignals).toEqual({
      acceptedEdgeCount: 1,
      inboundEdgeCount: 0,
      outboundEdgeCount: 1,
      distinctNeighborCount: 1,
      relationKindCount: 1
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("does not create a relationship from generic shared terms", async () => {
    const run = createDocumentModelGraphEnrichment({
      tokenizer: testLexicalTokenizer,
      candidates: {
        async find() {
          return [{
            sourceFilePublicId: "source-file-general",
            sourceRevisionPublicId: "source-revision-general",
            logicalPath: "general.md",
            title: "General",
            kind: "page",
            rankingTerms: ["document", "general", "content"],
            evidenceExcerpt: "General content."
          }];
        }
      },
      model: {
        async analyze() {
          return {
            suggestions: {
              title: "Overview",
              type: "page",
              description: "General content.",
              tags: [],
              keywords: []
            },
            confirmations: [],
            warnings: [],
            execution: modelExecution()
          };
        }
      }
    });
    const body = "# Overview\n\nThis document contains general content.";
    const contentProfile = buildSourceContentProfile({
      title: "Overview",
      body,
      metadata: {},
      suggestions: null,
      tokenizer: testLexicalTokenizer
    });

    const result = await run({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-file-overview",
      sourceRevisionPublicId: "source-revision-overview",
      logicalPath: "overview.md",
      title: "Overview",
      type: "page",
      tags: [],
      body,
      metadata: {},
      contentProfile,
      modelName: "general-model",
      candidateLimit: 16,
      acceptedEdgeLimit: 8,
      genericPhraseThreshold: 4,
      signal: new AbortController().signal
    });

    expect(result.relationCandidates).toEqual([]);
    expect(result.graphSignals.acceptedEdgeCount).toBe(0);
  });

  it("sends only newly visible activation candidates to a small relationship call", async () => {
    const body = [
      "# Constitutional Amendment 1993",
      "",
      "This amendment revises the Constitution and records the 1993 changes."
    ].join("\n");
    const contentProfile = buildSourceContentProfile({
      title: "Constitutional Amendment 1993",
      body,
      metadata: {},
      suggestions: {
        title: "Constitutional Amendment 1993",
        type: "amendment",
        description: "A 1993 constitutional amendment.",
        tags: ["constitution"],
        keywords: ["constitutional amendment"]
      },
      tokenizer: testLexicalTokenizer
    });
    const request = {
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-file-amendment",
      sourceRevisionPublicId: "source-revision-amendment",
      logicalPath: "01_constitution/amendment-1993.md",
      title: "Constitutional Amendment 1993",
      type: "document",
      tags: [],
      body,
      metadata: {},
      contentProfile,
      modelName: "general-model",
      candidateLimit: 16,
      acceptedEdgeLimit: 8,
      genericPhraseThreshold: 4,
      signal: new AbortController().signal
    };

    const confirm = vi.fn(async (modelRequest: {
      candidates: readonly { sourceFilePublicId: string }[];
    }) => ({
      confirmations: modelRequest.candidates.map((candidate) => ({
        targetFileId: candidate.sourceFilePublicId,
        accepted: true,
        relationType: "version_relation",
        weight: 0.96,
        reason: "Constitutional Amendment 1993 and Constitution are visible versions of the same work."
      })),
      warnings: []
    }));
    const runDelta = createDocumentModelRelationshipDeltaEnrichment({
      model: { confirm }
    });
    const result = await runDelta({
      request,
      contentProfile,
      suggestions: null,
      candidates: [{
        sourceFilePublicId: "source-file-constitution",
        sourceRevisionPublicId: "source-revision-constitution",
        logicalPath: "01_constitution/constitution.md",
        title: "Constitution",
        kind: "document",
        rankingTerms: ["constitution", "constitutional amendment"],
        evidenceExcerpt: "The amendment updates the constitution."
      }]
    });

    expect(result).toEqual([expect.objectContaining({
      targetSourceFilePublicId: "source-file-constitution",
      relationType: "version_relation",
      source: "model_confirmed",
      confidence: 0.96
    })]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0].candidates).toHaveLength(1);
  });

  it("keeps a hybrid-retrieved candidate eligible when its title is absent from the source body", async () => {
    const body = [
      "# Coastal equipment upkeep",
      "",
      "This note explains routine maintenance for instruments exposed to salt air."
    ].join("\n");
    const contentProfile = buildSourceContentProfile({
      title: "Coastal equipment upkeep",
      body,
      metadata: {},
      suggestions: null,
      tokenizer: testLexicalTokenizer
    });
    const confirm = vi.fn(async (_request: {
      edges: readonly { toFileId: string; relationType: string }[];
    }) => ({
      confirmations: [{
        targetFileId: "source-file-weather-station",
        accepted: true,
        relationType: "same_specific_subject",
        weight: 0.91,
        reason: "Coastal equipment upkeep and Maritime Weather Station Maintenance describe the same specific maintenance task."
      }],
      warnings: []
    }));
    const runDelta = createDocumentModelRelationshipDeltaEnrichment({
      model: { confirm }
    });

    const result = await runDelta({
      request: {
        knowledgeBaseId: "knowledge-base-a",
        sourceFilePublicId: "source-file-coastal-upkeep",
        sourceRevisionPublicId: "source-revision-coastal-upkeep",
        logicalPath: "guides/coastal-equipment-upkeep.md",
        title: "Coastal equipment upkeep",
        type: "document",
        tags: [],
        body,
        metadata: {},
        contentProfile,
        modelName: "general-model",
        candidateLimit: 16,
        acceptedEdgeLimit: 8,
        genericPhraseThreshold: 4,
        signal: new AbortController().signal
      },
      contentProfile,
      suggestions: null,
      candidates: [{
        sourceFilePublicId: "source-file-weather-station",
        sourceRevisionPublicId: "source-revision-weather-station",
        logicalPath: "operations/maritime-weather-station-maintenance.md",
        title: "Maritime Weather Station Maintenance",
        kind: "document",
        rankingTerms: ["meteorological instruments", "salt air maintenance"],
        evidenceExcerpt: "Inspect and maintain exposed meteorological instruments near the sea.",
        retrievalScore: 0.032,
        retrievalFamilies: ["lexical", "content_vector"]
      }]
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0].edges).toEqual([
      expect.objectContaining({
        toFileId: "source-file-weather-station",
        relationType: "retrieval_candidate"
      })
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        targetSourceFilePublicId: "source-file-weather-station",
        targetSourceRevisionPublicId: "source-revision-weather-station",
        relationType: "same_specific_subject",
        source: "model_confirmed"
      })
    ]);
  });

});

function modelExecution() {
  return {
    firstLayer: {
      ownerIdentity: "document-model-analysis-a",
      reused: false,
      providerRequestCount: 1,
      waitTimeMs: 0,
      serviceTimeMs: 1
    },
    candidateDelta: {
      ownerIdentity: "relationship-set-a",
      reusedDecisionCount: 0,
      evaluatedDecisionCount: 1,
      providerRequestCount: 0,
      waitTimeMs: 0,
      serviceTimeMs: 0
    }
  };
}
