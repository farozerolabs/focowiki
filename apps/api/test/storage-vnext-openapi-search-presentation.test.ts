import { describe, expect, it } from "vitest";
import {
  assertOpenApiPublicFilePath,
  openApiNoCandidateSearchHints,
  presentOpenApiGraphOverview,
  presentOpenApiRelationship,
  presentOpenApiGeneratedFile,
  presentOpenApiSearchResult
} from "../src/storage-vnext/api/openapi-presenters.js";

describe("storage vNext OpenAPI search presentation", () => {
  it("rejects non-public generated paths before storage lookup", () => {
    expect(() => assertOpenApiPublicFilePath("pages/guide.md")).not.toThrow();
    expect(() => assertOpenApiPublicFilePath(
      "_index/pages/index-extension-leaf-a.md"
    )).not.toThrow();
    expect(() => assertOpenApiPublicFilePath(
      "_graph/by-file/index-extension-leaf-b.md"
    )).not.toThrow();
    expect(() => assertOpenApiPublicFilePath(
      "_index/pages/index-map-000001.md"
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
      activeContentRevision: 1,
      mode: "graph",
      depth: 1,
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
        graphRef: "_graph/by-file/a.json",
        depth: 1,
        seedSourceFileId: "file-a",
        relationships: [{
          fileId: "file-b",
          path: "pages/b.md"
        }],
        graphPaths: [
          "_graph/by-file/a.json",
          "_graph/by-file/b.json"
        ]
      }
    });
  });

  it("does not present a search excerpt as document metadata", () => {
    const withoutDescription = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      activeContentRevision: 1,
      mode: "file",
      depth: 0,
      item: {
        publicId: "file-a",
        sourceFilePublicId: "file-a",
        logicalPath: "pages/a.md",
        title: "Alpha",
        snippet: "A matching excerpt from the Markdown body.",
        score: 1,
        kind: "file",
        metadata: {}
      },
      relationships: []
    });
    const withDescription = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      activeContentRevision: 1,
      mode: "file",
      depth: 0,
      item: {
        publicId: "file-b",
        sourceFilePublicId: "file-b",
        logicalPath: "pages/b.md",
        title: "Beta",
        snippet: "A different matching excerpt.",
        score: 1,
        kind: "file",
        metadata: { description: "Authored document description." }
      },
      relationships: []
    });

    expect(withoutDescription.description).toBeNull();
    expect(withoutDescription.sourceExcerpt).toBe(
      "A matching excerpt from the Markdown body."
    );
    expect(withDescription.description).toBe("Authored document description.");
  });

  it("keeps absent relationship reasons null instead of inventing evidence", () => {
    const result = presentOpenApiRelationship("kb-a", 1, {
      public_id: "edge-a-b",
      source_file_public_id: "file-b",
      logical_path: "pages/b.md",
      title: "Beta",
      relation: "related",
      weight: 1,
      reason: null,
      direction: "outgoing"
    });

    expect(result.reason).toBeNull();
  });

  it("reports an empty relationship graph when files exist without relationships", () => {
    expect(presentOpenApiGraphOverview({
      knowledgeBaseId: "kb-a",
      activeContentRevision: 1,
      nodeCount: 3,
      edgeCount: 0,
      graphIndexAvailable: true
    }).availability).toBe("empty");
  });

  it("presents generated-file read actions with the released OpenAPI field names", () => {
    const result = presentOpenApiGeneratedFile("kb-a", 1, {
      id: "generated-a",
      logicalPath: "pages/a.md"
    });

    expect(result.readActions).toEqual({
      fileDetailById: "/openapi/v2/knowledge-bases/kb-a/files/generated-a",
      fileContentById: "/openapi/v2/knowledge-bases/kb-a/files/generated-a/content",
      fileContentByPath:
        "/openapi/v2/knowledge-bases/kb-a/files/content?path=pages%2Fa.md",
      relatedFilesById: null,
      graphExpansionByFileId: null,
      sourceFileStatusById: null
    });
  });

  it("uses the source-declared title before the storage filename title", () => {
    const result = presentOpenApiGeneratedFile("kb-a", 1, {
      id: "generated-overview",
      logicalPath: "pages/overview.md",
      title: "overview",
      frontmatter: { title: "Habitat Overview" }
    });

    expect(result.title).toBe("Habitat Overview");
    expect(presentOpenApiGeneratedFile("kb-a", 1, {
      id: "generated-heading",
      logicalPath: "pages/heading.md",
      title: "heading"
    }, "# Field Operations\n\nBody").title).toBe("Field Operations");
  });

  it("keeps excluded source runtime assets as metadata without readable-file actions", () => {
    const result = presentOpenApiGeneratedFile("kb-a", 1, {
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
      activeContentRevision: 1,
      mode: "hybrid",
      depth: 1,
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
      description: null,
      sourceExcerpt: "readable source evidence"
    });
  });

  it("presents semantic-only evidence truthfully as a readable source file", () => {
    const result = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      activeContentRevision: 1,
      mode: "hybrid",
      depth: 1,
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
        activeContentRevision: 1,
        mode: "hybrid",
        depth: 1,
        item: { ...base, evidenceFamilies },
        relationships: []
      }).matchType;

    expect(present(["lexical"])).toBe("file_direct");
    expect(present(["file_graph"])).toBe("graph_neighbor");
    expect(present(["relationship_vector"])).toBe("graph_edge");
    expect(present(["entity_vector"])).toBe("graph_node");
    expect(present(["lexical", "entity_vector"])).toBe("hybrid");
  });

  it("reports graph-node and metadata evidence without inventing a relationship", () => {
    const graphResult = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      activeContentRevision: 1,
      mode: "hybrid",
      depth: 1,
      item: {
        publicId: "file-a",
        sourceFilePublicId: "file-a",
        logicalPath: "pages/a.md",
        title: "Alpha",
        snippet: "Alpha",
        score: 1,
        kind: "file",
        metadata: {},
        evidenceFamilies: ["file_graph"],
        matchedFields: ["graph_node"],
        evidenceTypes: ["graph_node"]
      } as Parameters<typeof presentOpenApiSearchResult>[0]["item"],
      relationships: []
    });
    const metadataResult = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      activeContentRevision: 1,
      mode: "file",
      depth: 0,
      item: {
        publicId: "file-metadata",
        sourceFilePublicId: "file-metadata",
        logicalPath: "pages/metadata.md",
        title: "Metadata",
        snippet: "research",
        score: 1,
        kind: "file",
        metadata: { tags: ["research"] },
        evidenceFamilies: ["lexical"],
        matchedFields: ["metadata"],
        evidenceTypes: ["metadata"]
      } as Parameters<typeof presentOpenApiSearchResult>[0]["item"],
      relationships: []
    });

    expect(graphResult).toMatchObject({
      matchedFields: ["graph_node"],
      evidenceTypes: ["graph_node"],
      graphContext: { relationships: [] }
    });
    expect(metadataResult).toMatchObject({
      matchedFields: ["metadata"],
      evidenceTypes: ["metadata"]
    });
  });
});
