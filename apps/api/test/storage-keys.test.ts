import { describe, expect, it } from "vitest";
import { createStorageKeyspace } from "../src/storage/keys.js";

describe("storage key normalization", () => {
  it("builds knowledge base scoped upload and release keys under S3_PREFIX", () => {
    const keys = createStorageKeyspace("tenant/demo");

    expect(keys.sourceFileKey("kb-001", "source-001", "Intro.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/sources/source-001/Intro.md"
    );
    expect(
      keys.sourceFileKey(
        "kb-001",
        "source-001",
        "客户支持手册.md"
      )
    ).toBe(
      "tenant/demo/knowledge-bases/kb-001/sources/source-001/客户支持手册.md"
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
    expect(keys.releaseBundleKey("kb-001", "release-001", "log-000001.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/log-000001.md"
    );
    expect(keys.releaseBundleKey("kb-001", "release-001", "pages/intro.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md"
    );
    expect(
      keys.releaseBundleKey("kb-001", "release-001", "pages/team/manual/setup.md")
    ).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/team/manual/setup.md"
    );
    expect(
      keys.releaseBundleKey(
        "kb-001",
        "release-001",
        "pages/客户支持手册.md"
      )
    ).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/客户支持手册.md"
    );
    expect(keys.releaseBundleKey("kb-001", "release-001", "_index/search.json")).toBe(
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/_index/search.json"
    );
    expect(keys.uploadSessionEntryKey("kb-001", "upload-session-001", "upload-entry-001")).toBe(
      "tenant/demo/knowledge-bases/kb-001/upload-sessions/upload-session-001/entries/upload-entry-001/content.md"
    );
    expect(keys.sourceRevisionKey("kb-001", "source-001", "revision-002")).toBe(
      "tenant/demo/knowledge-bases/kb-001/sources/source-001/revisions/revision-002/content.md"
    );
  });

  it("rejects prefixes that escape the configured scope", () => {
    expect(() => createStorageKeyspace("../tenant")).toThrow(/S3_PREFIX/);
    expect(() => createStorageKeyspace("tenant/../demo")).toThrow(/S3_PREFIX/);
    expect(() => createStorageKeyspace("tenant/%2e%2e/demo")).toThrow(/S3_PREFIX/);
    expect(() => createStorageKeyspace("tenant/%252525252e%252525252e/demo")).toThrow(
      /S3_PREFIX/
    );
    expect(() => createStorageKeyspace("tenant\\demo")).toThrow(/S3_PREFIX/);
  });

  it("rejects traversal in knowledge base, source file, and release identifiers", () => {
    const keys = createStorageKeyspace("tenant/demo");

    expect(() => keys.releaseBundleKey("../kb", "release-001", "index.md")).toThrow(
      /knowledgeBaseId/
    );
    expect(() => keys.sourceFileKey("kb-001", "source/%2e%2e", "intro.md")).toThrow(
      /sourceFileId/
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
    expect(() =>
      keys.releaseBundleKey(
        "kb-001",
        "release-001",
        "pages/%252525252e%252525252e/secret.md"
      )
    ).toThrow(/path/);
    expect(() => keys.releaseBundleKey("kb-001", "release-001", "sources/source-a.md")).toThrow(
      /path/
    );
    expect(() => keys.releaseBundleKey("kb-001", "release-001", "pages\\secret.md")).toThrow(
      /path/
    );
  });
});
