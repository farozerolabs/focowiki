import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextSourceModelAdapter
} from "../src/storage-vnext/source-processing/model-adapter.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";

describe("storage vNext source model adapter", () => {
  it("preserves released Markdown metadata and graph extraction inputs", async () => {
    const body = [
      "---",
      "type: guide",
      "title: Getting started",
      "tags:",
      "  - onboarding",
      "owner:",
      "  team: docs",
      "milestones:",
      "  - 2026-08-01",
      "---",
      "# Getting started",
      "",
      "See [Operations](./operations.md)."
    ].join("\n");
    const node = graphNode();
    const edges: StorageVnextGraphEdgeFact[] = [];
    const suggest = vi.fn(async () => ({
      type: "guide",
      title: "Ignored model title",
      description: "Suggested description",
      tags: ["suggested"],
      related_links: [{ path: "pages/operations.md", title: "Operations" }],
      keywords: ["operations"]
    }));
    const extractGraph = vi.fn(async () => ({ node, edges }));
    const adapter = createStorageVnextSourceModelAdapter({ suggest, extractGraph });

    await expect(adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: {
        publicId: "source-1",
        knowledgeBaseId: "kb-1",
        directoryPublicId: "directory-root",
        logicalPath: "guides/getting-started.md",
        normalizedPath: "guides/getting-started.md",
        title: "getting-started.md",
        metadata: {},
        status: "pending",
        visibility: "current",
        currentRevisionPublicId: "revision-1",
        revision: 1,
        safeErrorCode: null,
        safeErrorMessage: null
      },
      sourceRevision: {
        publicId: "revision-1",
        knowledgeBaseId: "kb-1",
        sourceFilePublicId: "source-1",
        objectId: "object-1",
        checksum: "a".repeat(64),
        byteCount: Buffer.byteLength(body),
        contentType: "text/markdown; charset=utf-8",
        createdAt: "2026-08-02T00:00:00.000Z"
      },
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-1",
      body: chunks(body),
      signal: new AbortController().signal
    })).resolves.toEqual({
      metadata: {
        type: "guide",
        title: "Getting started",
        tags: ["onboarding"],
        owner: { team: "docs" },
        milestones: ["2026-08-01T00:00:00.000Z"]
      },
      node,
      edges
    });

    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-1",
      sourceRevisionPublicId: "revision-1",
      fileName: "getting-started.md",
      title: "Getting started",
      type: "guide",
      tags: ["onboarding"],
      body: "# Getting started\n\nSee [Operations](./operations.md)."
    }));
    expect(extractGraph).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-1",
      sourceRevisionPublicId: "revision-1",
      sourceLogicalPath: "guides/getting-started.md",
      parsedMetadata: expect.objectContaining({
        type: "guide",
        title: "Getting started",
        tags: ["onboarding"],
        owner: { team: "docs" }
      }),
      resolvedMetadata: expect.objectContaining({
        type: "guide",
        title: "Getting started",
        tags: ["onboarding"]
      }),
      suggestions: expect.objectContaining({
        related_links: [{ path: "pages/operations.md", title: "Operations" }]
      }),
      body: "# Getting started\n\nSee [Operations](./operations.md).",
      sourceBody: body
    }));
  });

  it("stops before model or graph work when the request is already aborted", async () => {
    const suggest = vi.fn();
    const extractGraph = vi.fn();
    const adapter = createStorageVnextSourceModelAdapter({ suggest, extractGraph });
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));

    await expect(adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: sourceFile(),
      sourceRevision: sourceRevision(),
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-1",
      body: chunks("# Cancelled"),
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(suggest).not.toHaveBeenCalled();
    expect(extractGraph).not.toHaveBeenCalled();
  });
});

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(value, "utf8");
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.subarray(0, split);
  yield bytes.subarray(split);
}

function sourceFile() {
  return {
    publicId: "source-1",
    knowledgeBaseId: "kb-1",
    directoryPublicId: "directory-root",
    logicalPath: "cancelled.md",
    normalizedPath: "cancelled.md",
    title: "cancelled.md",
    metadata: {},
    status: "pending" as const,
    visibility: "current" as const,
    currentRevisionPublicId: "revision-1",
    revision: 1,
    safeErrorCode: null,
    safeErrorMessage: null
  };
}

function sourceRevision() {
  return {
    publicId: "revision-1",
    knowledgeBaseId: "kb-1",
    sourceFilePublicId: "source-1",
    objectId: "object-1",
    checksum: "a".repeat(64),
    byteCount: 11,
    contentType: "text/markdown; charset=utf-8",
    revision: 1,
    createdAt: "2026-08-02T00:00:00.000Z"
  };
}

function graphNode(): StorageVnextGraphNodeFact {
  return {
    publicId: "graph-node-1",
    knowledgeBaseId: "kb-1",
    sourceFilePublicId: "source-1",
    sourceRevisionPublicId: "revision-1",
    logicalPath: "pages/guides/getting-started.md",
    label: "Getting started",
    kind: "guide",
    metadata: {},
    evidence: [],
    revision: 1
  };
}
