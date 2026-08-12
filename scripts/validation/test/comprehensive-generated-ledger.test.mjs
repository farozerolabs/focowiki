import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  REQUIRED_GENERATED_NAVIGATION_PATHS,
  assertGeneratedCatalog,
  assertGeneratedContentClosure,
  assertGeneratedTreeClosure,
  assertGraphClosure
} from "../lib/comprehensive-generated-ledger.mjs";

function entry(logicalPath, overrides = {}) {
  return {
    alias: `artifact:${logicalPath}`,
    logicalPath,
    kind: logicalPath.startsWith("pages/source") ? "source" : "index",
    sourceFileId: logicalPath.startsWith("pages/source") ? "source-1" : null,
    checksumSha256: "a".repeat(64),
    byteCount: 1,
    contentType: logicalPath.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "text/markdown; charset=utf-8",
    objectState: "verified",
    ownerCount: 1,
    ordinal: 0,
    ...overrides
  };
}

function completeCatalog() {
  return [
    ...REQUIRED_GENERATED_NAVIGATION_PATHS.map((path, ordinal) =>
      entry(path, { ordinal })),
    entry("pages/source.md", { ordinal: 7 })
  ];
}

test("accepts one complete generated catalog and rejects structural drift", () => {
  assert.doesNotThrow(() => assertGeneratedCatalog(completeCatalog(), {
    expectedSourceFileIds: ["source-1"]
  }));
  const cases = [
    [completeCatalog().slice(1), /required navigation/u],
    [[...completeCatalog(), entry("index.md")], /duplicate path/u],
    [completeCatalog().map((item) => item.logicalPath === "pages/source.md"
      ? { ...item, sourceFileId: null }
      : item), /source mapping/u],
    [completeCatalog().map((item) => item.logicalPath === "_index/index.md"
      ? { ...item, objectState: "reserved" }
      : item), /verified/u],
    [[...completeCatalog(), entry("pages/index-map-000001.md")], /obsolete/u]
  ];
  for (const [rows, pattern] of cases) {
    assert.throws(() => assertGeneratedCatalog(rows, {
      expectedSourceFileIds: ["source-1"]
    }), pattern);
  }
});

test("requires checksum, reciprocal navigation, link closure, and projection parity", () => {
  const entries = completeCatalog();
  const contents = new Map(entries.map((item) => [item.logicalPath, {
    content: item.logicalPath.endsWith(".json")
      ? JSON.stringify({
        formatVersion: 1,
        knowledgeBaseId: "kb-1",
        generationId: "root-1",
        projections: {
          manifest: { shards: [] }, search: { shards: [] }, links: { shards: [] },
          tree: { shards: [] }, graphNodes: { shards: [] }, graphEdges: { shards: [] },
          relatedFiles: { pathTemplate: "_graph/by-file/{fileId}.json" }
        }
      })
      : item.logicalPath === "index.md"
        ? "# Root\n\n[Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md)"
        : item.logicalPath === "_index/index.md"
          ? "# Index\n\n[Root](/index.md) [Documents](/pages/index.md) [Graph](/_graph/index.md)"
          : item.logicalPath === "_graph/index.md"
            ? "# Graph\n\n[Root](/index.md) [Documents](/pages/index.md) [Indexes](/_index/index.md)"
            : item.logicalPath === "pages/index.md"
              ? "# Documents\n\n[Root](/index.md) [Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md) [Source](/pages/source.md)"
              : "# File",
    apiByIdMatches: true,
    s3Matches: true
  }]));
  const normalized = entries.map((item) => {
    const body = contents.get(item.logicalPath).content;
    return { ...item, checksumSha256: sha256(body), byteCount: Buffer.byteLength(body) };
  });
  assert.doesNotThrow(() => assertGeneratedContentClosure(normalized, contents, {
    knowledgeBaseId: "kb-1",
    generationId: "root-1"
  }));
  const missingLink = new Map(contents);
  missingLink.set("pages/index.md", {
    ...missingLink.get("pages/index.md"),
    content: "# Documents\n\n[Root](/index.md) [Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md) [Missing](/pages/missing.md)"
  });
  const missingBody = missingLink.get("pages/index.md").content;
  const missingNormalized = normalized.map((item) => item.logicalPath === "pages/index.md"
    ? { ...item, checksumSha256: sha256(missingBody), byteCount: Buffer.byteLength(missingBody) }
    : item);
  assert.throws(() => assertGeneratedContentClosure(missingNormalized, missingLink, {
    knowledgeBaseId: "kb-1", generationId: "root-1"
  }), /link target/u);
});

test("requires exact Admin and OpenAPI tree closure", () => {
  const catalogPaths = completeCatalog().map((item) => item.logicalPath);
  const expectedDirectories = ["pages", "_index", "_graph"];
  assert.doesNotThrow(() => assertGeneratedTreeClosure({
    catalogPaths,
    expectedDirectories,
    adminFiles: catalogPaths,
    adminDirectories: expectedDirectories,
    openApiFiles: catalogPaths,
    openApiDirectories: expectedDirectories
  }));
  assert.throws(() => assertGeneratedTreeClosure({
    catalogPaths,
    expectedDirectories,
    adminFiles: catalogPaths.slice(1),
    adminDirectories: expectedDirectories,
    openApiFiles: catalogPaths,
    openApiDirectories: expectedDirectories
  }), /Admin tree/u);
});

