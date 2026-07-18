import { describe, expect, it } from "vitest";
import { createStorageKeyspace, StorageKeyError } from "../src/storage/keys.js";

describe("storage keyspace", () => {
  it("builds source, revision, and upload-session keys", () => {
    const keys = createStorageKeyspace("tenant/demo");

    expect(keys.knowledgeBaseRootKey("kb-001")).toBe(
      "tenant/demo/knowledge-bases/kb-001"
    );
    expect(keys.sourceFileKey("kb-001", "source-001", "Intro.md")).toBe(
      "tenant/demo/knowledge-bases/kb-001/sources/source-001/Intro.md"
    );
    expect(keys.sourceRevisionKey("kb-001", "source-001", "revision-001")).toBe(
      "tenant/demo/knowledge-bases/kb-001/sources/source-001/revisions/revision-001/content.md"
    );
    expect(keys.uploadSessionEntryKey("kb-001", "session-001", "entry-001")).toBe(
      "tenant/demo/knowledge-bases/kb-001/upload-sessions/session-001/entries/entry-001/content.md"
    );
  });

  it("normalizes the configured prefix", () => {
    expect(createStorageKeyspace("/tenant/demo/").prefix).toBe("tenant/demo");
  });

  it("rejects path traversal and unsafe identifiers", () => {
    expect(() => createStorageKeyspace("../tenant")).toThrow(StorageKeyError);
    const keys = createStorageKeyspace("tenant/demo");

    expect(() => keys.knowledgeBaseRootKey("../kb")).toThrow(StorageKeyError);
    expect(() => keys.sourceFileKey("kb-001", "source/%2e%2e", "intro.md")).toThrow(
      StorageKeyError
    );
    expect(() => keys.sourceRevisionKey("kb-001", "source-001", "../revision")).toThrow(
      StorageKeyError
    );
    expect(() => keys.uploadSessionEntryKey("kb-001", "session\\001", "entry-001")).toThrow(
      StorageKeyError
    );
    expect(() => keys.sourceFileKey("kb-001", "source-001", "not-markdown.txt")).toThrow(
      /Markdown/
    );
  });
});
