import { describe, expect, it } from "vitest";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument
} from "../src/storage-vnext/search/documents.js";

describe("storage vNext minimal search document schemas", () => {
  it("keeps one file-level content document for title, path, and metadata search", () => {
    const document = createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/cache.md",
      fileKind: "page",
      title: "Cache recovery",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: '{"owner":"platform"}'
    });

    expect(document).toEqual({
      id: expect.stringMatching(/^content-[a-f0-9]{64}$/u),
      schemaVersion: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
      documentKind: "content",
      contentKind: "file",
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/cache.md",
      fileKind: "page",
      title: "Cache recovery",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: '{"owner":"platform"}'
    });
  });

  it("keeps a body segment limited to search, snippet, identity, revision, and path fields", () => {
    const document = createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/cache.md",
      fileKind: "page",
      title: "Cache recovery",
      contentKind: "segment",
      segmentOrdinal: 3,
      headingAncestors: ["Recovery", "Verification"],
      searchText: "Verify the restored cache."
    });

    expect(Object.keys(document).sort()).toEqual([
      "contentKind",
      "documentKind",
      "fileKind",
      "headingAncestors",
      "id",
      "knowledgeBaseId",
      "logicalPath",
      "schemaVersion",
      "searchText",
      "segmentOrdinal",
      "sourceFilePublicId",
      "sourceRevisionPublicId",
      "title"
    ]);
    expect(JSON.stringify(document)).not.toMatch(
      /metadata(?:Text)?|checksum|segmentTotal|visibleFrom|visibleUntil|sourceUrl/u
    );
  });

  it("uses one bounded graph-seed search field and one ranking-term field", () => {
    const document = createStorageVnextGraphSeedDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/cache.md",
      title: "Cache recovery",
      searchText: "cache restore dependency",
      rankingTerms: ["restore", "cache", "restore", "  dependency  "]
    });

    expect(document).toEqual({
      id: expect.stringMatching(/^graph-seed-[a-f0-9]{64}$/u),
      schemaVersion: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION,
      documentKind: "graph_seed",
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guides/cache.md",
      title: "Cache recovery",
      searchText: "cache restore dependency",
      rankingTerms: ["cache", "dependency", "restore"]
    });
    expect(JSON.stringify(document)).not.toMatch(
      /lexicalText|exactTerms|phraseTerms|explicitReferences|fingerprint|checksum/u
    );
  });

  it("rejects mismatched content kind and segment identity", () => {
    expect(() => createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      fileKind: "page",
      title: "A",
      contentKind: "file",
      segmentOrdinal: 0,
      headingAncestors: [],
      searchText: ""
    })).toThrow("File-level search documents must not have a segment ordinal");

    expect(() => createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      fileKind: "page",
      title: "A",
      contentKind: "segment",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "body"
    })).toThrow("Segment search documents require a nonnegative ordinal");
  });
});
