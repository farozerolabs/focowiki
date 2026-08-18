import { describe, expect, it } from "vitest";

import { createDeveloperOpenApiDocument } from
  "../src/developer-openapi/openapi-document.js";
import { readDeveloperFileSearchFilters } from
  "../src/developer-openapi/file-search-filters.js";

describe("natural-language Developer OpenAPI search contract", () => {
  it("normalizes NFKC and whitespace once and defaults omitted mode to hybrid", () => {
    expect(readDeveloperFileSearchFilters({
      query: "  ＡＰＩ\tavailability   policy？  ",
      scope: undefined,
      fileKind: undefined
    })).toMatchObject({
      ok: true,
      query: "API availability policy?",
      mode: "hybrid",
      rerank: false,
      rerankTopK: null,
      rerankScoreThreshold: null
    });
  });

  it.each([
    ["ab", true],
    ["x".repeat(512), true],
    ["x", false],
    ["x".repeat(513), false],
    ["好".repeat(512), true],
    [`${"好".repeat(511)}ab`, false],
    ["safe\u0000unsafe", false],
    ["safe\nunsafe", false]
  ])("applies the shared character, UTF-8 byte, and control bounds", (query, valid) => {
    const result = readDeveloperFileSearchFilters({
      query,
      scope: undefined,
      fileKind: undefined
    });
    expect(result.ok).toBe(valid);
  });

  it.each([
    [{ rerank: undefined }, { rerank: false, topK: null, threshold: null }],
    [{ rerank: "false" }, { rerank: false, topK: null, threshold: null }],
    [{ rerank: "true" }, { rerank: true, topK: 30, threshold: 0.35 }],
    [{ rerank: "true", rerankTopK: "50", rerankScoreThreshold: "0" },
      { rerank: true, topK: 50, threshold: 0 }],
    [{ rerank: "true", rerankTopK: "50", rerankScoreThreshold: "1" },
      { rerank: true, topK: 50, threshold: 1 }]
  ])("parses request-scoped reranker controls", (controls, expected) => {
    const result = readDeveloperFileSearchFilters({
      query: "Which source explains the deployment policy?",
      scope: undefined,
      fileKind: undefined,
      limit: "10",
      ...controls
    } as Parameters<typeof readDeveloperFileSearchFilters>[0] & Record<string, unknown>);
    expect(result).toMatchObject({
      ok: true,
      rerank: expected.rerank,
      rerankTopK: expected.topK,
      rerankScoreThreshold: expected.threshold
    });
  });

  it.each([
    { rerank: "false", rerankTopK: "30" },
    { rerank: "false", rerankScoreThreshold: "0.35" },
    { rerank: "true", rerankTopK: "9", limit: "10" },
    { rerank: "true", rerankTopK: "0", limit: "1" },
    { rerank: "true", rerankTopK: "51" },
    { rerank: "true", rerankTopK: "1.5" },
    { rerank: "true", rerankScoreThreshold: "-0.1" },
    { rerank: "true", rerankScoreThreshold: "1.1" },
    { rerank: "true", rerankScoreThreshold: "NaN" }
  ])("rejects invalid reranker controls before retrieval", (controls) => {
    const result = readDeveloperFileSearchFilters({
      query: "bounded natural-language question",
      scope: undefined,
      fileKind: undefined,
      ...controls
    } as Parameters<typeof readDeveloperFileSearchFilters>[0] & Record<string, unknown>);
    expect(result.ok).toBe(false);
  });

  it("documents search-specific pagination and reranker controls", () => {
    const operation = createDeveloperOpenApiDocument().paths[
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search"
    ]?.get as { parameters?: Array<Record<string, unknown>> } | undefined;
    const parameters = new Map(operation?.parameters?.map((parameter) => [
      "name" in parameter ? parameter.name : "ref",
      parameter
    ]));
    expect(parameters.get("query")).toMatchObject({
      schema: { minLength: 2, maxLength: 512 }
    });
    expect(parameters.get("mode")).toMatchObject({
      schema: { default: "hybrid" }
    });
    expect(parameters.get("limit")).toMatchObject({
      schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    });
    expect(parameters.get("rerank")).toMatchObject({
      schema: { type: "boolean", default: false }
    });
    expect(parameters.get("rerankTopK")).toMatchObject({
      schema: { type: "integer", minimum: 1, maximum: 50 }
    });
    expect(parameters.get("rerankScoreThreshold")).toMatchObject({
      schema: { type: "number", minimum: 0, maximum: 1 }
    });
  });

  it("documents truthful evidence-family and reranker presentation", () => {
    const schemas = createDeveloperOpenApiDocument().components.schemas as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
    expect(schemas.FileSearchResult?.properties).toMatchObject({
      matchedFields: expect.any(Object),
      evidenceTypes: expect.any(Object),
      sourceExcerpt: expect.any(Object),
      readActions: expect.any(Object)
    });
    expect(schemas.FileSearchResult?.required).toEqual(expect.arrayContaining([
      "matchedFields", "evidenceTypes", "sourceExcerpt", "readActions"
    ]));
    expect(schemas.FileSearchQueryContext?.properties).toMatchObject({
      rerank: expect.any(Object),
      rerankTopK: expect.any(Object),
      rerankScoreThreshold: expect.any(Object)
    });
    expect(schemas.FileSearchResponse?.properties).toMatchObject({
      evidenceStatus: expect.any(Object),
      rerankerStatus: expect.any(Object)
    });
  });
});