test("requires exact current graph nodes, grounded edges, and projection records", () => {
  const input = {
    relatedFileLimit: 10,
    sources: [
      { sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", checksum: "a".repeat(64), byteCount: 20 },
      { sourceFileId: "source-2", revisionId: "revision-2", pagePath: "pages/source-2.md", checksum: "b".repeat(64), byteCount: 20 }
    ],
    nodes: [
      { nodeId: "node-1", sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", title: "Source 1" },
      { nodeId: "node-2", sourceFileId: "source-2", revisionId: "revision-2", pagePath: "pages/source-2.md", title: "Source 2" }
    ],
    edges: [{ edgeId: "edge-1", fromNodeId: "node-1", toNodeId: "node-2", relation: "references", weight: 1, reason: "Explicit source link" }],
    evidence: [{ evidenceId: "evidence-1", edgeId: "edge-1", nodeId: null, sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", checksum: "a".repeat(64), startOffset: 0, endOffset: 10 }],
    projectionRecords: {
      search: ["source-1", "source-2"],
      manifest: ["source-1", "source-2"],
      graphNodes: ["source-1", "source-2"],
      graphEdges: ["edge-1"],
      links: ["edge-1"],
      byFile: new Map([
        ["source-1", [{ fileId: "source-2", relationType: "references", direction: "outgoing" }]],
        ["source-2", [{ fileId: "source-1", relationType: "references", direction: "incoming" }]]
      ])
    }
  };
  assert.doesNotThrow(() => assertGraphClosure(input));
  assert.throws(() => assertGraphClosure({
    ...input,
    edges: [{ ...input.edges[0], toNodeId: "node-1" }]
  }), /self edge/u);
  assert.throws(() => assertGraphClosure({
    ...input,
    evidence: []
  }), /grounded evidence/u);
  assert.throws(() => assertGraphClosure({
    ...input,
    projectionRecords: { ...input.projectionRecords, graphEdges: [] }
  }), /graph edge projection/u);
});

test("applies the production by-file target deduplication and relationship limit", () => {
  const input = {
    relatedFileLimit: 1,
    sources: [
      { sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", checksum: "a".repeat(64), byteCount: 20 },
      { sourceFileId: "source-2", revisionId: "revision-2", pagePath: "pages/source-2.md", checksum: "b".repeat(64), byteCount: 20 },
      { sourceFileId: "source-3", revisionId: "revision-3", pagePath: "pages/source-3.md", checksum: "c".repeat(64), byteCount: 20 }
    ],
    nodes: [
      { nodeId: "node-1", sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", title: "Source 1" },
      { nodeId: "node-2", sourceFileId: "source-2", revisionId: "revision-2", pagePath: "pages/source-2.md", title: "Source 2" },
      { nodeId: "node-3", sourceFileId: "source-3", revisionId: "revision-3", pagePath: "pages/source-3.md", title: "Source 3" }
    ],
    edges: [
      { edgeId: "edge-1", fromNodeId: "node-1", toNodeId: "node-2", relation: "references", weight: 0.9, reason: "Strong relation" },
      { edgeId: "edge-2", fromNodeId: "node-2", toNodeId: "node-1", relation: "supports", weight: 0.9, reason: "Duplicate target" },
      { edgeId: "edge-3", fromNodeId: "node-1", toNodeId: "node-3", relation: "mentions", weight: 0.7, reason: "Truncated relation" }
    ],
    evidence: [
      { evidenceId: "evidence-1", edgeId: "edge-1", nodeId: null, sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", checksum: "a".repeat(64), startOffset: 0, endOffset: 10 },
      { evidenceId: "evidence-2", edgeId: "edge-2", nodeId: null, sourceFileId: "source-2", revisionId: "revision-2", pagePath: "pages/source-2.md", checksum: "b".repeat(64), startOffset: 0, endOffset: 10 },
      { evidenceId: "evidence-3", edgeId: "edge-3", nodeId: null, sourceFileId: "source-1", revisionId: "revision-1", pagePath: "pages/source-1.md", checksum: "a".repeat(64), startOffset: 0, endOffset: 10 }
    ],
    projectionRecords: {
      search: ["source-1", "source-2", "source-3"],
      manifest: ["source-1", "source-2", "source-3"],
      graphNodes: ["source-1", "source-2", "source-3"],
      graphEdges: ["edge-1", "edge-2", "edge-3"],
      links: ["edge-1", "edge-2", "edge-3"],
      byFile: new Map([
        ["source-1", [{ fileId: "source-2", relationType: "references", direction: "outgoing" }]],
        ["source-2", [{ fileId: "source-1", relationType: "references", direction: "incoming" }]],
        ["source-3", [{ fileId: "source-1", relationType: "mentions", direction: "incoming" }]]
      ])
    }
  };
  assert.doesNotThrow(() => assertGraphClosure(input));
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
