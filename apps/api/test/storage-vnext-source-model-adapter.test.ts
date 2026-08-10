import { describe, expect, it, vi } from "vitest";
import {
  MAXIMUM_SOURCE_METADATA_BYTES,
  measureSourceMetadataBytes
} from "@focowiki/okf";
import {
  createStorageVnextSourceModelAdapter
} from "../src/storage-vnext/source-processing/model-adapter.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";

describe("storage vNext source model adapter", () => {
  it("skips every generation-model path for a non-skeleton source", async () => {
    const suggest = vi.fn(async () => ({ suggestions: null, warningCount: 0 }));
    const onModelAssistanceStart = vi.fn(async () => undefined);
    const extractGraph = vi.fn(async () => ({ node: graphNode(), edges: [] }));
    const adapter = createStorageVnextSourceModelAdapter({
      selectModelAssistance: vi.fn(async () => false),
      suggest,
      extractGraph
    });

    const result = await adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: sourceFile(),
      sourceRevision: sourceRevision(),
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-1",
      body: chunks("# Ordinary source\n\nComplete deterministic retrieval remains available."),
      signal: new AbortController().signal,
      onModelAssistanceStart
    });

    expect(suggest).not.toHaveBeenCalled();
    expect(onModelAssistanceStart).not.toHaveBeenCalled();
    expect(extractGraph).toHaveBeenCalledWith(expect.objectContaining({
      modelAssistanceSelected: false,
      suggestions: null,
      body: "# Ordinary source\n\nComplete deterministic retrieval remains available."
    }));
    expect(result).toMatchObject({
      modelAssistanceUsed: false,
      node: graphNode(),
      edges: []
    });
  });

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
      suggestions: {
        type: "guide",
        title: "Ignored model title",
        description: "Suggested description",
        tags: ["suggested"],
        related_links: [{ path: "pages/operations.md", title: "Operations" }],
        keywords: ["operations"]
      },
      warningCount: 2
    }));
    const extractGraph = vi.fn(async () => ({ node, edges, modelWarningCount: 1 }));
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
        milestones: ["2026-08-01"]
      },
      modelAssistanceUsed: true,
      modelWarningCount: 3,
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

  it("preserves safe irregular OKF fields and never persists model repairs", async () => {
    const body = [
      "---",
      "type: [Guide]",
      "title: 42",
      "sources: invalid",
      "generated: 42",
      "verified: invalid",
      "status: archived",
      "stale_after: tomorrow",
      "runtime: [python]",
      "parameters: invalid",
      "executor: 42",
      "attester: false",
      "future:",
      "  release_date: 2026-08-07",
      "---",
      "# Safe fallback title"
    ].join("\n");
    const node = graphNode();
    const suggest = vi.fn(async () => ({
      suggestions: {
        type: "model-type",
        title: "Model title",
        description: "Model description",
        tags: ["model-tag"],
        related_links: [],
        keywords: []
      },
      warningCount: 0
    }));
    const extractGraph = vi.fn(async () => ({ node, edges: [] }));
    const adapter = createStorageVnextSourceModelAdapter({ suggest, extractGraph });

    const result = await adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: sourceFile(),
      sourceRevision: {
        ...sourceRevision(),
        byteCount: Buffer.byteLength(body)
      },
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-1",
      body: chunks(body),
      signal: new AbortController().signal
    });

    expect(result.metadata).toEqual({
      type: ["Guide"],
      title: 42,
      sources: "invalid",
      generated: 42,
      verified: "invalid",
      status: "archived",
      stale_after: "tomorrow",
      runtime: ["python"],
      parameters: "invalid",
      executor: 42,
      attester: false,
      future: { release_date: "2026-08-07" }
    });
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({
      title: "Safe fallback title",
      type: "document"
    }));
    expect(extractGraph).toHaveBeenCalledWith(expect.objectContaining({
      parsedMetadata: result.metadata,
      resolvedMetadata: expect.objectContaining({
        title: "Safe fallback title",
        type: "document"
      })
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

  it("stores canonical verification events and date-only values in bounded metadata", async () => {
    const body = [
      "---",
      "type: Guide",
      "verified: { by: human:reviewer, at: 2026-08-07T11:00:00Z }",
      "stale_after: 2026-09-23",
      "---",
      "# Verified"
    ].join("\n");
    const adapter = createStorageVnextSourceModelAdapter({
      extractGraph: vi.fn(async () => ({ node: graphNode(), edges: [] }))
    });
    const result = await adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: sourceFile(),
      sourceRevision: { ...sourceRevision(), byteCount: Buffer.byteLength(body) },
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-1",
      body: chunks(body),
      signal: new AbortController().signal
    });

    expect(result.metadata).toMatchObject({
      verified: [{ by: "human:reviewer", at: "2026-08-07T11:00:00.000Z" }],
      stale_after: "2026-09-23"
    });
  });

  it("accepts metadata whole at the shared bound and rejects it whole above the bound", async () => {
    const fitPayload = "x".repeat(MAXIMUM_SOURCE_METADATA_BYTES - 64);
    const fitMetadata = { payload: fitPayload };
    expect(measureSourceMetadataBytes(fitMetadata)).toBeLessThanOrEqual(
      MAXIMUM_SOURCE_METADATA_BYTES
    );
    const extractGraph = vi.fn(async () => ({ node: graphNode(), edges: [] }));
    const adapter = createStorageVnextSourceModelAdapter({ extractGraph });
    const fitBody = `---\npayload: ${fitPayload}\n---\n# Fits`;
    const accepted = await adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: sourceFile(),
      sourceRevision: { ...sourceRevision(), byteCount: Buffer.byteLength(fitBody) },
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-fit",
      body: chunks(fitBody),
      signal: new AbortController().signal
    });
    expect(accepted.metadata.payload).toBe(fitPayload);

    const oversizedPayload = "x".repeat(MAXIMUM_SOURCE_METADATA_BYTES + 1);
    const oversizedBody = `---\npayload: ${oversizedPayload}\n---\n# Too large`;
    await expect(adapter.extract({
      knowledgeBaseId: "kb-1",
      sourceFile: sourceFile(),
      sourceRevision: { ...sourceRevision(), byteCount: Buffer.byteLength(oversizedBody) },
      sourceRevisionPublicId: "revision-1",
      attemptPublicId: "attempt-oversized",
      body: chunks(oversizedBody),
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "metadata_too_large" });
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
