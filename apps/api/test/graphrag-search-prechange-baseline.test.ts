import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REQUIRED_GENERATED_NAVIGATION_PATHS } from "../src/okf/generated-graph-resources.js";
import { STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES } from "../src/storage-vnext/publication/profile.js";
import { createStorageVnextCandidateQueryMatrix } from "../src/storage-vnext/search/candidate-query-matrix.js";
import { createStorageVnextContentDocument } from "../src/storage-vnext/search/documents.js";
import { SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE } from
  "../src/application/ports/search-provider-runtime.js";
import { readDeveloperFileSearchFilters } from
  "../src/developer-openapi/file-search-filters.js";

type Baseline = {
  publicStructure: {
    generatedGraphFixture: {
      path: string;
      sha256: string;
    };
    requiredNavigationPaths: string[];
    extensionDirectories: string[];
    stableLeafPattern: string;
    deprecatedLeafPattern: string;
  };
  developerOpenApi: {
    rawSnapshotSha256: string;
  };
  retrieval: {
    naturalLanguageContract: {
      fileSearchCharacterBounds: [number, number];
      fileSearchDownstreamByteLimit: number;
      graphExpansionCharacterBounds: [number, number];
      graphExpansionByteLimit: null;
      omittedMode: string;
      sharedPaginationDefault: number;
      sharedPaginationMaximum: number;
      normalization: string;
      unsafeControlsRejected: boolean;
    };
    semanticFilterContract: {
      okfFiltersDisableSemanticSearch: boolean;
      safeCode: string;
      fileKindIsNotCarriedBySemanticVectorDocuments: boolean;
      scopeIsNotCarriedIntoSemanticLanePlanning: boolean;
    };
    presentationContract: {
      matchedFieldsWithSnippet: string[];
      matchedFieldsWithoutSnippet: string[];
      evidenceFamiliesAreNotPublic: boolean;
      sourceExcerptUsesFirstSemanticExplanation: boolean;
      semanticStatusStates: string[];
    };
    vectorThresholdContract: {
      minimumRelevanceScore: number;
      configurationOwner: string;
      queryPolicyRevisionSeparated: boolean;
    };
    fusionContract: {
      rrfConstant: number;
      weights: Record<string, number>;
      stableTieBreaker: string;
      communityDiversity: boolean;
    };
    rerankerContract: {
      configuredModelRole: boolean;
      requestControls: string[];
      publicStatus: boolean;
      runtimeStage: boolean;
    };
    minimumRecall: number;
    minimumNdcg: number;
    duplicateTitle: {
      query: string;
      relevantSourceFilePublicIds: string[];
      requiredCases: string[];
    };
  };
  performance: {
    fullPerChunkIndexingSample: {
      elapsedMs: number;
      generationRequests: number;
      generationRequestsPerMinute: number;
      averageChunksPerSource: number;
      projectedFileCount: number;
      projectedGenerationRequests: number;
      mandatorySourceGenerationRequestsPerFile: number;
      projectedMandatorySourceGenerationRequests: number;
      projectedTotalGenerationRequestLowerBound: number;
      projectedCompletionMs: number;
      projectedCompletionDays: number;
      observedBottlenecks: string[];
      notCaptured: string[];
    };
    sparseSkeletonPilot: {
      comparableToFullPerChunkBaseline: boolean;
      incomparabilityReasons: string[];
      sampleFileCount: number;
      sourceCoverage: {
        readySources: number;
        contentVectorSources: number;
        contentEmbeddingInputs: number;
        selectedSources: number;
        selectedSourceRatio: number;
        selectedChunks: number;
      };
      stageTiming: Record<string, {
        workItems: number;
        queueToTerminalWallMs: number;
        serviceTimeMs: number;
      }>;
      generation: {
        preSemanticSourceSuggestionRequests: null;
        preSemanticGraphReviewRequests: null;
        graphRagRequests: number;
        graphRagInputChunks: number;
        graphRagServiceTimeMs: null;
      };
      embedding: {
        providerRequests: null;
        inputs: number;
        verifiedArtifacts: Record<string, number>;
      };
      publication: {
        publicationOperations: number;
        completedBuilds: number;
        failedBuilds: number;
        survivingActiveRoots: number;
      };
      retries: {
        stageRetryStateCount: number;
        manualSourceRetries: number;
        failedVectorWorkItems: number;
      };
      resources: { peakCpuPercent: null; peakRssBytes: null };
      retrievalMetrics: null;
      fileCountOnlyProjection: {
        projectedFileCount: number;
        extractionCompletionMs: number;
        extractionCompletionHours: number;
        fullPipelineCompletionMs: number;
        fullPipelineCompletionHours: number;
        speedupOverFullPerChunkBaseline: number;
        acceptedForRelease: boolean;
      };
    };
  };
};

