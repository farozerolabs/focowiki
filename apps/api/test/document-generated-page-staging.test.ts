import { describe, expect, it, vi } from "vitest";
import {
  createDocumentGeneratedPageStaging,
  type StagedDocumentPage
} from
  "../src/document-indexing/application/document-generated-page-staging.js";
import { generatedPageWriteAttempt, immutableArtifactWriteAttempt } from
  "../src/document-indexing/infrastructure/production-document-processor-support.js";

describe("document generated page staging", () => {
  it("binds a generated-page write attempt to the rendered content", () => {
    const first = generatedPageWriteAttempt(
      "document-job-one",
      "generated-page",
      7,
      "pages/index.md",
      "a".repeat(64)
    );
    const same = generatedPageWriteAttempt(
      "document-job-one",
      "generated-page",
      7,
      "pages/index.md",
      "a".repeat(64)
    );
    const changed = generatedPageWriteAttempt(
      "document-job-one",
      "generated-page",
      7,
      "pages/index.md",
      "b".repeat(64)
    );

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("binds a generated artifact write attempt to its immutable content", () => {
    const first = immutableArtifactWriteAttempt(
      "document-job-one", "first-layer", "a".repeat(64)
    );
    const same = immutableArtifactWriteAttempt(
      "document-job-one", "first-layer", "a".repeat(64)
    );
    const changed = immutableArtifactWriteAttempt(
      "document-job-one", "first-layer", "b".repeat(64)
    );

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("writes changed bytes, reuses identical objects, and returns removed heads", async () => {
    const write = vi.fn(async (page: {
      normalizedPath: string;
      checksumSha256: string;
      byteCount: number;
    }) => ({
      objectId: `object-${page.normalizedPath}`,
      checksumSha256: page.checksumSha256,
      byteCount: page.byteCount
    }));
    const stage = vi.fn(async (pages: ReadonlyArray<Omit<
      StagedDocumentPage, "pageCandidatePublicId"
    >>) =>
      pages.map((page) => ({
        ...page,
        pageCandidatePublicId: `candidate-${page.normalizedPath}`
      })));
    const attach = vi.fn(async () => undefined);
    const staging = createDocumentGeneratedPageStaging({
      writeConcurrency: 1,
      write,
      stage,
      attach
    });

    const result = await staging({
      desired: [page("pages/a.md", "a"), page("pages/b.md", "b")],
      current: [{
        logicalPath: "pages/a.md",
        normalizedPath: "pages/a.md",
        checksumSha256: "a".repeat(64),
        objectId: "object-existing-a"
      }, {
        logicalPath: "pages/removed.md",
        normalizedPath: "pages/removed.md",
        checksumSha256: "c".repeat(64),
        objectId: "object-removed"
      }],
      affectedNormalizedPaths: ["pages/a.md", "pages/b.md", "pages/removed.md"]
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      normalizedPath: "pages/b.md"
    }));
    expect(stage).toHaveBeenCalledWith([
      expect.objectContaining({
        normalizedPath: "pages/a.md",
        objectId: "object-existing-a"
      }),
      expect.objectContaining({
        normalizedPath: "pages/b.md",
        objectId: "object-pages/b.md"
      })
    ]);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(result.removedNormalizedPaths).toEqual(["pages/removed.md"]);
    expect(result.pageCandidates).toHaveLength(2);
  });

  it("writes immutable generated objects with bounded concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const staging = createDocumentGeneratedPageStaging({
      writeConcurrency: 2,
      async write(rendered) {
        active += 1;
        started += 1;
        maximumActive = Math.max(maximumActive, active);
        if (started === 2) release?.();
        await gate;
        active -= 1;
        return {
          objectId: `object-${rendered.normalizedPath}`,
          checksumSha256: rendered.checksumSha256,
          byteCount: rendered.byteCount
        };
      },
      async stage(pages) {
        return pages.map((candidate) => ({
          ...candidate,
          pageCandidatePublicId: `candidate-${candidate.normalizedPath}`
        }));
      },
      async attach() {}
    });

    await staging({
      desired: [page("pages/a.md", "a"), page("pages/b.md", "b"),
        page("pages/c.md", "c")],
      current: [],
      affectedNormalizedPaths: ["pages/a.md", "pages/b.md", "pages/c.md"]
    });

    expect(maximumActive).toBe(2);
  });

  it.each([
    ["first object write", "write:1"],
    ["second object write", "write:2"],
    ["candidate staging", "stage"],
    ["first object attachment", "attach:1"],
    ["second object attachment", "attach:2"]
  ] as const)("does not report a staged result when %s fails", async (_, failurePoint) => {
    const calls: string[] = [];
    let writeCount = 0;
    let attachCount = 0;
    const fail = (point: string): void => {
      calls.push(point);
      if (failurePoint === point) throw new Error(`injected:${point}`);
    };
    const staging = createDocumentGeneratedPageStaging({
      writeConcurrency: 1,
      async write(rendered) {
        writeCount += 1;
        fail(`write:${writeCount}`);
        return {
          objectId: `object-${rendered.normalizedPath}`,
          checksumSha256: rendered.checksumSha256,
          byteCount: rendered.byteCount
        };
      },
      async stage(pages) {
        fail("stage");
        return pages.map((candidate) => ({
          ...candidate,
          pageCandidatePublicId: `candidate-${candidate.normalizedPath}`
        }));
      },
      async attach() {
        attachCount += 1;
        fail(`attach:${attachCount}`);
      }
    });

    await expect(staging({
      desired: [page("pages/a.md", "a"), page("pages/b.md", "b")],
      current: [],
      affectedNormalizedPaths: ["pages/a.md", "pages/b.md"]
    })).rejects.toThrow(`injected:${failurePoint}`);

    const failedAt = calls.indexOf(failurePoint);
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(calls.slice(failedAt + 1)).toEqual([]);
  });
});

function page(path: string, checksum: string) {
  const bytes = new TextEncoder().encode(`# ${path}\n`);
  return {
    logicalPath: path,
    normalizedPath: path,
    entryKind: "source",
    sourceFilePublicId: `source-${path}`,
    sourceRevisionPublicId: `revision-${path}`,
    checksumSha256: checksum.repeat(64),
    byteCount: bytes.byteLength,
    bytes
  };
}
