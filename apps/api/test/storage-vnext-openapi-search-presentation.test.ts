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
        kind: "graph"
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
});
