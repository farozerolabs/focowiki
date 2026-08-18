import { describe, expect, it } from "vitest";
import { captureDocumentProjectionOutputOwnerVersions } from
  "../src/document-indexing/infrastructure/document-projection-output-owner-snapshot.js";

describe("document projection output owner snapshot", () => {
  it("captures the owner version observed after a stable render", async () => {
    await expect(captureDocumentProjectionOutputOwnerVersions({
      knowledgeBaseId: "knowledge-base-1",
      renderStartedAt: "2026-08-17T00:00:00.000Z",
      pages: [{ normalizedPath: "_index/index.md" }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      owners: repository({
        version: 3,
        updatedAt: "2026-08-16T23:59:59.000Z"
      })
    })).resolves.toEqual([{
      kind: "page_head",
      key: "_index/index.md",
      expectedVersion: 3
    }]);
  });

  it("rejects an owner changed while the scope was rendering", async () => {
    await expect(captureDocumentProjectionOutputOwnerVersions({
      knowledgeBaseId: "knowledge-base-1",
      renderStartedAt: "2026-08-17T00:00:00.000Z",
      pages: [{ normalizedPath: "_index/index.md" }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      owners: repository({
        version: 4,
        updatedAt: "2026-08-17T00:00:00.001Z"
      })
    })).rejects.toMatchObject({
      code: "projection_scope_changed_during_render"
    });
  });
});

function repository(version: { version: number; updatedAt: string }) {
  return {
    async readVersions(input: {
      owners: readonly { kind: string; key: string }[];
    }) {
      return input.owners.map((owner) => ({ ...owner, ...version }));
    }
  } as never;
}
