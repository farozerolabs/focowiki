import { describe, expect, it } from "vitest";
import {
  deriveStorageVnextReleaseDependencyClosure,
  includeStorageVnextNavigationProfileUpgrade
} from "../src/storage-vnext/release/dependency-closure.js";

describe("storage vNext bounded release dependency closure", () => {
  it("adds one bounded upgrade scope only for a legacy base profile", () => {
    const dependencies = [{
      kind: "index" as const,
      publicId: "index.md",
      reasonCode: "required_navigation"
    }];
    expect(includeStorageVnextNavigationProfileUpgrade({
      knowledgeBaseId: "kb-dependency",
      navigationProfileVersion: 0,
      dependencies
    })).toEqual(expect.arrayContaining([{
      kind: "scope",
      publicId: "kb-dependency",
      reasonCode: "navigation_profile_upgrade"
    }]));
    expect(includeStorageVnextNavigationProfileUpgrade({
      knowledgeBaseId: "kb-dependency",
      navigationProfileVersion: 1,
      dependencies
    })).toBe(dependencies);
  });

  it("derives upload paths, ancestors, search, graph, and frozen root resources", () => {
    const closure = deriveStorageVnextReleaseDependencyClosure({
      knowledgeBaseId: "kb-dependency",
      mutationKind: "upload",
      sourceFilePublicIds: ["file-overview"],
      sourceLogicalPaths: ["Research/Overview.md"],
      previousSourceLogicalPaths: [],
      directoryLogicalPaths: [],
      searchSourceFilePublicIds: ["file-overview"],
      graphSourceFilePublicIds: ["file-overview", "file-system"],
      graphEdgePublicIds: ["edge-overview-system"]
    });

    expect(closure.affectedLogicalPaths).toEqual([
      "pages/Research/Overview.md"
    ]);
    expect(closure.affectedDirectoryPaths).toEqual([
      "pages",
      "pages/Research"
    ]);
    expect(closure.dependencies).toEqual(expect.arrayContaining([
      { kind: "path", publicId: "pages/Research/Overview.md", reasonCode: "source_path" },
      { kind: "ancestor", publicId: "pages", reasonCode: "directory_ancestor" },
      { kind: "ancestor", publicId: "pages/Research", reasonCode: "directory_ancestor" },
      { kind: "search", publicId: "file-overview", reasonCode: "search_document" },
      { kind: "graph", publicId: "file-system", reasonCode: "graph_source" },
      { kind: "link", publicId: "edge-overview-system", reasonCode: "graph_edge" },
      { kind: "index", publicId: "index.md", reasonCode: "required_navigation" },
      { kind: "schema", publicId: "schema.md", reasonCode: "required_schema" },
      { kind: "log", publicId: "log.md", reasonCode: "bounded_update_log" }
    ]));
  });

  it("covers both old and new ancestors for rename and move without duplicates", () => {
    const first = deriveStorageVnextReleaseDependencyClosure({
      knowledgeBaseId: "kb-dependency",
      mutationKind: "move",
      sourceFilePublicIds: ["file-guide", "file-guide"],
      sourceLogicalPaths: ["Guides/New/Guide.md"],
      previousSourceLogicalPaths: ["Manuals/Old/Guide.md"],
      directoryLogicalPaths: ["Guides/New", "Manuals/Old"],
      searchSourceFilePublicIds: ["file-guide"],
      graphSourceFilePublicIds: ["file-guide"],
      graphEdgePublicIds: []
    });
    const replay = deriveStorageVnextReleaseDependencyClosure({
      knowledgeBaseId: "kb-dependency",
      mutationKind: "move",
      sourceFilePublicIds: ["file-guide"],
      sourceLogicalPaths: ["Guides/New/Guide.md"],
      previousSourceLogicalPaths: ["Manuals/Old/Guide.md"],
      directoryLogicalPaths: ["Manuals/Old", "Guides/New"],
      searchSourceFilePublicIds: ["file-guide", "file-guide"],
      graphSourceFilePublicIds: ["file-guide"],
      graphEdgePublicIds: []
    });

    expect(replay).toEqual(first);
    expect(first.affectedLogicalPaths).toEqual([
      "pages/Guides/New/Guide.md",
      "pages/Manuals/Old/Guide.md"
    ]);
    expect(first.affectedDirectoryPaths).toEqual([
      "pages",
      "pages/Guides",
      "pages/Guides/New",
      "pages/Manuals",
      "pages/Manuals/Old"
    ]);
  });

  it("uses one scope dependency for a knowledge-base delete", () => {
    expect(deriveStorageVnextReleaseDependencyClosure({
      knowledgeBaseId: "kb-delete",
      mutationKind: "knowledge_base_delete",
      sourceFilePublicIds: [],
      sourceLogicalPaths: [],
      previousSourceLogicalPaths: [],
      directoryLogicalPaths: [],
      searchSourceFilePublicIds: [],
      graphSourceFilePublicIds: [],
      graphEdgePublicIds: []
    })).toEqual({
      knowledgeBaseId: "kb-delete",
      mutationKind: "knowledge_base_delete",
      dependencies: [{
        kind: "scope",
        publicId: "kb-delete",
        reasonCode: "knowledge_base_delete"
      }],
      affectedSourceFilePublicIds: [],
      affectedLogicalPaths: [],
      affectedDirectoryPaths: []
    });
  });

  it.each([
    {
      mutationKind: "replacement" as const,
      sourceLogicalPaths: ["Guides/Guide.md"],
      previousSourceLogicalPaths: ["Guides/Guide.md"],
      directoryLogicalPaths: [],
      required: ["path:pages/Guides/Guide.md", "search:file-change", "graph:file-change"]
    },
    {
      mutationKind: "rename" as const,
      sourceLogicalPaths: ["Guides/New.md"],
      previousSourceLogicalPaths: ["Guides/Old.md"],
      directoryLogicalPaths: [],
      required: ["path:pages/Guides/New.md", "path:pages/Guides/Old.md"]
    },
    {
      mutationKind: "file_delete" as const,
      sourceLogicalPaths: [],
      previousSourceLogicalPaths: ["Guides/Deleted.md"],
      directoryLogicalPaths: [],
      required: ["path:pages/Guides/Deleted.md", "ancestor:pages/Guides"]
    },
    {
      mutationKind: "directory_delete" as const,
      sourceLogicalPaths: [],
      previousSourceLogicalPaths: [],
      directoryLogicalPaths: ["Guides/Removed"],
      required: ["scope:pages/Guides/Removed", "ancestor:pages/Guides"]
    },
    {
      mutationKind: "graph_change" as const,
      sourceLogicalPaths: [],
      previousSourceLogicalPaths: [],
      directoryLogicalPaths: [],
      required: ["graph:file-change", "graph:edge-change", "link:edge-change"]
    },
    {
      mutationKind: "search_change" as const,
      sourceLogicalPaths: [],
      previousSourceLogicalPaths: [],
      directoryLogicalPaths: [],
      required: ["search:file-change"]
    }
  ])("covers $mutationKind dependency duties", (fixture) => {
    const closure = deriveStorageVnextReleaseDependencyClosure({
      knowledgeBaseId: "kb-dependency",
      mutationKind: fixture.mutationKind,
      sourceFilePublicIds: ["file-change"],
      sourceLogicalPaths: fixture.sourceLogicalPaths,
      previousSourceLogicalPaths: fixture.previousSourceLogicalPaths,
      directoryLogicalPaths: fixture.directoryLogicalPaths,
      searchSourceFilePublicIds: [],
      graphSourceFilePublicIds: [],
      graphEdgePublicIds: fixture.mutationKind === "graph_change" ? ["edge-change"] : []
    });
    const identities = closure.dependencies.map((item) => `${item.kind}:${item.publicId}`);
    expect(identities).toEqual(expect.arrayContaining(fixture.required));
    expect(identities).toEqual(expect.arrayContaining([
      "index:index.md",
      "schema:schema.md",
      "log:log.md"
    ]));
  });

  it("rejects invalid source and directory traversal paths", () => {
    for (const path of ["../escape.md", "/absolute.md", "Guides/../escape.md"]) {
      expect(() => deriveStorageVnextReleaseDependencyClosure({
        knowledgeBaseId: "kb-dependency",
        mutationKind: "file_delete",
        sourceFilePublicIds: ["file-invalid"],
        sourceLogicalPaths: [],
        previousSourceLogicalPaths: [path],
        directoryLogicalPaths: [],
        searchSourceFilePublicIds: [],
        graphSourceFilePublicIds: [],
        graphEdgePublicIds: []
      })).toThrow();
    }
  });
});
