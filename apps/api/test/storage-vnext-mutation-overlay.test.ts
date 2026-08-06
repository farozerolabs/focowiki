import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generatedPagePath } from "../src/domain/source-path.js";
import { renderPageFile } from "../src/okf/publication-files.js";
import type { StorageVnextCurrentSourceFact } from
  "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";
import {
  createStorageVnextMutationCandidateCatalog,
  createStorageVnextMutationCandidateGraph,
  overlayStorageVnextMutationCurrentSource
} from "../src/storage-vnext/mutation/candidate-overlay.js";
import {
  adjustStorageVnextDirectoryCountsForSourcePathChange
} from "../src/storage-vnext/mutation/candidate-snapshot.js";
import { buildStorageVnextSearchCandidate } from
  "../src/storage-vnext/search/streaming-builder.js";
import { renderStorageVnextPageArtifact } from
  "../src/storage-vnext/publication/rendering.js";

const encoder = new TextEncoder();

describe("storage vNext mutation candidate overlay", () => {
  it("overlays one file move without changing the supplied current fact", () => {
    const current = sourceFact("file-move", "Guides/Current.md", "# Current\n");
    const overlaid = overlayStorageVnextMutationCurrentSource(
      fileMoveMutation(),
      current
    );

    expect(overlaid.sourceFile).toMatchObject({
      logicalPath: "Archive/Renamed.md",
      normalizedPath: "archive/renamed.md",
      directoryPublicId: "directory-archive",
      revision: 8
    });
    expect(overlaid.sourceRevision).toEqual(current.sourceRevision);
    expect(current.sourceFile).toMatchObject({
      logicalPath: "Guides/Current.md",
      revision: 7
    });
  });

  it("rewrites only source facts inside one moved directory subtree", () => {
    const nested = sourceFact(
      "file-nested",
      "Guides/Nested/Topic.md",
      "# Topic\n"
    );
    const unrelated = sourceFact("file-unrelated", "Other.md", "# Other\n");
    const mutation = directoryMoveMutation();

    expect(overlayStorageVnextMutationCurrentSource(mutation, nested).sourceFile)
      .toMatchObject({
        logicalPath: "Archive/Nested/Topic.md",
        normalizedPath: "archive/nested/topic.md",
        revision: 8
      });
    expect(overlayStorageVnextMutationCurrentSource(mutation, unrelated))
      .toBe(unrelated);
  });

  it("selects the immutable candidate revision for replacement", () => {
    const current = sourceFact("file-replace", "Replace.md", "# Current\n");
    const candidate = {
      ...current.sourceRevision,
      publicId: "revision-replace-candidate",
      objectId: "object-replace-candidate",
      checksum: "c".repeat(64),
      byteCount: 14
    };
    const overlaid = overlayStorageVnextMutationCurrentSource(
      replacementMutation(),
      current,
      candidate
    );

    expect(overlaid.sourceFile).toMatchObject({
      currentRevisionPublicId: "revision-replace-candidate",
      revision: 8
    });
    expect(overlaid.sourceRevision).toBe(candidate);
  });

  it("renders the moved source at the new path through the unchanged page renderer", () => {
    const current = sourceFact("file-move", "Guides/Current.md", "# Current\nBody");
    const overlaid = overlayStorageVnextMutationCurrentSource(
      fileMoveMutation(),
      current
    );
    const page = {
      pagePath: generatedPagePath(overlaid.sourceFile.logicalPath),
      fileId: overlaid.sourceFile.publicId,
      metadata: {
        type: "Guide",
        title: "Renamed",
        description: "Moved guide."
      },
      suggestions: null,
      graphLinks: []
    };
    const input = { page, sourceBody: "# Current\nBody", ordinal: 8 };
    const artifact = renderStorageVnextPageArtifact(input);

    expect(artifact.logicalPath).toBe("pages/Archive/Renamed.md");
    expect(artifact.logicalPath).not.toBe("pages/Guides/Current.md");
    expect(Buffer.from(artifact.bytes).toString("utf8"))
      .toBe(renderPageFile(page, input.sourceBody));
  });

  it("builds a complete unified candidate with new content and graph identities", async () => {
    const moved = sourceFact("file-move", "Guides/Current.md", "# Moved\nbody");
    const unchanged = sourceFact("file-unchanged", "Stable.md", "# Stable\nbody");
    const graphNode: StorageVnextGraphNodeFact = {
      publicId: "node-move",
      knowledgeBaseId: "kb-overlay",
      sourceFilePublicId: "file-move",
      sourceRevisionPublicId: moved.sourceRevision.publicId,
      logicalPath: "pages/Guides/Current.md",
      label: "Moved",
      kind: "page",
      metadata: {},
      evidence: [{
        publicId: "evidence-move",
        sourceFilePublicId: "file-move",
        sourceRevisionPublicId: moved.sourceRevision.publicId,
        logicalPath: "pages/Guides/Current.md",
        startOffset: 0,
        endOffset: 7,
        checksum: moved.sourceRevision.checksum
      }],
      revision: 1
    };
    const catalog = createStorageVnextMutationCandidateCatalog({
      mutation: fileMoveMutation(),
      catalog: {
        listCurrentSources: vi.fn(async () => ({
          items: [moved, unchanged],
          nextCursor: null
        })),
        getSourceRevision: vi.fn(async () => null)
      }
    });
    const graph = createStorageVnextMutationCandidateGraph({
      mutation: fileMoveMutation(),
      graph: {
        listNodes: vi.fn(async () => ({ items: [graphNode], nextCursor: null }))
      }
    });
    const bodies = new Map([
      [moved.sourceRevision.objectId, "# Moved\nbody"],
      [unchanged.sourceRevision.objectId, "# Stable\nbody"]
    ]);
    const batches: Array<{ documents: readonly {
      documentKind: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      logicalPath: string;
    }[] }> = [];

    await buildStorageVnextSearchCandidate({
      knowledgeBaseId: "kb-overlay",
      candidatePublicId: "candidate-overlay",
      operationPublicId: "operation-overlay",
      catalog,
      graph,
      sourceBodies: {
        readVerifiedStream: vi.fn(async (input: { objectId: string }) =>
          (async function* () {
            yield encoder.encode(bodies.get(input.objectId)!);
          })())
      },
      projection: {
        writeDocumentBatch: vi.fn(async (batch) => {
          batches.push(batch);
        })
      },
      sourcePageSize: 10,
      graphPageSize: 10,
      sourceReadConcurrency: 2,
      maxInFlightSourceBytes: 2_000,
      maxSourceBytes: 1_000,
      maxSegmentBytes: 64,
      maxBatchDocuments: 20,
      maxBatchCompressedBytes: 4_096
    });

    const documents = batches.flatMap((batch) => batch.documents);
    expect(new Set(documents.map((document) => document.documentKind)))
      .toEqual(new Set(["content", "graph_seed"]));
    expect(documents.some((document) =>
      document.sourceFilePublicId === "file-unchanged"
      && document.logicalPath === "pages/Stable.md")).toBe(true);
    expect(documents.filter((document) =>
      document.sourceFilePublicId === "file-move"
    ).every((document) =>
      document.logicalPath === "pages/Archive/Renamed.md"
    )).toBe(true);
    expect(documents.some((document) =>
      document.logicalPath.includes("Guides/Current.md"))).toBe(false);
    expect(batches).toHaveLength(1);
  });

  it("moves descendant counts from the old directory to an empty target directory", () => {
    const adjusted = adjustStorageVnextDirectoryCountsForSourcePathChange({
      counts: new Map([
        ["pages", 9],
        ["pages/Guides", 1],
        ["pages/Archive", 0]
      ]),
      currentSourceLogicalPath: "Guides/Current.md",
      candidateSourceLogicalPath: "Archive/Renamed.md",
      sourceCount: 1
    });

    expect(adjusted).toEqual(new Map([
      ["pages", 9],
      ["pages/Guides", 0],
      ["pages/Archive", 1]
    ]));
  });
});