type OpenApiSchema = {
  properties: Record<string, unknown>;
  required: string[];
};

type OpenApiParameter = {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
};

type SearchExample = {
  query: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  resultSummary: Record<string, unknown>;
  semanticStatus?: unknown;
  evidenceStatus?: unknown;
  rerankerStatus?: unknown;
};

const APPROVED_SEMANTIC_PROCESSING_STAGES = [
  "graphrag_processing",
  "semantic_reconciliation",
  "embedding_generation",
  "affected_projection",
  "search_publication",
  "semantic_maintenance_required"
] as const;

const ADDED_GRAPH_TRAVERSAL_FIELDS = new Set([
  "x-validation-detail-codes",
  "fromFileId",
  "relationshipDepth"
]);

function removeAddedGraphTraversalFields(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) => count + removeAddedGraphTraversalFields(item),
      0
    );
  }
  if (typeof value !== "object" || value === null) return 0;

  let removed = 0;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (ADDED_GRAPH_TRAVERSAL_FIELDS.has(key)) {
      delete record[key];
      removed += 1;
      continue;
    }
    removed += removeAddedGraphTraversalFields(record[key]);
  }
  return removed;
}

function removeApprovedSemanticProcessingStages(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) => count + removeApprovedSemanticProcessingStages(item),
      0
    );
  }
  if (typeof value !== "object" || value === null) return 0;

  let changedEnums = 0;
  const record = value as Record<string, unknown>;
  for (const [key, nestedValue] of Object.entries(record)) {
    if (
      key === "enum"
      && Array.isArray(nestedValue)
      && nestedValue.some((item) =>
        APPROVED_SEMANTIC_PROCESSING_STAGES.includes(
          item as (typeof APPROVED_SEMANTIC_PROCESSING_STAGES)[number]
        )
      )
    ) {
      expect(nestedValue.filter((item) =>
        APPROVED_SEMANTIC_PROCESSING_STAGES.includes(
          item as (typeof APPROVED_SEMANTIC_PROCESSING_STAGES)[number]
        )
      )).toEqual(APPROVED_SEMANTIC_PROCESSING_STAGES);
      record[key] = nestedValue.filter((item) =>
        !APPROVED_SEMANTIC_PROCESSING_STAGES.includes(
          item as (typeof APPROVED_SEMANTIC_PROCESSING_STAGES)[number]
        )
      );
      changedEnums += 1;
      continue;
    }
    changedEnums += removeApprovedSemanticProcessingStages(nestedValue);
  }
  return changedEnums;
}

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const baseline = JSON.parse(readFileSync(resolve(
  workspaceRoot,
  "scripts/validation/fixtures/graphrag-search-prechange-baseline.json"
), "utf8")) as Baseline;

