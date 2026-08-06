import { presentGraphRelationship } from "@focowiki/okf";
import { describe, expect, it } from "vitest";
import { renderPageFile } from "../src/okf/publication-files.js";
import {
  assembleStorageVnextPageArtifact
} from "../src/storage-vnext/publication/page-artifact.js";
import type {
  StorageVnextCurrentSourceFact
} from "../src/storage-vnext/catalog/ports.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";

describe("storage vNext publication page artifact", () => {
  it("removes a source Markdown link when its target was deleted", () => {
    const current = currentSource();
    const setup = graphNode({
      publicId: "node-setup",
      sourceFilePublicId: "source-setup",
      sourceRevisionPublicId: "revision-setup",
      logicalPath: "pages/guides/setup.md",
      label: "Setup"
    });

    const artifact = assembleStorageVnextPageArtifact({
      current,
      node: setup,
      neighborhood: [],
      endpointNodes: [setup],
      sourceBody: "# Setup\n\nRead [removed reference](../reference/removed.md).",
      removedSourceLogicalPaths: ["pages/reference/removed.md"],
      ordinal: 7,
      relatedFileLimit: 10
    });
    const body = Buffer.from(artifact.bytes).toString("utf8");

    expect(body).toContain("Read removed reference.");
    expect(body).not.toContain("/pages/reference/removed.md");
  });

  it("removes reference-style source links when their target was deleted", () => {
    const current = currentSource();
    const setup = graphNode({
      publicId: "node-setup",
      sourceFilePublicId: "source-setup",
      sourceRevisionPublicId: "revision-setup",
      logicalPath: "pages/guides/setup.md",
      label: "Setup"
    });

    const artifact = assembleStorageVnextPageArtifact({
      current,
      node: setup,
      neighborhood: [],
      endpointNodes: [setup],
      sourceBody: [
        "# Setup",
        "",
        "Read [removed reference][removed].",
        "",
        "[removed]: ../reference/removed.md"
      ].join("\n"),
      removedSourceLogicalPaths: ["pages/reference/removed.md"],
      ordinal: 7,
      relatedFileLimit: 10
    });
    const body = Buffer.from(artifact.bytes).toString("utf8");

    expect(body).toContain("Read removed reference.");
    expect(body).not.toContain("[removed]");
    expect(body).not.toContain("/pages/reference/removed.md");
  });

  it("reuses the released source-backed page mapping with direction-aware graph links", () => {
    const current = currentSource();
    const setup = graphNode({
      publicId: "node-setup",
      sourceFilePublicId: "source-setup",
      sourceRevisionPublicId: "revision-setup",
      logicalPath: "pages/guides/setup.md",
      label: "Setup",
      metadata: {
        presentationSuggestion: {
          description: "Install and configure the service."
        },
        contentProfile: {
          summary: "Setup explains installation and configuration."
        }
      }
    });
    const configuration = graphNode({
      publicId: "node-configuration",
      sourceFilePublicId: "source-configuration",
      sourceRevisionPublicId: "revision-configuration",
      logicalPath: "pages/reference/configuration.md",
      label: "Configuration"
    });
    const overview = graphNode({
      publicId: "node-overview",
      sourceFilePublicId: "source-overview",
      sourceRevisionPublicId: "revision-overview",
      logicalPath: "pages/overview.md",
      label: "Overview"
    });
    const outgoing = graphEdge({
      publicId: "edge-setup-configuration",
      fromNodePublicId: setup.publicId,
      toNodePublicId: configuration.publicId,
      relation: "references",
      reason: "Setup describes the available configuration.",
      source: "deterministic",
      metadata: { signal: "direct_reference" }
    });
    const incoming = graphEdge({
      publicId: "edge-overview-setup",
      fromNodePublicId: overview.publicId,
      toNodePublicId: setup.publicId,
      relation: "process_adjacent",
      reason: "Overview introduces setup as the next step.",
      source: "model_confirmed",
      metadata: { excerpt: "Continue with setup." }
    });
    const sourceBody = "# Old heading\n\nKeep this source body readable.";

    const artifact = assembleStorageVnextPageArtifact({
      current,
      node: setup,
      neighborhood: [incoming, outgoing],
      endpointNodes: [overview, setup, configuration],
      sourceBody,
      ordinal: 7,
      relatedFileLimit: 10
    });

    const outgoingLink = presentGraphRelationship({
      from: endpoint(setup),
      to: endpoint(configuration),
      relationType: outgoing.relation,
      weight: outgoing.weight,
      reason: outgoing.reason!,
      source: outgoing.source!,
      evidence: outgoing.metadata!
    }, setup.sourceFilePublicId);
    const incomingLink = presentGraphRelationship({
      from: endpoint(overview),
      to: endpoint(setup),
      relationType: incoming.relation,
      weight: incoming.weight,
      reason: incoming.reason!,
      source: incoming.source!,
      evidence: incoming.metadata!
    }, setup.sourceFilePublicId);
    const expected = renderPageFile({
      pagePath: "pages/guides/setup.md",
      fileId: "source-setup",
      metadata: {
        type: "Guide",
        title: "Setup",
        description: "Install and configure the service."
      },
      suggestions: null,
      graphLinks: [outgoingLink, incomingLink]
    }, sourceBody);

    expect(artifact).toMatchObject({
      logicalPath: "pages/guides/setup.md",
      kind: "source",
      sourceFilePublicId: "source-setup",
      ordinal: 7
    });
    expect(Buffer.from(artifact.bytes).toString("utf8")).toBe(expected);
    expect(expected).toContain("# Setup");
    expect(expected).toContain("Keep this source body readable.");
    expect(expected).toContain(
      "From \"Setup\" to \"Configuration\": Setup describes the available configuration."
    );
    expect(expected).toContain(
      "Incoming from \"Overview\" to \"Setup\": Overview introduces setup as the next step."
    );
  });
});

