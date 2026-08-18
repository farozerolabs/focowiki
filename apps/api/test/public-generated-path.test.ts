import { describe, expect, it } from "vitest";
import {
  isAllowedPublicBundleDirectoryPath,
  isAllowedPublicBundleFilePath,
  publicBundleContentType
} from "@focowiki/okf";

describe("public generated bundle paths", () => {
  it.each([
    "index.md",
    "log.md",
    "pages/guide.md",
    "pages/指南/安装.md",
    "_index/index.md",
    "_index/index-extension-leaf-root.md",
    "_index/catalog.json",
    "_index/pages/index.md",
    "_index/pages/index-extension-leaf-root.md",
    "_index/pages/index.json",
    "_index/pages/all-documents.json",
    "_index/pages/all-documents-part-0001.json",
    "_index/pages/指南/index.json",
    "_index/pages/指南/指南-documents-part-0002.json",
    "_index/terms/index.json",
    "_index/terms/index.md",
    "_index/terms/index-extension-leaf-root.md",
    "_index/terms/latin/index.json",
    "_index/terms/latin/index.md",
    "_index/terms/latin/index-extension-leaf-root.md",
    "_index/terms/latin/latin-terms-part-0001.json",
    "_index/terms/han/index.json",
    "_index/terms/han/han-terms-part-0001.json",
    "_graph/index.md",
    "_graph/index-extension-leaf-root.md",
    "_graph/catalog.json",
    "_graph/by-directory/index.md",
    "_graph/by-directory/index.json",
    "_graph/by-directory/guide/guide-relationships.json",
    "_graph/by-directory/guide/guide-relationships-part-0001.json",
    "_graph/by-file/index.md",
    "_graph/by-file/guide/index.md",
    "_graph/by-file/guide/install.json"
  ])("allows semantic bundle file %s", (path) => {
    expect(isAllowedPublicBundleFilePath(path)).toBe(true);
  });

  it.each([
    "pages",
    "pages/指南",
    "_index",
    "_index/pages",
    "_index/pages/指南",
    "_index/terms",
    "_index/terms/latin",
    "_graph",
    "_graph/by-directory",
    "_graph/by-directory/guide",
    "_graph/by-file",
    "_graph/by-file/guide"
  ])("allows semantic bundle directory %s", (path) => {
    expect(isAllowedPublicBundleDirectoryPath(path)).toBe(true);
  });

  it.each([
    "_index/search/v1/0001.json",
    "_index/tree/v1/0001.json",
    "_index/manifest/v1/0001.json",
    "_index/links/v1/0001.json",
    "_graph/graph_node/v1/0001.json",
    "_graph/graph_edge/v1/0001.json",
    "_index/pages/0001.json",
    "_graph/by-directory/0001.json",
    "_index/pages/documents.json",
    "_index/pages/指南/documents-part-0002.json",
    "_index/terms/c/postings.json",
    "_index/terms/latin-terms-part-0001.json",
    "_graph/by-directory/guide/relationships.json",
    "_index/pages/documents-part-1.json",
    "_index/terms/climate/0001.json",
    "_graph/by-file/guide/index.json",
    "_index/schema.md",
    "_index/pages/index-map-000001.md",
    "_index/pages/../secret.json",
    "_unknown/catalog.json"
  ])("rejects obsolete or unsafe bundle file %s", (path) => {
    expect(isAllowedPublicBundleFilePath(path)).toBe(false);
  });

  it.each([
    "_index/search",
    "_graph/graph_node",
    "_graph/by-directory/../secret",
    "_segments"
  ])("rejects obsolete or unsafe bundle directory %s", (path) => {
    expect(isAllowedPublicBundleDirectoryPath(path)).toBe(false);
  });

  it("maps semantic JSON and Markdown content types", () => {
    expect(publicBundleContentType("_index/catalog.json"))
      .toBe("application/json; charset=utf-8");
    expect(publicBundleContentType("_index/index.md"))
      .toBe("text/markdown; charset=utf-8");
  });
});
