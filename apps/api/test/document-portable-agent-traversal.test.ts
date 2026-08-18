import { describe, expect, it } from "vitest";
import { createDocumentPortableAgentTraversal } from
  "../src/document-indexing/application/document-portable-agent-traversal.js";

describe("portable Agent traversal", () => {
  const files = fixture();
  const traversal = createDocumentPortableAgentTraversal({
    async readJson(path) {
      const value = files.get(path);
      if (!value) throw new Error("Unexpected read: " + path);
      return value;
    },
    maximumReads: 8
  });

  it("resolves exact and nested paths without scanning unrelated directories", async () => {
    const lookup = await traversal.exactPath("pages/指南/安装.md");
    expect(lookup.result).toMatchObject({
      path: "pages/指南/安装.md",
      title: "安装指南"
    });
    expect(lookup.reads).toEqual([
      "_index/pages/指南/index.json",
      "_index/pages/指南/指南-documents.json"
    ]);
  });

  it("resolves Chinese and Latin terms through only their declared routes", async () => {
    const chinese = await traversal.term("安装");
    expect(chinese.result).toEqual([
      expect.objectContaining({ path: "pages/指南/安装.md" })
    ]);
    expect(chinese.reads).toEqual([
      "_index/terms/index.json",
      "_index/terms/han/index.json",
      "_index/terms/han/han-terms-part-0001.json"
    ]);
    const latin = await traversal.term("Installation");
    expect(latin.result).toEqual([
      expect.objectContaining({ path: "pages/guides/install.md" })
    ]);
    expect(latin.reads).toEqual([
      "_index/terms/index.json",
      "_index/terms/latin/index.json",
      "_index/terms/latin/latin-terms-part-0001.json"
    ]);
  });

  it("supports directory browsing, no result, and relationship expansion", async () => {
    const directory = await traversal.directory("pages/指南");
    expect(directory.result).toMatchObject({ scopePath: "pages/指南" });
    expect(directory.reads).toEqual(["_index/pages/指南/index.json"]);
    const none = await traversal.term("missing");
    expect(none.result).toEqual([]);
    expect(none.reads).toEqual([
      "_index/terms/index.json",
      "_index/terms/latin/index.json"
    ]);
    const graph = await traversal.relationships("pages/指南/安装.md");
    expect(graph.result).toEqual([
      expect.objectContaining({ targetPath: "pages/guides/install.md" })
    ]);
    expect(graph.reads).toEqual(["_graph/by-file/指南/安装.json"]);
  });
});

function fixture(): Map<string, Record<string, unknown>> {
  return new Map([
    ["_index/pages/指南/index.json", {
      formatVersion: 2,
      title: "指南 documents",
      scopePath: "pages/指南",
      childDirectories: [],
      resources: [{
        path: "_index/pages/指南/指南-documents.json",
        recordCount: 1,
        firstKey: "pages/指南/安装.md",
        lastKey: "pages/指南/安装.md",
        byteCount: 512
      }],
      documentCount: 1
    }],
    ["_index/pages/指南/指南-documents.json", {
      formatVersion: 2,
      title: "指南 documents",
      scopePath: "pages/指南",
      documents: [{
        path: "pages/指南/安装.md",
        title: "安装指南"
      }]
    }],
    ["_index/terms/index.json", {
      formatVersion: 2,
      title: "Term routes",
      buckets: [{ bucket: "han", path: "_index/terms/han/index.json" }, {
        bucket: "latin", path: "_index/terms/latin/index.json"
      }]
    }],
    ["_index/terms/han/index.json", {
      formatVersion: 2,
      title: "han term routes",
      bucket: "han",
      routes: [{
        firstTerm: "安装",
        lastTerm: "安装",
        recordCount: 1,
        path: "_index/terms/han/han-terms-part-0001.json"
      }]
    }],
    ["_index/terms/latin/index.json", {
      formatVersion: 2,
      title: "latin term routes",
      bucket: "latin",
      routes: [{
        firstTerm: "installation",
        lastTerm: "installation",
        recordCount: 1,
        path: "_index/terms/latin/latin-terms-part-0001.json"
      }]
    }],
    ["_index/terms/han/han-terms-part-0001.json", {
      formatVersion: 2,
      title: "han terms",
      bucket: "han",
      terms: [{
        term: "安装",
        postings: [{ path: "pages/指南/安装.md", fields: ["title"] }]
      }]
    }],
    ["_index/terms/latin/latin-terms-part-0001.json", {
      formatVersion: 2,
      title: "latin terms",
      bucket: "latin",
      terms: [{
        term: "installation",
        postings: [{ path: "pages/guides/install.md", fields: ["title"] }]
      }]
    }],
    ["_graph/by-file/指南/安装.json", {
      formatVersion: 2,
      path: "pages/指南/安装.md",
      relationships: [{
        targetPath: "pages/guides/install.md",
        targetTitle: "Install"
      }]
    }]
  ]);
}
