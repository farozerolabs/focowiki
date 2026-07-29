import { describe, expect, it } from "vitest";
import {
  mapMarkdownContentSegments
} from "../src/search/content-segment-mapper.js";
import {
  createContentProjectionRecord,
  createGraphProjectionRecord
} from "../src/search/search-projection-record.js";

describe("search projection records", () => {
  it("uses the same stable content identity for generation-backed segments", () => {
    const input = {
      action: "upsert" as const,
      knowledgeBaseId: "kb-one",
      sourceFileId: "source-one",
      sourceRevisionId: "revision-one",
      pathRevision: 3,
      logicalPath: "pages/guides/start.md",
      fileKind: "source",
      title: "Start",
      heading: "Install",
      body: "Install the application.",
      metadata: { audience: "developers" },
      sourceUrl: "https://example.com/start",
      checksumSha256: "a".repeat(64),
      segmentOrdinal: 0,
      segmentTotal: 1,
      activeEpoch: 2,
      pendingEpoch: 3
    };
    const expected = [...mapMarkdownContentSegments({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      sourceRevisionId: input.sourceRevisionId,
      pathRevision: input.pathRevision,
      logicalPath: input.logicalPath,
      fileKind: input.fileKind,
      content: input.body,
      title: input.title,
      metadata: input.metadata,
      sourceUrl: input.sourceUrl,
      checksumSha256: input.checksumSha256,
      visibleFromEpoch: input.pendingEpoch,
      visibleUntilEpoch: null,
      maxSegmentBytes: 4_096
    })][0]!;

    const record = createContentProjectionRecord(input);

    expect(record.key).toBe("content:upsert:revision-one:3:0");
    expect(record.document).toMatchObject({
      id: expected.id,
      visibleFromEpoch: 3,
      visibleUntilEpoch: null,
      headingPath: ["Install"],
      segmentOrdinal: 0,
      segmentTotal: 1
    });
  });

  it("closes the prior content identity at the pending epoch", () => {
    const record = createContentProjectionRecord({
      action: "close",
      knowledgeBaseId: "kb-one",
      sourceFileId: "source-one",
      sourceRevisionId: "revision-old",
      pathRevision: 2,
      logicalPath: "pages/old.md",
      fileKind: "source",
      title: "Old",
      heading: null,
      body: "Old body",
      metadata: {},
      sourceUrl: null,
      checksumSha256: "b".repeat(64),
      segmentOrdinal: 0,
      segmentTotal: 1,
      activeEpoch: 2,
      pendingEpoch: 3
    });

    expect(record.document).toMatchObject({
      visibleFromEpoch: 1,
      visibleUntilEpoch: 3
    });
  });

  it("keeps moved content closure and replacement identities independent", () => {
    const common = {
      knowledgeBaseId: "kb-one",
      sourceFileId: "source-one",
      sourceRevisionId: "revision-one",
      fileKind: "source",
      title: "Moved",
      heading: null,
      body: "Stable body",
      metadata: {},
      sourceUrl: null,
      checksumSha256: "c".repeat(64),
      segmentOrdinal: 0,
      segmentTotal: 1,
      activeEpoch: 2,
      pendingEpoch: 3
    };
    const closed = createContentProjectionRecord({
      ...common,
      action: "close",
      pathRevision: 2,
      logicalPath: "pages/old.md"
    });
    const moved = createContentProjectionRecord({
      ...common,
      action: "upsert",
      pathRevision: 3,
      logicalPath: "pages/new.md"
    });

    expect(closed.document.id).not.toBe(moved.document.id);
    expect(closed.document.visibleUntilEpoch).toBe(3);
    expect(moved.document.visibleFromEpoch).toBe(3);
  });

  it("maps graph seed facts without domain-specific fields", () => {
    const record = createGraphProjectionRecord({
      action: "upsert",
      knowledgeBaseId: "kb-one",
      sourceFileId: "source-one",
      sourceRevisionId: "revision-one",
      logicalPath: "pages/reference.md",
      title: "Reference",
      sourceUrl: null,
      lexicalText: "product architecture dependency",
      exactTerms: ["architecture", "product"],
      phraseTerms: ["product architecture"],
      explicitReferences: ["pages/start.md"],
      fingerprint: "c".repeat(64),
      activeEpoch: 0,
      pendingEpoch: 1
    });

    expect(record.key).toBe("graph:upsert:source-one");
    expect(record.document).toMatchObject({
      sourceFileId: "source-one",
      visibleFromEpoch: 1,
      visibleUntilEpoch: null
    });
  });

  it("creates a new graph identity when a file path changes", () => {
    const base = {
      action: "upsert" as const,
      knowledgeBaseId: "kb-one",
      sourceFileId: "source-one",
      sourceRevisionId: "revision-one",
      title: "Reference",
      sourceUrl: null,
      lexicalText: "product architecture dependency",
      exactTerms: ["architecture"],
      phraseTerms: ["product architecture"],
      explicitReferences: [],
      fingerprint: "d".repeat(64),
      activeEpoch: 2,
      pendingEpoch: 3
    };

    const original = createGraphProjectionRecord({
      ...base,
      logicalPath: "pages/old.md"
    });
    const moved = createGraphProjectionRecord({
      ...base,
      logicalPath: "pages/new.md"
    });

    expect(original.document.id).not.toBe(moved.document.id);
  });
});
