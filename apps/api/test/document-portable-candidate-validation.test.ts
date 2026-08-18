import { createHash } from "node:crypto";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  portableDirectoryResourceSubject,
  portableSemanticResourceFileName
} from "@focowiki/okf";
import {
  collectDocumentPortableReferencedPagePaths,
  validateDocumentPortableCandidate
} from "../src/document-indexing/application/document-portable-candidate-validation.js";

describe("document portable candidate validation", () => {
  it("accepts readable semantic routes and exact document integrity", () => {
    const source = page("pages/guides/a.md", "# A\n");
    const documents = documentPacket(source);
    const byFile = jsonPage("_graph/by-file/guides/a.json", {
      formatVersion: 2,
      title: "A relationships",
      path: source.logicalPath,
      indexPath: "_index/pages/guides/index.json",
      directoryGraphPath: "_graph/by-directory/guides/index.json",
      relationships: []
    });
    expect(collectDocumentPortableReferencedPagePaths([documents, byFile]))
      .toEqual([
        "_graph/by-directory/guides/index.json",
        "_index/pages/guides/index.json",
        source.logicalPath
      ]);
    expect(() => validateDocumentPortableCandidate({
      pages: [source, documents, byFile],
      activeReadablePagePaths: [
        "_index/pages/guides/index.json",
        "_graph/by-directory/guides/index.json"
      ]
    })).not.toThrow();
  });

  it("blocks an orphan target before an incorrect mirrored graph location", () => {
    const source = page("pages/a.md", "# A\n");
    const byFile = jsonPage("_graph/by-file/wrong.json", {
      formatVersion: 2,
      title: "A relationships",
      path: source.logicalPath,
      indexPath: "_index/pages/index.json",
      directoryGraphPath: "_graph/by-directory/index.json",
      relationships: [{
        targetPath: "pages/missing.md",
        targetTitle: "Missing",
        direction: "outgoing",
        relationType: "references",
        weight: 1,
        reason: "A explicitly references Missing.",
        evidence: [{ path: source.logicalPath }]
      }]
    });
    expect(() => validateDocumentPortableCandidate({
      pages: [source, byFile],
      activeReadablePagePaths: [
        "_index/pages/index.json",
        "_graph/by-directory/index.json"
      ]
    })).toThrow(expect.objectContaining({
      code: "portable_endpoint_unreadable",
      resourcePath: "_graph/by-file/wrong.json",
      targetPath: "pages/missing.md"
    }));
  });

  it("blocks a document record that does not describe exact page bytes", () => {
    const source = page("pages/a.md", "# A\n");
    const documents = documentPacket(source, {
      checksumSha256: "0".repeat(64)
    });
    expect(() => validateDocumentPortableCandidate({
      pages: [source, documents],
      activeReadablePagePaths: []
    })).toThrow(expect.objectContaining({
      code: "portable_document_integrity_mismatch"
    }));
  });

  it("blocks a catalog route that is not present in the same closure", () => {
    const catalog = jsonPage("_index/catalog.json", {
      formatVersion: 2,
      title: "Knowledge index",
      resources: [{
        kind: "page_directories",
        title: "Documents",
        path: "_index/pages/index.json",
        description: "Directory routes to original Markdown documents."
      }]
    });
    expect(() => validateDocumentPortableCandidate({
      pages: [catalog],
      activeReadablePagePaths: []
    })).toThrow(expect.objectContaining({
      code: "portable_route_unreadable",
      targetPath: "_index/pages/index.json"
    }));
  });

  it("blocks duplicate document paths in one semantic packet", () => {
    const source = page("pages/a.md", "# A\n");
    const packet = documentPacket(source);
    const value = JSON.parse(new TextDecoder().decode(packet.bytes));
    value.documents.push({ ...value.documents[0] });
    const duplicate = jsonPage(packet.logicalPath, value);

    expect(() => validateDocumentPortableCandidate({
      pages: [source, duplicate],
      activeReadablePagePaths: []
    })).toThrow(expect.objectContaining({ code: "portable_record_invalid" }));
  });
});

function documentPacket(
  source: ReturnType<typeof page>,
  override: Record<string, unknown> = {}
) {
  const scopePath = posix.dirname(source.logicalPath);
  const machineDirectory = `_index/pages${scopePath === "pages"
    ? "" : scopePath.slice("pages".length)}`;
  const resourceName = portableSemanticResourceFileName({
    subject: portableDirectoryResourceSubject(scopePath),
    family: "documents"
  });
  return jsonPage(`${machineDirectory}/${resourceName}`, {
    formatVersion: 2,
    title: "Documents",
    scopePath,
    documents: [{
      path: source.logicalPath,
      title: "A",
      summary: "A",
      type: "document",
      subjects: [],
      tags: [],
      metadata: {},
      headings: ["A"],
      keywords: [],
      entities: [],
      contentType: "text/markdown; charset=utf-8",
      checksumSha256: source.checksumSha256,
      byteCount: source.byteCount,
      relationshipCount: 1,
      graphPath: `_graph/by-file/${source.logicalPath
        .slice("pages/".length, -".md".length)}.json`,
      ...override
    }]
  });
}

function page(logicalPath: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    logicalPath,
    bytes,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function jsonPage(logicalPath: string, value: unknown) {
  return page(logicalPath, JSON.stringify(value) + "\n");
}
