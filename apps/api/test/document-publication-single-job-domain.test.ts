import { describe, expect, it } from "vitest";
import {
  DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS,
  DOCUMENT_PUBLICATION_ITEM_LIMIT,
  DOCUMENT_PUBLICATION_ITEM_OUTCOMES,
  DOCUMENT_PUBLICATION_JOB_OUTCOMES,
  assertOneNonterminalPublicationJob,
  freezeDocumentPublicationMembership,
  publicationAttemptDeadline,
  publicationRetryDelayMilliseconds
} from "../src/document-indexing/domain/document-publication-job.js";

describe("single-job publication domain", () => {
  it("keeps the replacement state machines finite", () => {
    expect(DOCUMENT_PUBLICATION_ITEM_OUTCOMES).toEqual([
      "pending", "committed", "failed", "superseded"
    ]);
    expect(DOCUMENT_PUBLICATION_JOB_OUTCOMES).toEqual([
      "pending", "committed", "failed"
    ]);
  });

  it("freezes an immutable readiness-ordered membership at 256 items", () => {
    const items = Array.from({ length: 300 }, (_, index) => ({
      publicId: `publication-item-${String(index).padStart(3, "0")}`,
      readinessSequence: 300 - index
    }));
    const membership = freezeDocumentPublicationMembership(items);

    expect(DOCUMENT_PUBLICATION_ITEM_LIMIT).toBe(256);
    expect(membership).toHaveLength(256);
    expect(membership[0]?.readinessSequence).toBe(1);
    expect(membership.at(-1)?.readinessSequence).toBe(256);
    expect(Object.isFrozen(membership)).toBe(true);
    expect(() => (membership as unknown as { publicId: string }[]).push({
      publicId: "late-arrival"
    })).toThrow();
    expect(membership.some((item) => item.publicId === "late-arrival"))
      .toBe(false);
  });

  it("rejects a second nonterminal job for one knowledge base", () => {
    expect(() => assertOneNonterminalPublicationJob([
      { knowledgeBaseId: "kb-a", outcome: "pending" },
      { knowledgeBaseId: "kb-a", outcome: "pending" }
    ])).toThrowError(expect.objectContaining({
      code: "publication_job_owner_conflict"
    }));
    expect(() => assertOneNonterminalPublicationJob([
      { knowledgeBaseId: "kb-a", outcome: "committed" },
      { knowledgeBaseId: "kb-a", outcome: "pending" },
      { knowledgeBaseId: "kb-b", outcome: "pending" }
    ])).not.toThrow();
  });

  it("uses a renewable ninety-second attempt deadline and three retries", () => {
    const claimedAt = "2026-08-25T10:00:00.000Z";
    expect(DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS).toBe(90 * 1_000);
    expect(publicationAttemptDeadline(claimedAt))
      .toBe("2026-08-25T10:01:30.000Z");
    expect(publicationRetryDelayMilliseconds(1)).toBe(1_000);
    expect(publicationRetryDelayMilliseconds(2)).toBe(2_000);
    expect(publicationRetryDelayMilliseconds(3)).toBe(4_000);
    expect(() => publicationRetryDelayMilliseconds(4)).toThrowError(
      expect.objectContaining({ code: "publication_attempt_limit_exceeded" })
    );
  });
});
