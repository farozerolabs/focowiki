import { describe, expect, it } from "vitest";
import {
  assertOpenApiPublicFilePath,
  openApiNoCandidateSearchHints,
  presentOpenApiGeneratedFile,
  presentOpenApiSearchResult
} from "../src/storage-vnext/api/openapi-presenters.js";

describe("storage vNext OpenAPI search presentation", () => {
  it("rejects non-public generated paths before storage lookup", () => {
    expect(() => assertOpenApiPublicFilePath("pages/guide.md")).not.toThrow();
    expect(() => assertOpenApiPublicFilePath(
      "_index/search/v1/index-extension-leaf-a.md"
    )).not.toThrow();
    expect(() => assertOpenApiPublicFilePath(
      "_graph/by-file/index-extension-leaf-b.md"
    )).not.toThrow();
    expect(() => assertOpenApiPublicFilePath(
      "_index/search/v1/index-map-000001.md"
    )).toThrow();
    expect(() => assertOpenApiPublicFilePath("sources/private.md")).toThrow(
      "This knowledge-base file path is not supported."
    );
  });

  it("preserves released no-candidate exploration guidance", () => {
    expect(openApiNoCandidateSearchHints()).toEqual({
      message:
        "No generated files matched this query. The knowledge base may still contain relevant data through different titles, paths, or metadata terms.",
      nextActions: [
        "Split the user question into shorter terms and search again.",
        "Read index.md through the file content endpoint.",
        "List the file tree and continue exploration from visible directories.",
        "Try title, path, subject, product name, workflow, identifier, or shorter terms from the question.",
        "Use graph or hybrid search mode when a direct file search does not find enough evidence."
      ]
    });
  });

  it("preserves the released graph context and graph-file path contract", () => {
    const result = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      generationId: "root-a",
      mode: "graph",
      depth: 1,
      nodePublicId: "node-a",
      item: {
        publicId: "file-a",
        sourceFilePublicId: "file-a",
        logicalPath: "pages/a.md",
        title: "Alpha",
        snippet: "alpha graph evidence",
        score: 1,
        kind: "graph",
        metadata: {
          type: "Guide",
          tags: ["graph"],
          status: "stable"
        }
      },
      relationships: [{
        public_id: "edge-a-b",
        source_file_public_id: "file-b",
        logical_path: "pages/b.md",
        title: "Beta",
        relation: "direct_reference",
        weight: 1,
        reason: "Alpha links to Beta.",
        direction: "outgoing"
      }]
    });

    expect(result).toMatchObject({
      nodeId: "node-a",
      edgeId: null,
      matchType: "graph_node",
      matchedFields: ["description"],
      tags: ["graph"],
      frontmatter: {
        type: "Guide",
        tags: ["graph"],
        status: "stable"
      },
      okfSignals: {
        effectiveStatus: "stable",
        trustTier: "unverified"
      },
      graphContext: {
        graphRef: "_graph/by-file/file-a.json",
        depth: 1,
        seedSourceFileId: "file-a",
        matchedNodeFields: ["content"],
        matchedRelationshipFields: [],
        relationships: [{
          edgeId: "edge-a-b",
          fileId: "file-b",
          path: "pages/b.md"
        }],
        graphPaths: [
          "_graph/by-file/file-a.json",
          "_graph/by-file/file-b.json"
        ]
      }
    });
  });

  it("presents generated-file read actions with the released OpenAPI field names", () => {
    const result = presentOpenApiGeneratedFile("kb-a", "root-a", {
      id: "generated-a",
      logicalPath: "pages/a.md"
    });

    expect(result.readActions).toEqual({
      fileDetailById: "/openapi/v2/knowledge-bases/kb-a/files/generated-a",
      fileContentById: "/openapi/v2/knowledge-bases/kb-a/files/generated-a/content",
      fileContentByPath:
        "/openapi/v2/knowledge-bases/kb-a/files/content?path=pages%2Fa.md",
      relatedFilesById: "/openapi/v2/knowledge-bases/kb-a/files/generated-a/related",
      graphExpansionByFileId:
        "/openapi/v2/knowledge-bases/kb-a/graph/expand?fileId=generated-a",
      sourceFileStatusById: null,
      sourceFileEventsById: null
    });
  });

  it("keeps excluded source runtime assets as metadata without readable-file actions", () => {
    const result = presentOpenApiGeneratedFile("kb-a", "root-a", {
      id: "generated-computation",
      logicalPath: "pages/computation.md",
      frontmatter: {
        type: "Attested Computation",
        runtime: "python",
        computation: { resource: "references/runtime.py" },
        attester: { resource: "references/attester.py" }
      }
    });

    expect(result.frontmatter).toMatchObject({
      computation: { resource: "references/runtime.py" },
      attester: { resource: "references/attester.py" }
    });
    expect(JSON.stringify(result.readActions)).not.toContain("runtime.py");
    expect(JSON.stringify(result.readActions)).not.toContain("attester.py");
  });

  it("drops semantic implementation details from source-file search results", () => {
    const internalItem = {
      publicId: "file-a",
      sourceFilePublicId: "file-a",
      logicalPath: "pages/a.md",
      title: "Alpha",
      snippet: "readable source evidence",
      score: 1,
      kind: "file",
      metadata: {},
      semanticEntityPublicId: "internal-entity-a",
      vector: [0.1, 0.2],
      providerScore: 0.99,
      prompt: "internal-prompt-a",
      workerDiagnostics: { attempt: 3 },
      databaseIdentity: 42,
      objectKey: "internal-object-key-a",
      candidateFacts: ["internal-candidate-fact-a"]
    } as Parameters<typeof presentOpenApiSearchResult>[0]["item"];
    const result = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      generationId: "root-a",
      mode: "hybrid",
      depth: 1,
      nodePublicId: "node-a",
      item: internalItem,
      relationships: []
    });
    const payload = JSON.stringify(result);

    for (const internalValue of [
      "internal-entity-a",
      "internal-prompt-a",
      "internal-object-key-a",
      "internal-candidate-fact-a",
      "providerScore",
      "workerDiagnostics",
      "databaseIdentity",
      "vector"
    ]) {
      expect(payload).not.toContain(internalValue);
    }
    expect(result).toMatchObject({
      sourceFileId: "file-a",
      path: "pages/a.md",
      description: "readable source evidence"
    });
  });

  it("presents semantic-only evidence truthfully as a readable source file", () => {
    const result = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      generationId: "root-a",
      mode: "hybrid",
      depth: 1,
      nodePublicId: null,
      item: {
        publicId: "file-semantic",
        sourceFilePublicId: "file-semantic",
        logicalPath: "pages/semantic.md",
        title: "Semantic source",
        snippet: "Source-grounded excerpt from the Markdown body.",
        sourceExcerpt: "Source-grounded excerpt from the Markdown body.",
        score: 0.25,
        kind: "file",
        metadata: {},
        evidenceFamilies: ["entity_vector", "relationship_vector"]
      } as Parameters<typeof presentOpenApiSearchResult>[0]["item"],
      relationships: []
    });

    expect(result).toMatchObject({
      fileId: "file-semantic",
      path: "pages/semantic.md",
      matchedFields: ["content"],
      evidenceTypes: ["entity", "relationship"],
      sourceExcerpt: "Source-grounded excerpt from the Markdown body.",
      readActions: {
        fileContentById:
          "/openapi/v2/knowledge-bases/kb-a/files/file-semantic/content"
      }
    });
    expect(result.matchedFields).not.toContain("title");
    expect(result).not.toHaveProperty("answer");
    expect(JSON.stringify(result)).not.toContain("relevance_score");
  });

  it("derives match type from actual evidence instead of the requested mode", () => {
    const base = {
      publicId: "file-a",
      sourceFilePublicId: "file-a",
      logicalPath: "pages/a.md",
      title: "Alpha",
      snippet: null,
      score: 1,
      kind: "file" as const,
      metadata: {}
    };
    const present = (evidenceFamilies: readonly string[]) =>
      presentOpenApiSearchResult({
        knowledgeBaseId: "kb-a",
        generationId: "root-a",
        mode: "hybrid",
        depth: 1,
        nodePublicId: null,
        item: { ...base, evidenceFamilies },
        relationships: []
      }).matchType;

    expect(present(["lexical"])).toBe("file_direct");
    expect(present(["file_graph"])).toBe("graph_neighbor");
    expect(present(["relationship_vector"])).toBe("graph_edge");
    expect(present(["entity_vector"])).toBe("graph_node");
    expect(present(["lexical", "entity_vector"])).toBe("hybrid");
  });
});
