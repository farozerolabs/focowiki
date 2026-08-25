import { describe, expect, it } from "vitest";
import { assertPortableRecord, type PortableRecordFamily } from "../src/portable-bundle.js";

describe("portable bundle version 2 schema snapshots", () => {
  it("accepts portable records ordered by Unicode scalar value", () => {
    expect(() => assertPortableRecord("term_postings", {
      formatVersion: 2,
      title: "other terms",
      bucket: "other",
      terms: [{
        term: "portable-order",
        postings: [{ path: "pages/\uE000.md", fields: ["body"] },
          { path: "pages/😀.md", fields: ["body"] }]
      }]
    })).not.toThrow();
  });

  it("identifies the duplicated portable record field", () => {
    expect(() => assertPortableRecord("term_postings", {
      formatVersion: 2,
      title: "duplicate terms",
      bucket: "other",
      terms: [{
        term: "duplicate",
        postings: [{ path: "pages/duplicate.md", fields: ["body"] },
          { path: "pages/duplicate.md", fields: ["title"] }]
      }]
    })).toThrow(expect.objectContaining({
      code: "portable_record_duplicate",
      recordField: "terms.postings.path"
    }));
  });

  it("orders term routes by their term ranges while keeping stable paths", () => {
    expect(() => assertPortableRecord("term_bucket", {
      formatVersion: 2,
      title: "han term routes",
      bucket: "han",
      routes: [{
        path: "_index/terms/han/han-terms-part-0002.json",
        firstTerm: "中",
        lastTerm: "中",
        recordCount: 1
      }, {
        path: "_index/terms/han/han-terms-part-0001.json",
        firstTerm: "安",
        lastTerm: "安",
        recordCount: 1
      }]
    })).not.toThrow();

    expect(() => assertPortableRecord("term_bucket", {
      formatVersion: 2,
      title: "han term routes",
      bucket: "han",
      routes: [{
        path: "_index/terms/han/han-terms-part-0001.json",
        firstTerm: "安",
        lastTerm: "安",
        recordCount: 1
      }, {
        path: "_index/terms/han/han-terms-part-0002.json",
        firstTerm: "中",
        lastTerm: "中",
        recordCount: 1
      }]
    })).toThrow(expect.objectContaining({
      code: "portable_record_order_invalid",
      recordField: "routes.firstTerm"
    }));
  });

  it("accepts source-derived navigation terms that resemble internal prefixes", () => {
    expect(() => assertPortableRecord("term_postings", {
      formatVersion: 2,
      title: "latin terms",
      bucket: "latin",
      terms: [{
        term: "knowledge-base-wide",
        postings: [{ path: "pages/guides/a.md", fields: ["body"] }]
      }]
    })).not.toThrow();

    expect(() => assertPortableRecord("term_bucket", {
      formatVersion: 2,
      title: "latin term routes",
      bucket: "latin",
      routes: [{
        path: "_index/terms/latin/latin-terms-part-0001.json",
        firstTerm: "knowledge-base-wide",
        lastTerm: "knowledge-base-wide",
        recordCount: 1
      }]
    })).not.toThrow();
  });

  it("freezes every semantic machine resource shape", () => {
    const part = {
      path: "_index/pages/guides/guides-documents.json",
      recordCount: 1,
      firstKey: "pages/guides/a.md",
      lastKey: "pages/guides/a.md",
      byteCount: 512
    };
    const relationship = {
      from: "pages/guides/a.md",
      to: "pages/guides/b.md",
      fromTitle: "A",
      toTitle: "B",
      direction: "outgoing",
      relationType: "references",
      weight: 1,
      reason: "A explicitly references B.",
      evidence: [{ path: "pages/guides/a.md" }]
    };
    const records: Record<PortableRecordFamily, Record<string, unknown>> = {
      index_catalog: {
        formatVersion: 2, title: "Knowledge index",
        resources: [{ kind: "page_directories", title: "Documents",
          path: "_index/pages/index.json",
          description: "Directory routes to original Markdown documents." }]
      },
      page_directory: {
        formatVersion: 2, title: "Guides documents", scopePath: "pages/guides",
        parentPath: "_index/pages/index.json", childDirectories: [],
        resources: [part], documentCount: 1
      },
      document_packet: {
        formatVersion: 2, title: "Guides documents", scopePath: "pages/guides",
        documents: [{
          path: "pages/guides/a.md", title: "A", summary: "A document.",
          type: "document", subjects: [], tags: [], metadata: {}, headings: ["A"],
          keywords: [], entities: [], contentType: "text/markdown; charset=utf-8",
          checksumSha256: "a".repeat(64), byteCount: 16,
          relationshipCount: 1,
          graphPath: "_graph/by-file/guides/a.json"
        }]
      },
      term_catalog: {
        formatVersion: 2, title: "Term routes",
        normalization: { unicodeNormalization: "NFKC", caseFolding: "unicode",
          tokenization: "nodejieba-search-v1" },
        buckets: ["han", "hangul", "kana", "latin", "number", "other"]
          .map((bucket) => ({
            bucket, path: `_index/terms/${bucket}/index.json`
          }))
      },
      term_bucket: {
        formatVersion: 2, title: "latin term routes", bucket: "latin",
        routes: [{ path: "_index/terms/latin/latin-terms-part-0001.json",
          firstTerm: "a", lastTerm: "a", recordCount: 1 }]
      },
      term_postings: {
        formatVersion: 2, title: "latin terms", bucket: "latin",
        terms: [{ term: "a", postings: [{ path: "pages/guides/a.md",
          fields: ["title"] }] }]
      },
      graph_catalog: {
        formatVersion: 2, title: "Relationship graph",
        resources: [{ kind: "directory_relationships",
          title: "Relationships by directory",
          path: "_graph/by-directory/index.json",
          description: "Directory routes to relationships among original documents." }]
      },
      graph_directory: {
        formatVersion: 2, title: "Guides relationships", scopePath: "pages/guides",
        parentPath: "_graph/by-directory/index.json", childDirectories: [],
        resources: [{ ...part,
          path: "_graph/by-directory/guides/guides-relationships.json" }],
        relationshipCount: 1
      },
      relationship_packet: {
        formatVersion: 2, title: "Guides relationships", scopePath: "pages/guides",
        relationships: [relationship]
      },
      per_file_graph: {
        formatVersion: 2, title: "A relationships", path: "pages/guides/a.md",
        indexPath: "_index/pages/guides/index.json",
        directoryGraphPath: "_graph/by-directory/guides/index.json",
        relationships: [{ targetPath: "pages/guides/b.md", targetTitle: "B",
          direction: "outgoing", relationType: "references", weight: 1,
          reason: "A explicitly references B.",
          evidence: [{ path: "pages/guides/a.md" }] }]
      },
      navigation: { type: "Index", title: "Documents" },
      source_fragment: {
        path: "pages/guides/a.md", title: "A", concepts: [], relationships: []
      },
      history: {
        action: "added", path: "pages/guides/a.md", title: "A",
        occurredAt: "2026-08-16T00:00:00.000Z"
      }
    };
    for (const [family, value] of Object.entries(records)) {
      expect(() => assertPortableRecord(family as PortableRecordFamily, value))
        .not.toThrow();
    }
    expect(Object.fromEntries(Object.entries(records).map(([family, value]) => [
      family,
      Object.keys(value)
    ]))).toEqual({
      index_catalog: ["formatVersion", "title", "resources"],
      page_directory: ["formatVersion", "title", "scopePath", "parentPath",
        "childDirectories", "resources", "documentCount"],
      document_packet: ["formatVersion", "title", "scopePath", "documents"],
      term_catalog: ["formatVersion", "title", "normalization", "buckets"],
      term_bucket: ["formatVersion", "title", "bucket", "routes"],
      term_postings: ["formatVersion", "title", "bucket", "terms"],
      graph_catalog: ["formatVersion", "title", "resources"],
      graph_directory: ["formatVersion", "title", "scopePath", "parentPath",
        "childDirectories", "resources", "relationshipCount"],
      relationship_packet: ["formatVersion", "title", "scopePath", "relationships"],
      per_file_graph: ["formatVersion", "title", "path", "indexPath",
        "directoryGraphPath", "relationships"],
      navigation: ["type", "title"],
      source_fragment: ["path", "title", "concepts", "relationships"],
      history: ["action", "path", "title", "occurredAt"]
    });
  });
});
