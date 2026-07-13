import { describe, expect, it } from "vitest";
import {
  isAllowedPublicBundleDirectoryPath,
  isAllowedPublicBundleFilePath,
  publicBundleContentType
} from "../src/public-bundle-path.js";

describe("public bundle path policy", () => {
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
    "_index/manifest.json",
    "_index/changes.json",
    "_index/changes/000001.jsonl",
    "_graph/index.md",
    "_graph/manifest.json",
    "_graph/nodes.jsonl",
    "_graph/nodes/0001.jsonl",
    "_graph/edges/0001.jsonl",
    "_graph/by-file/source-file-1.json",
    "_graph/communities.json",
    "_graph/insights.json"
  ])("allows generated file %s", (path) => {
    expect(isAllowedPublicBundleFilePath(path)).toBe(true);
  });

  it.each([
    "pages",
    "pages/root",
    "pages/root/nested",
    "_index",
    "_index/search",
    "_graph",
    "_graph/by-file"
  ])("allows generated directory %s", (path) => {
    expect(isAllowedPublicBundleDirectoryPath(path)).toBe(true);
  });

  it.each([
    "/index.md",
    "sources/private.md",
    "pages/../secret.md",
    "pages//file.md",
    "_index/unknown.json",
    "_index/search/1.jsonl",
    "_graph/edges/private.jsonl",
    "_graph/by-file/nested/file.json",
    "unsupported.txt"
  ])("rejects unsupported path %s", (path) => {
    expect(isAllowedPublicBundleFilePath(path)).toBe(false);
  });

  it("selects content types from the generated extension", () => {
    expect(publicBundleContentType("index.md")).toBe("text/markdown; charset=utf-8");
    expect(publicBundleContentType("_index/manifest.json")).toBe("application/json; charset=utf-8");
    expect(publicBundleContentType("_graph/nodes/0001.jsonl")).toBe(
      "application/x-ndjson; charset=utf-8"
    );
  });
});
