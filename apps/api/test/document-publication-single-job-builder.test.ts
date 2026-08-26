import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { buildDocumentPublicationJob } from
  "../src/document-indexing/application/document-publication-job-builder.js";
import type { DocumentPublicationItemDelta } from
  "../src/document-indexing/application/document-publication-job-plan.js";

describe("single-job publication builder", () => {
  const execFileAsync = promisify(execFile);
  it("produces one deterministic ordered manifest across repeated renders",
    async () => {
      const first = await build(0);
      const second = await build(2);
      expect(second).toEqual(first);
      expect(first.outputs.length).toBeGreaterThan(1);
      expect(first.outputs.map((output) => output.normalizedPath)).toEqual(
        [...first.outputs.map((output) => output.normalizedPath)].sort()
      );
    });

  it("keeps one fingerprint across scheduling capacities and cloned inputs",
    async () => {
      const documents = Array.from({ length: 12 }, (_, index) =>
        document(index));
      const fingerprints = await Promise.all([1, 3, 8].map(async (
        maximumConcurrency
      ) => {
        const input = builderInput(structuredClone(documents));
        const originalRender = input.render;
        const result = await buildDocumentPublicationJob({
          ...input,
          maximumConcurrency,
          async render(scope, options, signal) {
            const delay = maximumConcurrency === 1
              ? 0 : Math.abs(scope.key.length * 7 % 5);
            if (delay > 0) await new Promise((resolve) =>
              setTimeout(resolve, delay));
            void options;
            void signal;
            return originalRender(scope);
          }
        });
        return result.fingerprintSha256;
      }));
      expect(new Set(fingerprints)).toEqual(new Set([fingerprints[0]]));
    });

  it("rejects an invalid scheduling capacity", async () => {
    await expect(buildDocumentPublicationJob({
      ...builderInput([document(0)]), maximumConcurrency: 0
    })).rejects.toMatchObject({
      code: "publication_builder_concurrency_invalid"
    });
  });

  it("recomputes the same manifest fingerprint in a separate process",
    async () => {
      const result = await build(0);
      const script = [
        "import { fingerprintDocumentPublicationOutputs } from",
        "'./src/document-indexing/application/document-publication-manifest.ts';",
        "const outputs = JSON.parse(process.env.PUBLICATION_OUTPUTS_JSON);",
        "process.stdout.write(fingerprintDocumentPublicationOutputs(outputs));"
      ].join(" ");
      const child = await execFileAsync(process.execPath, [
        "--import", "tsx", "--input-type=module", "--eval", script
      ], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          PUBLICATION_OUTPUTS_JSON: JSON.stringify(result.outputs)
        }
      });
      expect(child.stdout).toBe(result.fingerprintSha256);
    });

  it("keeps an explicit predecessor deletion in the normalized manifest",
    async () => {
      const result = await build(0, "move");
      expect(result.outputs).toContainEqual(expect.objectContaining({
        normalizedPath: "pages/old.md",
        action: "delete"
      }));
    });

  it("reuses active base pages only for delta jobs", async () => {
    const readBasePages = vi.fn(async () => []);
    await buildDocumentPublicationJob({
      ...builderInput([document(0)]),
      baseActiveRevision: 1,
      readBasePages
    });
    expect(readBasePages).toHaveBeenCalled();

    readBasePages.mockClear();
    await buildDocumentPublicationJob({
      ...builderInput([document(0)]),
      baseActiveRevision: 0,
      readBasePages
    });
    expect(readBasePages).not.toHaveBeenCalled();
  });

  it("passes the active base event time to every delta renderer", async () => {
    const input = builderInput([document(0)]);
    const render = vi.fn(input.render);
    await buildDocumentPublicationJob({
      ...input,
      baseDeterministicChangedAt: "2026-08-25T11:00:00.000Z",
      render
    });

    expect(render).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        baseDeterministicChangedAt: "2026-08-25T11:00:00.000Z"
      }),
      expect.any(AbortSignal)
    );
  });

  it("bounds dependency-ready base reads and renders to eight", async () => {
    let active = 0;
    let maximumActive = 0;
    const input = builderInput(Array.from({ length: 24 }, (_, index) =>
      document(index)));
    await buildDocumentPublicationJob({
      ...input,
      baseActiveRevision: 1,
      async readBasePages() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return [];
      }
    });
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it("aggregates object writes, requests, bytes, and reuse per job", async () => {
    const input = builderInput([document(0)]);
    let renderCount = 0;
    const result = await buildDocumentPublicationJob({
      ...input,
      async render(scope) {
        renderCount += 1;
        const rendered = await input.render(scope);
        return {
          ...rendered,
          objectReuseCount: 2,
          storageRequests: {
            put: 1, head: 1, verification: 1, attemptedBytes: 100
          }
        };
      }
    });
    expect(result).toMatchObject({
      objectPutCount: renderCount,
      objectReuseCount: renderCount * 2,
      objectRequestCount: renderCount * 3,
      objectAttemptedBytes: renderCount * 100
    });
  });

  it("preserves navigation mutations when a deleted directory has no page",
    async () => {
      const deleted = {
        ...document(0),
        operation: "delete" as const,
        priorLogicalPath: "temporary-e2e/document.md",
        nextLogicalPath: null
      };
      const input = builderInput([deleted]);
      const originalRender = input.render;
      const result = await buildDocumentPublicationJob({
        ...input,
        async render(scope) {
          if (scope.kind === "directory"
            && scope.key === "pages/temporary-e2e") {
            return {
              outputFingerprintSha256: "a".repeat(64),
              pages: [],
              removedNormalizedPaths: [
                "pages/temporary-e2e/index.md"
              ],
              navigationMutations: [{
                directoryPath: "pages",
                removedChildPath: "pages/temporary-e2e"
              }]
            };
          }
          return originalRender(scope);
        }
      });

      expect(result.outputs).toContainEqual(expect.objectContaining({
        normalizedPath: "pages/temporary-e2e/index.md",
        action: "delete",
        navigationMutations: [{
          directoryPath: "pages",
          removedChildPath: "pages/temporary-e2e"
        }]
      }));
    });

  it("renders each shared relationship scope once at the 256-item limit",
    async () => {
      const documents = Array.from({ length: 256 }, (_, index) => ({
        ...document(index),
        nextLogicalPath: `large-directory/document-${index}.md`,
        relatedSourceFilePublicIds: ["shared-neighbor"] as const,
        priorGraphDirectoryPaths: ["pages/large-directory"] as const,
        nextGraphDirectoryPaths: ["pages/large-directory"] as const
      }));
      const input = builderInput(documents);
      const renderedScopes: string[] = [];
      const originalRender = input.render;
      await buildDocumentPublicationJob({
        ...input,
        async render(scope) {
          renderedScopes.push(`${scope.kind}:${scope.key}`);
          return originalRender(scope);
        }
      });

      expect(renderedScopes.filter((scope) =>
        scope === "_graph:shared-neighbor")).toHaveLength(1);
      expect(renderedScopes.filter((scope) =>
        scope === "directory:pages/large-directory")).toHaveLength(1);
      expect(new Set(renderedScopes).size).toBe(renderedScopes.length);
    });
});