function sourceFact(
  publicId: string,
  logicalPath: string,
  body: string
): StorageVnextCurrentSourceFact {
  const bytes = encoder.encode(body);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const revisionPublicId = `revision-${publicId}`;
  return {
    sourceFile: {
      publicId,
      knowledgeBaseId: "kb-overlay",
      directoryPublicId: logicalPath.startsWith("Guides/") ? "directory-guides" : null,
      logicalPath,
      normalizedPath: logicalPath.toLowerCase(),
      title: publicId,
      metadata: {},
      currentRevisionPublicId: revisionPublicId,
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 7,
      visibility: "current"
    },
    sourceRevision: {
      publicId: revisionPublicId,
      sourceFilePublicId: publicId,
      knowledgeBaseId: "kb-overlay",
      objectId: `object-${publicId}`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  };
}

function fileMoveMutation() {
  return {
    kind: "source_file_move" as const,
    knowledgeBaseId: "kb-overlay",
    targetPublicId: "file-move",
    expectedResourceRevision: 7,
    currentLogicalPath: "Guides/Current.md",
    currentNormalizedPath: "guides/current.md",
    candidateLogicalPath: "Archive/Renamed.md",
    normalizedCandidatePath: "archive/renamed.md",
    candidateDirectoryPublicId: "directory-archive"
  };
}

function directoryMoveMutation() {
  return {
    kind: "source_directory_move" as const,
    knowledgeBaseId: "kb-overlay",
    targetPublicId: "directory-guides",
    expectedResourceRevision: 7,
    currentLogicalPath: "Guides",
    currentNormalizedPath: "guides",
    candidateLogicalPath: "Archive",
    normalizedCandidatePath: "archive"
  };
}

function replacementMutation() {
  return {
    kind: "source_replace" as const,
    knowledgeBaseId: "kb-overlay",
    targetPublicId: "file-replace",
    expectedResourceRevision: 7,
    currentLogicalPath: "Replace.md",
    currentNormalizedPath: "replace.md",
    candidateLogicalPath: null,
    normalizedCandidatePath: null,
    candidateRevisionPublicId: "revision-replace-candidate"
  };
}