describe("GraphRAG search pre-change baseline", () => {
  it("records the measured full-per-chunk bottleneck without inventing missing telemetry", () => {
    const sample = baseline.performance.fullPerChunkIndexingSample;
    expect(sample.generationRequests / (sample.elapsedMs / 60_000))
      .toBeCloseTo(sample.generationRequestsPerMinute, 12);
    expect(sample.projectedGenerationRequests
      / sample.generationRequestsPerMinute * 60_000)
      .toBeCloseTo(sample.projectedCompletionMs, -3);
    expect(sample.projectedFileCount).toBe(20_000);
    expect(sample.mandatorySourceGenerationRequestsPerFile).toBe(1);
    expect(sample.projectedMandatorySourceGenerationRequests).toBe(20_000);
    expect(sample.projectedTotalGenerationRequestLowerBound).toBe(
      sample.projectedGenerationRequests + sample.projectedMandatorySourceGenerationRequests
    );
    expect(sample.projectedCompletionDays).toBeGreaterThan(16);
    expect(sample.observedBottlenecks).toEqual(expect.arrayContaining([
      "generation_per_source_base_enrichment",
      "generation_per_chunk",
      "embedding_one_input_per_request",
      "same_knowledge_base_extraction_parallelism_two",
      "whole_stage_scarce_permit_retention",
      "publication_rebuild_per_interval"
    ]));
    expect(sample.notCaptured).toEqual(expect.arrayContaining([
      "indexing_peak_cpu",
      "indexing_peak_rss",
      "source_enrichment_generation_service_time",
      "source_coverage",
      "retrieval_quality"
    ]));
  });

  it("freezes the first sparse pilot without promoting incomplete evidence", () => {
    const sample = baseline.performance.sparseSkeletonPilot;
    expect(sample.comparableToFullPerChunkBaseline).toBe(false);
    expect(sample.sourceCoverage.readySources).toBe(sample.sampleFileCount);
    expect(sample.sourceCoverage.contentVectorSources).toBe(sample.sampleFileCount);
    expect(sample.sourceCoverage.selectedSources / sample.sampleFileCount)
      .toBe(sample.sourceCoverage.selectedSourceRatio);
    expect(sample.generation.graphRagRequests)
      .toBe(sample.sourceCoverage.selectedChunks);
    expect(Object.values(sample.embedding.verifiedArtifacts)
      .reduce((total, count) => total + count, 0))
      .toBe(sample.embedding.inputs);
    expect(sample.publication.completedBuilds).toBe(1);
    expect(sample.publication.survivingActiveRoots).toBe(1);
    expect(sample.fileCountOnlyProjection.extractionCompletionMs)
      .toBe(sample.stageTiming.extraction!.queueToTerminalWallMs
        * sample.fileCountOnlyProjection.projectedFileCount / sample.sampleFileCount);
    expect(sample.fileCountOnlyProjection.extractionCompletionHours)
      .toBeCloseTo(sample.fileCountOnlyProjection.extractionCompletionMs / 3_600_000, 12);
    expect(sample.fileCountOnlyProjection.speedupOverFullPerChunkBaseline)
      .toBeCloseTo(
        baseline.performance.fullPerChunkIndexingSample.projectedCompletionMs
          / sample.fileCountOnlyProjection.extractionCompletionMs,
        12
      );
    expect(sample.fileCountOnlyProjection.acceptedForRelease).toBe(false);
    expect(sample.resources).toEqual({ peakCpuPercent: null, peakRssBytes: null });
    expect(sample.retrievalMetrics).toBeNull();
  });
  it("pins the released public navigation and stable leaf scheme", () => {
    expect(REQUIRED_GENERATED_NAVIGATION_PATHS)
      .toEqual(baseline.publicStructure.requiredNavigationPaths);
    expect(STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES)
      .toEqual(baseline.publicStructure.extensionDirectories);
    expect(baseline.publicStructure.stableLeafPattern)
      .toBe("index-<stable-leaf-id>.md");
    expect(baseline.publicStructure.deprecatedLeafPattern)
      .toBe("index-map-<number>.md");
  });

  it("pins the complete released generated graph fixture", () => {
    const fixture = readFileSync(resolve(
      workspaceRoot,
      baseline.publicStructure.generatedGraphFixture.path
    ));
    expect(createHash("sha256").update(fixture).digest("hex"))
      .toBe(baseline.publicStructure.generatedGraphFixture.sha256);
  });

  it("pins the exact released Developer OpenAPI bytes", () => {
    const snapshot = JSON.parse(readFileSync(resolve(
      workspaceRoot,
      "docs/public/openapi/focowiki-openapi.json"
    ), "utf8")) as {
      components: { schemas: Record<string, OpenApiSchema> };
      paths: Record<string, { get: {
        description: string;
        parameters: OpenApiParameter[];
        responses: Record<string, {
          content: Record<string, { example: SearchExample }>;
        }>;
      } }>;
    };
    const searchResult = snapshot.components.schemas.FileSearchResult;
    const searchQueryContext = snapshot.components.schemas.FileSearchQueryContext;
    const searchResponse = snapshot.components.schemas.FileSearchResponse;
    expect(searchResult).toBeDefined();
    expect(searchQueryContext).toBeDefined();
    expect(searchResponse).toBeDefined();
    if (!searchResult || !searchQueryContext || !searchResponse) {
      throw new Error("Required file-search OpenAPI schemas are missing");
    }

    const matchedFields = asRecord(searchResult.properties.matchedFields);
    const matchedFieldItems = asRecord(matchedFields.items);
    expect(matchedFieldItems.enum).toEqual([
      "path",
      "title",
      "description",
      "metadata",
      "content",
      "file_relationship"
    ]);
    matchedFieldItems.enum = ["path", "title", "description", "metadata"];
    expect(searchResult.properties.evidenceTypes).toBeDefined();
    expect(searchResult.properties.sourceExcerpt).toBeDefined();
    delete searchResult.properties.evidenceTypes;
    delete searchResult.properties.sourceExcerpt;
    searchResult.required = searchResult.required.filter((field) =>
      field !== "evidenceTypes" && field !== "sourceExcerpt"
    );
    asRecord(searchResult.properties.matchType).description =
      "Reason this result matched, such as file content, a relationship node, or a related file.";

    for (const field of ["rerank", "rerankTopK", "rerankScoreThreshold"] as const) {
      expect(searchQueryContext.properties[field]).toBeDefined();
      delete searchQueryContext.properties[field];
    }
    searchQueryContext.required = searchQueryContext.required.filter((field) =>
      field !== "rerank" && field !== "rerankTopK" && field !== "rerankScoreThreshold"
    );

    expect(searchResponse.properties.semanticStatus).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        state: {
          type: "string",
          enum: ["ready", "degraded", "unavailable"],
          description: "Availability of optional semantic search lanes for this response."
        },
        safeCode: {
          anyOf: [
            {
              type: "string",
              enum: [
                "SEMANTIC_ADOPTION_REQUIRED",
                "SEMANTIC_LEXICAL_PROJECTION_UNAVAILABLE",
                "SEMANTIC_PROVIDER_ADOPTION_REQUIRED",
                "SEMANTIC_SEARCH_UNAVAILABLE",
                "SEMANTIC_LANE_PARTIAL_FAILURE"
              ]
            },
            { type: "null" }
          ],
          description: "Stable non-sensitive reason code when semantic search is degraded or unavailable."
        }
      },
      required: ["state", "safeCode"]
    });
    asRecord(asRecord(searchResponse.properties.semanticStatus).properties).safeCode = {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Stable non-sensitive reason code when semantic search is degraded or unavailable."
    };
    expect(searchResponse.properties.evidenceStatus).toBeDefined();
    expect(searchResponse.properties.rerankerStatus).toBeDefined();
    expect(searchResponse.required).toEqual(expect.arrayContaining([
      "semanticStatus",
      "evidenceStatus",
      "rerankerStatus"
    ]));
    delete searchResponse.properties.semanticStatus;
    delete searchResponse.properties.evidenceStatus;
    delete searchResponse.properties.rerankerStatus;
    searchResponse.required = searchResponse.required.filter((field) =>
      field !== "semanticStatus" && field !== "evidenceStatus" && field !== "rerankerStatus"
    );
    const searchStatus = asRecord(searchResponse.properties.searchStatus);
    searchStatus.enum = ["ok", "no_candidates", "index_unavailable"];
    searchStatus.description =
      "`ok` means results are returned. `no_candidates` means the current query matched no files. `index_unavailable` means file search is not available for this knowledge base yet.";
    const graphSummaryProperties = asRecord(
      asRecord(searchResponse.properties.graphSummary).properties
    );
    asRecord(graphSummaryProperties.indexedDocumentCount).description =
      "Number of published files available to relationship search.";
    asRecord(graphSummaryProperties.indexedRelationshipCount).description =
      "Number of file relationships available to relationship search.";

    searchQueryContext.properties.query = {
      type: "string",
      description: "Original search phrase received by the endpoint."
    };
    asRecord(searchQueryContext.properties.graphDepth).description =
      "Number of relationship levels included in this search.";

    const relatedFile = snapshot.components.schemas.RelatedFile;
    expect(relatedFile).toBeDefined();
    if (!relatedFile) throw new Error("RelatedFile OpenAPI schema is missing");
    asRecord(relatedFile.properties.direction).description =
      "Relationship direction relative to the requested file.";
    relatedFile.required = relatedFile.required.filter((field) =>
      field !== "fromFileId" && field !== "relationshipDepth"
    );

    const searchOperation = snapshot.paths[
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search"
    ]?.get;
    expect(searchOperation).toBeDefined();
    if (!searchOperation) throw new Error("File-search OpenAPI operation is missing");
    expect(searchOperation.description).toContain("standalone natural-language question");
    searchOperation.description = "Search currently published Markdown files by content, metadata, and optional file relationships. Each result includes a file ID and path for reading the complete file. An empty result means the query found no matching files; it does not mean the knowledge base is empty.";

    const queryParameter = requireParameter(searchOperation.parameters, "query");
    expect(queryParameter.schema.maxLength).toBe(512);
    queryParameter.description = "Search text. Titles, headings, file paths, Markdown content, metadata, punctuation variants, and multi-term CJK, Latin, or mixed-script queries are supported.";
    queryParameter.schema.maxLength = 160;
    const scopeParameter = requireParameter(searchOperation.parameters, "scope");
    scopeParameter.description =
      "Fields to search. The default searches file paths, titles, headings, Markdown content, and metadata.";
    const fileKindParameter = requireParameter(searchOperation.parameters, "fileKind");
    fileKindParameter.description = "Published file type filter. The default searches page files.";
    fileKindParameter.schema.enum = [
      "all",
      "page",
      "index",
      "log",
      "schema",
      "manifest_index",
      "manifest_index_shard",
      "search_index",
      "search_index_shard",
      "link_index",
      "link_index_shard",
      "change_index",
      "change_index_shard",
      "graph_index",
      "graph_node_index",
      "graph_edge_shard",
      "graph_file",
      "history_page"
    ];
    const modeParameter = requireParameter(searchOperation.parameters, "mode");
    expect(modeParameter.schema.default).toBe("hybrid");
    modeParameter.description =
      "Search mode. `file` searches file content and metadata, `graph` searches file relationships, and `hybrid` combines both. Every result includes a file ID and path that can be read with the file APIs.";
    modeParameter.schema.default = "file";
    requireParameter(searchOperation.parameters, "graphDepth").description =
      "Number of relationship levels included by graph and hybrid search.";
    requireParameter(searchOperation.parameters, "graphFanout").description =
      "Maximum relationship records returned per graph search item. When omitted, the deployment setting is used.";
    for (const name of ["rerank", "rerankTopK", "rerankScoreThreshold"] as const) {
      expect(requireParameter(searchOperation.parameters, name).name).toBe(name);
    }
    searchOperation.parameters = searchOperation.parameters.filter((parameter) =>
      parameter.name !== "rerank"
      && parameter.name !== "rerankTopK"
      && parameter.name !== "rerankScoreThreshold"
    );
    const limitParameter = requireParameter(searchOperation.parameters, "limit");
    limitParameter.description = "Maximum number of records to return. The deployment can enforce a lower limit.";
    delete limitParameter.schema.maximum;
    delete limitParameter.schema.default;
    const cursorParameter = requireParameter(searchOperation.parameters, "cursor");
    cursorParameter.description = "Pagination token returned by the same endpoint for reading the next page.";

    const searchExample = searchOperation.responses["200"]
      ?.content["application/json"]?.example;
    expect(searchExample?.semanticStatus).toEqual({ state: "ready", safeCode: null });
    expect(searchExample?.evidenceStatus).toBeDefined();
    expect(searchExample?.rerankerStatus).toBeDefined();
    if (searchExample) {
      searchExample.query.query = "guide";
      searchExample.query.normalizedQuery = "guide";
      searchExample.query.okfStatus = "stable";
      searchExample.query.okfTrustTier = "human-reviewed";
      searchExample.query.okfFreshness = "fresh";
      delete searchExample.query.rerank;
      delete searchExample.query.rerankTopK;
      delete searchExample.query.rerankScoreThreshold;
      for (const result of searchExample.items) {
        result.nodeId = result.sourceFileId;
        result.matchedFields = ["path", "title"];
        result.matchType = "hybrid";
        delete result.evidenceTypes;
        delete result.sourceExcerpt;
      }
      asRecord(searchExample.resultSummary).sort = ["score desc", "path asc", "fileId asc"];
      delete searchExample.semanticStatus;
      delete searchExample.evidenceStatus;
      delete searchExample.rerankerStatus;
    }
    const searchRequestExample = asRecord(asRecord(searchOperation)["x-request-example"]);
    const searchRequestQuery = asRecord(searchRequestExample.query);
    searchRequestExample.query = {
      query: "guide",
      scope: searchRequestQuery.scope,
      fileKind: searchRequestQuery.fileKind,
      mode: searchRequestQuery.mode,
      graphDepth: searchRequestQuery.graphDepth,
      graphFanout: searchRequestQuery.graphFanout,
      okfStatus: "stable",
      okfTrustTier: "human-reviewed",
      okfFreshness: "fresh",
      limit: searchRequestQuery.limit
    };

    const graphExpansionOperation = snapshot.paths[
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand"
    ]?.get;
    expect(graphExpansionOperation).toBeDefined();
    if (!graphExpansionOperation) throw new Error("Graph expansion OpenAPI operation is missing");
    const graphQueryParameter = requireParameter(graphExpansionOperation.parameters, "query");
    graphQueryParameter.description =
      "Short query used to find a starting file. Provide only one starting-point parameter.";
    graphQueryParameter.schema.maxLength = 160;

    expect(removeAddedGraphTraversalFields(snapshot)).toBe(10);
    expect(removeApprovedSemanticProcessingStages(snapshot)).toBe(2);
    const releasedSurface = `${JSON.stringify(snapshot, null, 2)}\n`;
    expect(createHash("sha256").update(releasedSurface).digest("hex"))
      .toBe(baseline.developerOpenApi.rawSnapshotSha256);
  });

  it("keeps every same-title source quantitative for exact, title, and ranking", () => {
    const matrix = createStorageVnextCandidateQueryMatrix();
    for (const sourceFilePublicId of baseline.retrieval.duplicateTitle.relevantSourceFilePublicIds) {
      matrix.observe(createStorageVnextContentDocument({
        knowledgeBaseId: "kb-baseline",
        sourceFilePublicId,
        sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
        logicalPath: `pages/${sourceFilePublicId}.md`,
        fileKind: "page",
        title: baseline.retrieval.duplicateTitle.query,
        contentKind: "file",
        segmentOrdinal: null,
        headingAncestors: [],
        searchText: ""
      }));
    }
    const cases = matrix.finish().filter((item) =>
      baseline.retrieval.duplicateTitle.requiredCases.includes(item.kind)
    );
    expect(cases.map((item) => item.kind))
      .toEqual(baseline.retrieval.duplicateTitle.requiredCases);
    for (const item of cases) {
      expect(item.minimumRecall).toBe(baseline.retrieval.minimumRecall);
      expect(item.minimumNdcg).toBe(baseline.retrieval.minimumNdcg);
      expect(item.relevantSources.map((source) => source.sourceFilePublicId))
        .toEqual(baseline.retrieval.duplicateTitle.relevantSourceFilePublicIds);
    }
  });

  it("records the natural-language, filter, presentation, fusion, and reranker baseline", () => {
    expect(readDeveloperFileSearchFilters({
      query: "standalone question",
      scope: undefined,
      fileKind: undefined
    })).toMatchObject({ ok: true, mode: "hybrid" });
    expect(readDeveloperFileSearchFilters({
      query: "x".repeat(513),
      scope: undefined,
      fileKind: undefined
    })).toEqual({ ok: false, code: "FILE_SEARCH_QUERY_TOO_LONG" });
    expect(baseline.retrieval.naturalLanguageContract).toEqual({
      fileSearchCharacterBounds: [2, 160],
      fileSearchDownstreamByteLimit: 512,
      graphExpansionCharacterBounds: [2, 160],
      graphExpansionByteLimit: null,
      omittedMode: "file",
      sharedPaginationDefault: 50,
      sharedPaginationMaximum: 200,
      normalization: "trim_only_at_openapi_boundary",
      unsafeControlsRejected: true
    });
    expect(SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE).toBe(
      baseline.retrieval.vectorThresholdContract.minimumRelevanceScore
    );
    expect(baseline.retrieval.semanticFilterContract).toMatchObject({
      okfFiltersDisableSemanticSearch: true,
      safeCode: "SEMANTIC_FILTERED_SEARCH_UNAVAILABLE"
    });
    expect(baseline.retrieval.presentationContract).toMatchObject({
      matchedFieldsWithSnippet: ["description"],
      matchedFieldsWithoutSnippet: ["title"],
      evidenceFamiliesAreNotPublic: true
    });
    expect(baseline.retrieval.fusionContract).toMatchObject({
      rrfConstant: 60,
      stableTieBreaker: "source_file_public_id",
      communityDiversity: false
    });
    expect(baseline.retrieval.rerankerContract).toEqual({
      configuredModelRole: false,
      requestControls: [],
      publicStatus: false,
      runtimeStage: false
    });
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an OpenAPI object");
  }
  return value as Record<string, unknown>;
}

function requireParameter(
  parameters: OpenApiParameter[],
  name: string
): OpenApiParameter {
  const parameter = parameters.find((item) => item.name === name);
  if (!parameter) throw new Error(`Missing OpenAPI parameter: ${name}`);
  return parameter;
}