function builderInput(documents: readonly DocumentPublicationItemDelta[]) {
  return {
    jobPublicId: "publication-job-concurrency",
    knowledgeBaseId: "publication-builder-kb",
    baseActiveRevision: 1,
    targetReadinessSequence: documents.length,
    rendererContractVersion: "portable-okf-v2",
    deterministicChangedAt: "2026-08-25T12:00:00.000Z",
    documents,
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    async render(scope: { kind: string; key: string }) {
      const identity = `${scope.kind}-${scope.key}`
        .toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]+/gu, "-");
      const checksum = createHash("sha256").update(identity).digest("hex");
      return {
        outputFingerprintSha256: checksum,
        pages: [{
          logicalPath: `generated/${identity}.md`,
          normalizedPath: `generated/${identity}.md`,
          entryKind: "test-page",
          objectId: `object-${identity}`,
          checksumSha256: checksum,
          byteCount: identity.length
        }],
        removedNormalizedPaths: [],
        navigationMutations: []
      };
    },
    async readObjectMetadata(objectIds: readonly string[]) {
      return objectIds.map((objectId) => ({
        objectId,
        contentType: "text/markdown; charset=utf-8"
      }));
    },
    async readBasePages() { return []; }
  };
}

function document(index: number) {
  return {
    mutationPublicId: `builder-mutation-${index}`,
    documentJobPublicId: `builder-document-job-${index}`,
    sourceFilePublicId: `builder-source-${index}`,
    sourceRevisionPublicId: `builder-revision-${index}`,
    readinessSequence: index + 1,
    operation: "create" as const,
    priorLogicalPath: null,
    nextLogicalPath: `directory-${index}/new.md`,
    priorTermBuckets: [] as const,
    nextTermBuckets: ["latin"] as const,
    relatedSourceFilePublicIds: [] as const,
    priorGraphDirectoryPaths: [] as const,
    nextGraphDirectoryPaths: [] as const
  };
}

async function build(delayMilliseconds: number, operation = "create") {
  return buildDocumentPublicationJob({
    jobPublicId: "publication-job-builder",
    knowledgeBaseId: "publication-builder-kb",
    baseActiveRevision: 0,
    targetReadinessSequence: 1,
    rendererContractVersion: "portable-okf-v2",
    deterministicChangedAt: "2026-08-25T12:00:00.000Z",
    documents: [{
      mutationPublicId: "builder-mutation",
      documentJobPublicId: "builder-document-job",
      sourceFilePublicId: "builder-source",
      sourceRevisionPublicId: "builder-revision",
      readinessSequence: 1,
      operation: operation as "create" | "move",
      priorLogicalPath: operation === "move" ? "old.md" : null,
      nextLogicalPath: "new.md",
      priorTermBuckets: [],
      nextTermBuckets: [],
      relatedSourceFilePublicIds: [],
      priorGraphDirectoryPaths: [],
      nextGraphDirectoryPaths: []
    }],
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    async render(scope) {
      if (delayMilliseconds > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
      }
      const identity = `${scope.kind}-${scope.key}`
        .toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]+/gu, "-");
      const checksum = createHash("sha256").update(identity).digest("hex");
      return {
        outputFingerprintSha256: checksum,
        pages: [{
          logicalPath: `generated/${identity}.md`,
          normalizedPath: `generated/${identity}.md`,
          entryKind: "test-page",
          objectId: `object-${identity}`,
          checksumSha256: checksum,
          byteCount: identity.length
        }],
        removedNormalizedPaths: [],
        navigationMutations: []
      };
    },
    async readObjectMetadata(objectIds) {
      return objectIds.map((objectId) => ({
        objectId,
        contentType: "text/markdown; charset=utf-8"
      }));
    },
    async readBasePages() {
      return [];
    }
  });
}