function currentSource(): StorageVnextCurrentSourceFact {
  return {
    sourceFile: {
      publicId: "source-setup",
      knowledgeBaseId: "kb-one",
      directoryPublicId: "directory-guides",
      logicalPath: "guides/setup.md",
      normalizedPath: "guides/setup.md",
      title: "Setup",
      metadata: { type: "Guide", title: "Setup" },
      currentRevisionPublicId: "revision-setup",
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 2,
      visibility: "current"
    },
    sourceRevision: {
      publicId: "revision-setup",
      sourceFilePublicId: "source-setup",
      knowledgeBaseId: "kb-one",
      objectId: "object-setup",
      checksum: "a".repeat(64),
      byteCount: 49,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-02T00:00:00.000Z"
    }
  };
}

function graphNode(
  input: Pick<
    StorageVnextGraphNodeFact,
    | "publicId"
    | "sourceFilePublicId"
    | "sourceRevisionPublicId"
    | "logicalPath"
    | "label"
  > & Partial<Pick<StorageVnextGraphNodeFact, "metadata">>
): StorageVnextGraphNodeFact {
  return {
    ...input,
    knowledgeBaseId: "kb-one",
    kind: "Guide",
    metadata: input.metadata ?? {},
    evidence: [],
    revision: 1
  };
}

function graphEdge(
  input: Pick<
    StorageVnextGraphEdgeFact,
    | "publicId"
    | "fromNodePublicId"
    | "toNodePublicId"
    | "relation"
    | "reason"
    | "source"
    | "metadata"
  >
): StorageVnextGraphEdgeFact {
  return {
    ...input,
    knowledgeBaseId: "kb-one",
    weight: 1,
    evidence: [],
    revision: 1
  };
}

function endpoint(node: StorageVnextGraphNodeFact) {
  return {
    fileId: node.sourceFilePublicId,
    path: node.logicalPath,
    title: node.label
  };
}
