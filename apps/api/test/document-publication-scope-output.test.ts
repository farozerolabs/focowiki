import { describe, expect, it } from "vitest";
import {
  normalizeDocumentPublicationScopeOutput,
  selectDocumentPublicationRemovedPaths,
  selectDocumentPublicationObjectWrites
} from "../src/document-indexing/application/document-publication-scope-output.js";

describe("document publication scope output", () => {
  it("normalizes one owned output independently of completion order", () => {
    const left = normalizeDocumentPublicationScopeOutput(output([
      page("pages/laws/beta.md", "b"),
      page("pages/laws/alpha.md", "a")
    ]));
    const right = normalizeDocumentPublicationScopeOutput(output([
      page("pages/laws/alpha.md", "a"),
      page("pages/laws/beta.md", "b")
    ]));
    expect(left).toEqual(right);
    expect(left.outputFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects page and directory actions outside the owning scope", () => {
    expect(() => normalizeDocumentPublicationScopeOutput({
      ...output([page("_graph/catalog.json", "a")]),
      scope: { kind: "root" as const, key: "index" }
    })).toThrowError(/projection_path_owner_mismatch/u);
    expect(() => normalizeDocumentPublicationScopeOutput({
      ...output([]),
      navigationMutations: [{
        directoryPath: "_graph",
        order: 0,
        action: "upsert" as const,
        mutation: { entries: [] }
      }],
      scope: { kind: "directory" as const, key: "pages/laws" }
    })).toThrowError(/projection_directory_owner_mismatch/u);
  });

  it("reuses only verified immutable objects with matching format", () => {
    expect(selectDocumentPublicationObjectWrites({
      desired: [
        { normalizedPath: "index.md", checksumSha256: "a".repeat(64),
          objectFormat: "okf-generated-markdown-v1" },
        { normalizedPath: "_graph/catalog.json", checksumSha256: "b".repeat(64),
          objectFormat: "okf-generated-json-v1" }
      ],
      existing: [{
        objectId: "generated-a", checksumSha256: "a".repeat(64),
        objectFormat: "okf-generated-markdown-v1", state: "verified"
      }, {
        objectId: "generated-b", checksumSha256: "b".repeat(64),
        objectFormat: "okf-generated-markdown-v1", state: "verified"
      }]
    })).toEqual({
      reused: [{ normalizedPath: "index.md", objectId: "generated-a" }],
      writes: [{ normalizedPath: "_graph/catalog.json",
        checksumSha256: "b".repeat(64),
        objectFormat: "okf-generated-json-v1" }]
    });
  });

  it("turns active owned pages omitted by a tombstone render into deletes", () => {
    expect(selectDocumentPublicationRemovedPaths({
      basePages: [{ normalizedPath: "pages/deleted.md", action: "put" }],
      renderedPaths: [],
      explicitRemovedPaths: [],
      deleteOmittedBasePages: true
    })).toEqual(["pages/deleted.md"]);
    expect(selectDocumentPublicationRemovedPaths({
      basePages: [{ normalizedPath: "pages/current.md", action: "put" }],
      renderedPaths: ["pages/current.md"],
      explicitRemovedPaths: [],
      deleteOmittedBasePages: true
    })).toEqual([]);
  });

  it("preserves untouched navigation leaves from incremental scope renders", () => {
    expect(selectDocumentPublicationRemovedPaths({
      basePages: [{
        normalizedPath: "pages/index-directory-leaf-stable.md",
        action: "put"
      }],
      renderedPaths: ["pages/index.md"],
      explicitRemovedPaths: [],
      deleteOmittedBasePages: false
    })).toEqual([]);
  });
});

function output(pages: ReturnType<typeof page>[]) {
  return {
    scope: { kind: "source" as const, key: "source-1" },
    sourceFilePublicId: "source-1",
    inputSnapshotFingerprintSha256: "1".repeat(64),
    rendererContractVersion: "portable-okf-v2",
    pages,
    navigationMutations: [],
    validationEvidence: { links: 2, graphEdges: 1, searchReady: true }
  };
}

function page(normalizedPath: string, marker: string) {
  return {
    logicalPath: normalizedPath,
    normalizedPath,
    action: "put" as const,
    entryKind: "source-page",
    objectId: `generated-${marker}`,
    checksumSha256: marker.repeat(64),
    byteCount: 64
  };
}
