import assert from "node:assert/strict";
import test from "node:test";
import {
  isManifestOwnedPath,
  isReservedOkfMarkdownPath,
  requiresSourceBodyComparison,
  validateProjectionCatalog,
  validateReservedMarkdownFrontmatter
} from "../lib/okf-file-contract.mjs";

test("recognizes reserved OKF index and log files at every directory depth", () => {
  assert.equal(isReservedOkfMarkdownPath("index.md"), true);
  assert.equal(isReservedOkfMarkdownPath("log.md"), true);
  assert.equal(isReservedOkfMarkdownPath("_graph/index.md"), true);
  assert.equal(isReservedOkfMarkdownPath("_index/index.md"), true);
  assert.equal(isReservedOkfMarkdownPath("schema.md"), true);
  assert.equal(isReservedOkfMarkdownPath("pages/team/index.md"), false);
  assert.equal(isReservedOkfMarkdownPath("pages/team/log.md"), false);
});

test("validates current reserved Markdown frontmatter contracts", () => {
  assert.equal(
    validateReservedMarkdownFrontmatter("index.md", { okf_version: "0.2" }),
    true
  );
  assert.equal(
    validateReservedMarkdownFrontmatter("index.md", {
      okf_version: "0.2",
      knowledge_base_id: "internal"
    }),
    false
  );
  assert.equal(
    validateReservedMarkdownFrontmatter("index.md", { okf_version: "0.1" }),
    false
  );
  assert.equal(
    validateReservedMarkdownFrontmatter("schema.md", {
      type: "Schema Reference",
      title: "Metadata and navigation schema",
      description: "Metadata conventions"
    }),
    true
  );
  assert.equal(validateReservedMarkdownFrontmatter("schema.md", {}), false);
  assert.equal(validateReservedMarkdownFrontmatter("log.md", {}), true);
  assert.equal(validateReservedMarkdownFrontmatter("_graph/index.md", {}), true);
  assert.equal(validateReservedMarkdownFrontmatter("_index/index.md", {}), true);
  assert.equal(
    validateReservedMarkdownFrontmatter("log.md", { type: "internal" }),
    false
  );
});

test("validates the current sharded projection catalog", () => {
  const catalog = {
    formatVersion: 1,
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    projections: {
      search: { shards: [{ path: "_index/search/v1/0001.json", recordCount: 2 }] },
      links: { shards: [] },
      manifest: { shards: [{ path: "_index/manifest/v1/0001.json", recordCount: 2 }] },
      tree: { shards: [{ path: "_index/tree/v1/0001.json", recordCount: 3 }] },
      graphNodes: { shards: [] },
      graphEdges: { shards: [] },
      relatedFiles: { pathTemplate: "_graph/by-file/{fileId}.json" }
    }
  };

  assert.equal(validateProjectionCatalog(catalog), true);
  assert.equal(
    validateProjectionCatalog({
      ...catalog,
      projections: { ...catalog.projections, search: "_index/search.json" }
    }),
    false
  );
  assert.equal(
    validateProjectionCatalog({
      ...catalog,
      projections: {
        ...catalog.projections,
        tree: { shards: [{ path: "../tree.json", recordCount: 1 }] }
      }
    }),
    false
  );
});

test("does not classify concept and numbered navigation files as reserved", () => {
  assert.equal(isReservedOkfMarkdownPath("pages/team/guide.md"), false);
  assert.equal(isReservedOkfMarkdownPath("pages/team/index-000001.md"), false);
  assert.equal(isReservedOkfMarkdownPath("_graph/unpublished.md"), false);
});

test("limits source body comparison to source-backed page concepts", () => {
  assert.equal(requiresSourceBodyComparison({ fileKind: "page", sourceFileId: "source-1" }), true);
  assert.equal(requiresSourceBodyComparison({ fileKind: "page", sourceFileId: null }), false);
  assert.equal(requiresSourceBodyComparison({ fileKind: "log", sourceFileId: null }), false);
  assert.equal(requiresSourceBodyComparison({ fileKind: "schema", sourceFileId: null }), false);
});

test("recognizes manifest-owned root and shard paths excluded from recursive checksums", () => {
  assert.equal(isManifestOwnedPath("_index/catalog.json"), true);
  assert.equal(isManifestOwnedPath("_index/manifest/v1/0001.json"), true);
  assert.equal(isManifestOwnedPath("_index/manifest.json"), false);
  assert.equal(isManifestOwnedPath("_index/search.json"), false);
});
