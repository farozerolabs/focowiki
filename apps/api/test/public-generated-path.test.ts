import { describe, expect, it } from "vitest";
import {
  isAllowedPublicGeneratedDirectoryPath,
  isAllowedPublicGeneratedFilePath,
  publicGeneratedContentType
} from "../src/public-generated-path.js";

describe("public generated path policy", () => {
  it.each([
    "index.md",
    "log.md",
    "log-000001.md",
    "schema.md",
    "schema-frontmatter.md",
    "schema-navigation.md",
    "pages/root/index.md",
    "pages/root/nested/page.md",
    "_index/index.md",
    "_index/catalog.json",
    "_index/manifest/v1/0001.json",
    "_index/search/v1/0002.json",
    "_index/links/v1/0003.json",
    "_index/tree/v1/0004.json",
    "_graph/index.md",
    "_graph/graph_node/v1/0001.json",
    "_graph/graph_edge/v1/0002.json",
    "_graph/by-file/source-file-1.json",
    "_segments/manifest/manifest/v1/0014/delta-000000-30a1ba882fb494f8.json",
    "_segments/related_files/source-file-1/compacted-000004-aabbccddeeff0011.json",
    "_segments/compacted/projection-segment-aabbccdd.json"
  ])("allows generated file %s", (path) => {
    expect(isAllowedPublicGeneratedFilePath(path)).toBe(true);
  });

  it.each([
    "pages",
    "pages/root",
    "pages/root/nested",
    "_index",
    "_index/search",
    "_index/search/v1",
    "_graph",
    "_graph/graph_node/v1",
    "_graph/by-file"
  ])("allows generated directory %s", (path) => {
    expect(isAllowedPublicGeneratedDirectoryPath(path)).toBe(true);
  });

  it.each([
    "/index.md",
    "sources/private.md",
    "pages/../secret.md",
    "pages//file.md",
    "_index/unknown.json",
    "_index/manifest.json",
    "_index/search/1.jsonl",
    "_graph/communities.json",
    "_graph/edges/private.jsonl",
    "_graph/by-file/nested/file.json",
    "_segments/private/manifest.json",
    "_segments/search/../secret.json",
    "_segments/search/search/v1/0001/private.txt",
    "unsupported.txt"
  ])("rejects unsupported path %s", (path) => {
    expect(isAllowedPublicGeneratedFilePath(path)).toBe(false);
  });

  it("selects content types from the generated extension", () => {
    expect(publicGeneratedContentType("index.md")).toBe("text/markdown; charset=utf-8");
    expect(publicGeneratedContentType("_index/catalog.json")).toBe(
      "application/json; charset=utf-8"
    );
    expect(publicGeneratedContentType("_graph/graph_node/v1/0001.json")).toBe(
      "application/json; charset=utf-8"
    );
  });
});
