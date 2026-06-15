import { describe, expect, it } from "vitest";
import { createStorageKeyspace } from "../src/storage/keys.js";

describe("storage key normalization", () => {
  it("builds knowledge base scoped upload and release keys under S3_PREFIX", () => {
    const keys = createStorageKeyspace("tenant/demo");

    expect(keys.sourceFileKey("kb-001", "task-001", "source-001", "Intro.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/uploads/task-001/sources/source-001/Intro.md"
    );
    expect(
      keys.sourceFileKey(
        "kb-001",
        "task-001",
        "source-001",
        "外国企业常驻代表机构登记管理条例.md"
      )
    ).toBe(
      "tenant/demo/knowledge-bases/kb-001/uploads/task-001/sources/source-001/外国企业常驻代表机构登记管理条例.md"
    );
    expect(keys.releaseRootKey("kb-001", "release-001")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/"
    );
    expect(keys.releaseBundleKey("kb-001", "release-001", "index.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/index.md"
    );
    expect(keys.releaseBundleKey("kb-001", "release-001", "/schema.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/schema.md"
    );
    expect(keys.releaseBundleKey("kb-001", "release-001", "pages/intro.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md"
    );
    expect(
      keys.releaseBundleKey(
        "kb-001",
        "release-001",
        "pages/外国企业常驻代表机构登记管理条例.md"
      )
    ).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/外国企业常驻代表机构登记管理条例.md"
    );
    expect(keys.releaseBundleKey("kb-001", "release-001", "_index/search.json")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/_index/search.json"
    );
  });

  it("rejects prefixes that escape the configured scope", () => {
    expect(() => createStorageKeyspace("../tenant")).toThrow(/S3_PREFIX/);
    expect(() => createStorageKeyspace("tenant/../demo")).toThrow(/S3_PREFIX/);
    expect(() => createStorageKeyspace("tenant/%2e%2e/demo")).toThrow(/S3_PREFIX/);
    expect(() => createStorageKeyspace("tenant\\demo")).toThrow(/S3_PREFIX/);
  });

  it("rejects traversal in knowledge base, task, and release identifiers", () => {
    const keys = createStorageKeyspace("tenant/demo");

    expect(() => keys.releaseBundleKey("../kb", "release-001", "index.md")).toThrow(
      /knowledgeBaseId/
    );
    expect(() => keys.sourceFileKey("kb-001", "task/%2e%2e", "source-001", "intro.md")).toThrow(
      /taskId/
    );
    expect(() => keys.releaseBundleKey("kb-001", "release\\001", "index.md")).toThrow(
      /releaseId/
    );
  });

  it("rejects traversal in logical bundle paths", () => {
    const keys = createStorageKeyspace("tenant/demo");

    expect(() => keys.releaseBundleKey("kb-001", "release-001", "../index.md")).toThrow(/path/);
    expect(() =>
      keys.releaseBundleKey("kb-001", "release-001", "pages/../../secret.md")
    ).toThrow(/path/);
    expect(() =>
      keys.releaseBundleKey("kb-001", "release-001", "pages/%2e%2e/secret.md")
    ).toThrow(/path/);
    expect(() => keys.releaseBundleKey("kb-001", "release-001", "sources/source-a.md")).toThrow(
      /path/
    );
    expect(() => keys.releaseBundleKey("kb-001", "release-001", "pages\\secret.md")).toThrow(
      /path/
    );
  });
});
