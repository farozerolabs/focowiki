import { describe, expect, it } from "vitest";
import { mapGraphSeedDocument } from "../src/search/graph-seed-mapper.js";

describe("graph search seed mapper", () => {
  it("maps existing content-derived graph evidence deterministically", () => {
    const input = {
      knowledgeBaseId: "kb-generic",
      sourceFileId: "source-file-1",
      sourceRevisionId: "source-revision-1",
      logicalPath: "pages/operations/cache.md",
      title: "Cache recovery",
      sourceUrl: "https://example.com/cache",
      lexicalText: "cache recovery failover",
      exactTerms: ["cache", "recovery"],
      phraseTerms: ["cache recovery"],
      explicitReferences: ["pages/operations/failover.md"],
      fingerprint: "a".repeat(64),
      visibleFromEpoch: 4,
      visibleUntilEpoch: null
    };

    const first = mapGraphSeedDocument(input);
    const replay = mapGraphSeedDocument(input);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      knowledgeBaseId: "kb-generic",
      sourceFileId: "source-file-1",
      logicalPath: "pages/operations/cache.md",
      lexicalText: "cache recovery failover",
      visibleFromEpoch: 4
    });
    expect(first.id).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not require metadata or domain-specific fields", () => {
    const document = mapGraphSeedDocument({
      knowledgeBaseId: "kb-generic",
      sourceFileId: "source-file-2",
      sourceRevisionId: "source-revision-2",
      logicalPath: "pages/research/result.md",
      title: "Research result",
      sourceUrl: null,
      lexicalText: "generic research result",
      exactTerms: [],
      phraseTerms: [],
      explicitReferences: [],
      fingerprint: "b".repeat(64),
      visibleFromEpoch: 1,
      visibleUntilEpoch: null
    });

    expect(Object.keys(document)).not.toEqual(expect.arrayContaining([
      "jurisdiction",
      "lawStatus",
      "court"
    ]));
  });
});
