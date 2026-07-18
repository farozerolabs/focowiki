import assert from "node:assert/strict";
import test from "node:test";
import {
  isManifestOwnedPath,
  isReservedOkfMarkdownPath,
  requiresSourceBodyComparison
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
