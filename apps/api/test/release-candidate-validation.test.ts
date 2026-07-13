import { describe, expect, it, vi } from "vitest";

import type { ReleasePublicationRepository } from "../src/application/ports/release-publication-repository.js";
import {
  ReleaseCandidateValidationError,
  assertReleaseCandidate
} from "../src/application/release-candidate-validation.js";

describe("assertReleaseCandidate", () => {
  it("passes a bounded issue limit to the persistence port", async () => {
    const validateRelease = vi.fn(async () => ({ issues: [], truncated: false }));

    await expect(assertReleaseCandidate({
      repository: { validateRelease } as unknown as ReleasePublicationRepository,
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      requireGraph: true,
      issueLimit: 25
    })).resolves.toEqual({ issues: [], truncated: false });

    expect(validateRelease).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      requireGraph: true,
      issueLimit: 25
    });
  });

  it("throws a safe bounded error without persistence details", async () => {
    const validateRelease = vi.fn(async () => ({
      issues: [
        {
          ruleId: "FOCOWIKI-RELEASE-GENERATED-TARGET",
          path: "pages/guide.md",
          message: "Generated target is missing."
        }
      ],
      truncated: true
    }));

    const promise = assertReleaseCandidate({
      repository: { validateRelease } as unknown as ReleasePublicationRepository,
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      requireGraph: false
    });

    await expect(promise).rejects.toBeInstanceOf(ReleaseCandidateValidationError);
    await expect(promise).rejects.toThrow(
      "Release validation failed: FOCOWIKI-RELEASE-GENERATED-TARGET pages/guide.md; additional issues omitted"
    );
    expect(validateRelease).toHaveBeenCalledWith(expect.objectContaining({ issueLimit: 100 }));
  });
});
