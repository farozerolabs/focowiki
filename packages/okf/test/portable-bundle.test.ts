import { describe, expect, it } from "vitest";
import {
  assertPortablePathSet,
  assertPortableRecord,
  normalizePortablePagePath,
  pagePathFromPortableByFileGraphPath,
  portableByFileGraphDirectoryPath,
  portableByFileGraphPath,
  portableGraphDirectoryPath,
  portableIndexDirectoryPath,
  portableSemanticResourceFileName,
  normalizePortableTerm,
  portableTermOrNull,
  portableDisplayTitleFromPagePath,
  portableMarkdownHref,
  validatePortableGeneratedText,
  validatePortablePathClosure
} from "../src/portable-bundle.js";

describe("portable knowledge bundle", () => {
  it("normalizes canonical page paths without replacing user identity", () => {
    expect(normalizePortablePagePath("指南\\安装 (基础).md")).toBe(
      "pages/指南/安装 (基础).md"
    );
    expect(normalizePortablePagePath(
      "pages/Focowiki source-file-user-authored.md"
    )).toBe("pages/Focowiki source-file-user-authored.md");
    expect(() => normalizePortablePagePath("../secret.md"))
      .toThrow(/portable_page_path_invalid/u);
    expect(() => normalizePortablePagePath("pages/_graph/a.md"))
      .toThrow(/portable_page_path_reserved/u);
    expect(() => assertPortablePathSet([
      "pages/café.md",
      "pages/cafe\u0301.md"
    ])).toThrow(/portable_page_path_collision/u);
    expect(portableDisplayTitleFromPagePath("pages/指南/安装 (基础).md"))
      .toBe("安装 (基础)");
    expect(() => portableDisplayTitleFromPagePath("pages/.md"))
      .toThrow(/portable_page_title_invalid/u);
  });

  it("maps nested page paths to mirrored per-file graph resources reversibly", () => {
    const cases = [
      ["pages/guides/install.md", "_graph/by-file/guides/install.json"],
      ["pages/指南/安装 (基础).md", "_graph/by-file/指南/安装 (基础).json"],
      ["pages/a b/(c).md", "_graph/by-file/a b/(c).json"]
    ] as const;
    for (const [pagePath, graphPath] of cases) {
      expect(portableByFileGraphPath(pagePath)).toBe(graphPath);
      expect(pagePathFromPortableByFileGraphPath(graphPath)).toBe(pagePath);
    }
  });

  it("maps page directories to semantic index and graph directories", () => {
    expect(portableIndexDirectoryPath("pages")).toBe("_index/pages");
    expect(portableIndexDirectoryPath("pages/指南/安装 (基础)"))
      .toBe("_index/pages/指南/安装 (基础)");
    expect(portableGraphDirectoryPath("pages/guides/setup"))
      .toBe("_graph/by-directory/guides/setup");
    expect(portableByFileGraphDirectoryPath("pages/guides/setup"))
      .toBe("_graph/by-file/guides/setup");
    expect(() => portableIndexDirectoryPath("pages/../secret"))
      .toThrow(/portable_directory_path_invalid/u);
  });

  it("derives concrete semantic resource filenames and preserves the 1,000-code-point bound", () => {
    expect(portableSemanticResourceFileName({
      subject: "01_宪法",
      family: "documents"
    })).toBe("01_宪法-documents.json");
    expect(portableSemanticResourceFileName({
      subject: "01_宪法",
      family: "relationships",
      partNumber: 2
    })).toBe("01_宪法-relationships-part-0002.json");
    expect(portableSemanticResourceFileName({
      subject: "知",
      family: "terms"
    })).toBe("知-terms.json");

    const longName = portableSemanticResourceFileName({
      subject: "界".repeat(1_000),
      family: "documents",
      partNumber: 9_999
    });
    expect([...longName]).toHaveLength(1_000);
    expect(longName.endsWith("…-documents-part-9999.json")).toBe(true);
    expect(longName).not.toMatch(/[0-9a-f]{8,}/u);
  });

  it("normalizes multilingual terms into deterministic semantic routes", () => {
    expect(normalizePortableTerm("  Installation GUIDE  ")).toBe("installation guide");
    expect(normalizePortableTerm("知识　图谱")).toBe("知识 图谱");
    expect(portableTermOrNull("ＦＯＯ")).toBe("foo");
    expect(portableTermOrNull("fullwidth／slash")).toBeNull();
  });

  it("accepts only format-version-2 semantic resource schemas", () => {
    const resources = [{
      kind: "page_directories",
      title: "Documents",
      path: "_index/pages/index.json",
      description: "Directory routes to original Markdown documents."
    }];
    expect(() => assertPortableRecord("index_catalog", {
      formatVersion: 2,
      title: "Knowledge index",
      resources
    })).not.toThrow();
    expect(() => assertPortableRecord("page_directory", {
      formatVersion: 2,
      title: "Guides",
      scopePath: "pages/guides",
      parentPath: "_index/pages/index.json",
      childDirectories: [],
      resources: [{
        path: "_index/pages/guides/guides-documents.json",
        recordCount: 1,
        firstKey: "pages/guides/install.md",
        lastKey: "pages/guides/install.md",
        byteCount: 512
      }],
      documentCount: 1
    })).not.toThrow();
    expect(() => assertPortableRecord("document_packet", {
      formatVersion: 2,
      title: "Guides documents",
      scopePath: "pages/guides",
      documents: [{
        path: "pages/guides/install.md",
        title: "Install",
        summary: "Install the application.",
        contentType: "text/markdown; charset=utf-8",
        checksumSha256: "a".repeat(64),
        byteCount: 32,
        metadata: {},
        headings: ["Install"],
        tags: [], subjects: [], keywords: [], entities: [],
        relationshipCount: 1,
        graphPath: "_graph/by-file/guides/install.json"
      }]
    })).not.toThrow();
    expect(() => assertPortableRecord("document_packet", {
      formatVersion: 2,
      title: "Relation-free documents",
      scopePath: "pages/guides",
      documents: [{
        path: "pages/guides/standalone.md",
        title: "Standalone",
        summary: "No accepted relationships.",
        contentType: "text/markdown; charset=utf-8",
        checksumSha256: "b".repeat(64),
        byteCount: 30,
        metadata: {},
        headings: ["Standalone"],
        tags: [], subjects: [], keywords: [], entities: [],
        relationshipCount: 0
      }]
    })).not.toThrow();
    expect(() => assertPortableRecord("index_catalog", {
      formatVersion: 1,
      title: "Old",
      indexes: [{ family: "search", path: "_index/search/v1/0001.json" }]
    })).toThrow();
  });

  it("renders relocatable relative Markdown destinations", () => {
    expect(portableMarkdownHref(
      "_graph/index.md",
      "pages/指南/安装 (基础).md"
    )).toBe("../pages/%E6%8C%87%E5%8D%97/%E5%AE%89%E8%A3%85%20%28%E5%9F%BA%E7%A1%80%29.md");
    expect(portableMarkdownHref(
      "pages/guides/a.md",
      "pages/guides/b.md"
    )).toBe("b.md");
    expect(portableMarkdownHref(
      "_graph/by-file/guides/index.md",
      "_graph/by-file/guides/install.json"
    )).toBe("install.json");
    expect(portableMarkdownHref(
      "_index/index.md",
      "_index/terms/han/han-terms-part-0001.json"
    )).toBe("terms/han/han-terms-part-0001.json");
  });

  it("enforces the exact public keys for every generated record family", () => {
    const records = {
      graph_catalog: { formatVersion: 2, title: "Relationship graph", resources: [{ kind: "directory_relationships", title: "Relationships by directory", path: "_graph/by-directory/index.json", description: "Directory routes to relationships among original documents." }] },
      graph_directory: { formatVersion: 2, title: "Guides relationships", scopePath: "pages/guides", parentPath: "_graph/by-directory/index.json", childDirectories: [], resources: [], relationshipCount: 0 },
      relationship_packet: { formatVersion: 2, title: "Guides relationships", scopePath: "pages/guides", relationships: [] },
      per_file_graph: { formatVersion: 2, title: "A relationships", path: "pages/guides/a.md", indexPath: "_index/pages/guides/index.json", directoryGraphPath: "_graph/by-directory/guides/index.json", relationships: [{ targetPath: "pages/guides/b.md", targetTitle: "B", direction: "outgoing", relationType: "references", reason: "A explicitly references B.", evidence: [] }] },
      navigation: { type: "Index", title: "Documents" },
      source_fragment: { path: "pages/guides/a.md", title: "A", concepts: [], relationships: [] },
      history: { action: "moved", path: "pages/archive/a.md", previousPath: "pages/guides/a.md", title: "A", occurredAt: "2026-08-16T00:00:00.000Z" }
    } as const;
    for (const [family, record] of Object.entries(records)) {
      expect(() => assertPortableRecord(family as never, record)).not.toThrow();
    }

    for (const forbidden of [
      { fileId: "source-file-a" },
      { sourceRevisionId: "source-revision-a" },
      { knowledgeBaseId: "knowledge-base-a" },
      { profileSource: "deterministic" },
      { generated: { by: "process:focowiki-document-indexing" } }
    ]) {
      expect(() => assertPortableRecord("document_packet", {
        formatVersion: 2,
        title: "Documents",
        scopePath: "pages",
        documents: [],
        ...forbidden
      })).toThrow(/portable_record_unknown_key/u);
    }
  });

  it("rejects producer language only in generator-owned text", () => {
    for (const value of [
      "Generated by Focowiki",
      "process:focowiki-document-indexing",
      "model_confirmed relationship",
      "publication projection activated",
      "https://api.example.com/openapi/v2/files"
    ]) {
      expect(() => validatePortableGeneratedText(value))
        .toThrow(/portable_generated_text_forbidden/u);
    }
    expect(() => validatePortableGeneratedText(
      "Focowiki source-file-user-authored.md",
      { ownership: "user" }
    )).not.toThrow();
    expect(() => validatePortableGeneratedText(
      "Focowiki source-file-user-authored.md references Setup.",
      { userText: ["Focowiki source-file-user-authored.md"] }
    )).not.toThrow();
    expect(() => validatePortableGeneratedText(
      "Focowiki source-file-user-authored.md uses a storage projection.",
      { userText: ["Focowiki source-file-user-authored.md"] }
    )).toThrow(/portable_generated_text_forbidden/u);
  });

  it("validates nested and bidirectional path closure across lifecycle successors", () => {
    const readablePages = [
      "pages/指南/安装 (基础).md",
      "pages/指南/运行.md",
      "pages/unrelated.md",
      "pages/empty-neighborhood.md"
    ];
    const relations = [{
      from: readablePages[0]!, to: readablePages[1]!,
      relationType: "references"
    }, {
      from: readablePages[1]!, to: readablePages[0]!,
      relationType: "supports"
    }];
    expect(() => validatePortablePathClosure({
      readablePages,
      indexPaths: [...readablePages],
      graphPaths: readablePages.map(portableByFileGraphPath),
      relations
    })).not.toThrow();
    expect(() => validatePortablePathClosure({
      readablePages,
      indexPaths: [...readablePages, "pages/指南/旧路径.md"],
      graphPaths: readablePages.map(portableByFileGraphPath),
      relations
    })).toThrow(/portable_closure_orphan_index/u);
    expect(() => validatePortablePathClosure({
      readablePages,
      indexPaths: [...readablePages],
      graphPaths: [
        ...readablePages.map(portableByFileGraphPath),
        "_graph/by-file/指南/旧路径.json"
      ],
      relations
    })).toThrow(/portable_closure_orphan_graph/u);
  });
});
