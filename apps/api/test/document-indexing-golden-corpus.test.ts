import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createSemanticSourceChunks
} from "../src/semantic/graphrag/source-chunks.js";
import {
  selectSemanticSkeleton
} from "../src/semantic/graphrag/skeleton-selector.js";
import { analyzeDocumentSourceMarkdown } from
  "../src/document-indexing/domain/document-source-metadata.js";
import { renderDocumentSourcePage } from
  "../src/document-indexing/application/document-generated-page-renderer.js";
import {
  collectDocumentGeneratedLinkPaths,
  validateDocumentGeneratedLinks
} from
  "../src/document-indexing/application/document-generated-link-validation.js";

type GoldenEntry = {
  fixturePath: string;
  logicalPath: string;
  sha256: string;
  roles: string[];
  stableSampleBucket?: number;
  applyOrder?: number;
};

type GoldenManifest = {
  schemaVersion: string;
  entries: GoldenEntry[];
};

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/document-indexing-golden"
);
const manifest = JSON.parse(readFileSync(
  resolve(fixtureRoot, "manifest.json"),
  "utf8"
)) as GoldenManifest;

describe("document indexing golden corpus", () => {
  it("freezes every fixture by checksum and covers every required role", () => {
    expect(manifest.schemaVersion).toBe("focowiki-document-indexing-golden-v1");
    const roles = new Set<string>();
    for (const entry of manifest.entries) {
      const body = readFileSync(resolve(fixtureRoot, entry.fixturePath));
      expect(sha256(body), entry.fixturePath).toBe(entry.sha256);
      entry.roles.forEach((role) => roles.add(role));
    }
    expect([...roles].sort()).toEqual([
      "ambiguous_reference",
      "duplicate_alias",
      "duplicate_title",
      "empty_body",
      "graphrag_nonselected",
      "graphrag_selected",
      "invalid_frontmatter",
      "metadata_passthrough",
      "mutual_reference_source",
      "mutual_reference_target",
      "nested_navigation_root",
      "nested_path",
      "one_way_reference_source",
      "one_way_reference_target",
      "replacement_history_v1",
      "replacement_history_v2",
      "unrelated",
      "unresolved_reference"
    ]);
  });

  it("pins one selected and one nonselected GraphRAG skeleton decision", () => {
    expect(selection("semantic/selected.md")).toEqual({
      selected: true,
      stableSampleBucket: 148
    });
    expect(selection("semantic/nonselected.md")).toEqual({
      selected: false,
      stableSampleBucket: 4594
    });
  });

  it("keeps deterministic invalid input and replacement history cases", () => {
    expect(readFileSync(resolve(fixtureRoot, "invalid/empty.md"))).toHaveLength(0);
    expect(() => analyzeDocumentSourceMarkdown({
      fileName: "frontmatter.md",
      content: readFileSync(resolve(fixtureRoot, "invalid/frontmatter.md"), "utf8")
    })).toThrow();

    const replacements = manifest.entries
      .filter((entry) => entry.logicalPath === "history/replacement.md")
      .sort((left, right) => (left.applyOrder ?? 0) - (right.applyOrder ?? 0));
    expect(replacements.map((entry) => entry.roles[0])).toEqual([
      "replacement_history_v1",
      "replacement_history_v2"
    ]);
  });

  it("keeps the manually inspectable unrelated source disconnected and evidence links resolvable", () => {
    const unrelatedBody = readFileSync(resolve(fixtureRoot, "unrelated.md"), "utf8");
    const unrelated = renderDocumentSourcePage({
      source: {
        sourceFilePublicId: "source-unrelated",
        logicalPath: "unrelated.md",
        body: unrelatedBody,
        metadata: { type: "document", title: "Independent Notes" },
        sourceMetadata: { title: "Independent Notes" }
      },
      related: [],
      semanticEntities: [],
      removedSourceLogicalPaths: [],
      sourcePathRewrites: []
    });
    const unrelatedMarkdown = new TextDecoder().decode(unrelated.bytes);
    expect(unrelatedMarkdown).toContain(unrelatedBody.trim());
    expect(unrelatedMarkdown).not.toContain("## Related");

    const evidence = renderDocumentSourcePage({
      source: {
        sourceFilePublicId: "source-root",
        logicalPath: "root.md",
        body: readFileSync(resolve(fixtureRoot, "root.md"), "utf8"),
        metadata: { type: "document", title: "Golden Corpus Root" },
        sourceMetadata: { title: "Golden Corpus Root" }
      },
      related: [],
      semanticEntities: [{
        label: "Golden Corpus Root",
        kind: "document",
        description: "The inspected source document.",
        confidence: 1,
        evidencePaths: ["root.md"]
      }],
      removedSourceLogicalPaths: [],
      sourcePathRewrites: []
    });
    expect(new TextDecoder().decode(evidence.bytes)).toContain(
      "[Source evidence](root.md)"
    );
    const pages = [unrelated, evidence].map((page) => ({
        ...page,
        contentType: "text/markdown; charset=utf-8"
      }));
    const destinations = collectDocumentGeneratedLinkPaths(pages);
    expect(destinations).toContain(evidence.logicalPath);
    expect(() => validateDocumentGeneratedLinks({
      pages,
      activeLogicalPaths: destinations
    })).not.toThrow();
  });
});

function selection(fixturePath: string): {
  selected: boolean;
  stableSampleBucket: number;
} {
  const entry = manifest.entries.find((item) => item.fixturePath === fixturePath);
  if (!entry || entry.stableSampleBucket === undefined) {
    throw new Error(`Missing golden selection fixture: ${fixturePath}`);
  }
  const markdown = readFileSync(resolve(fixtureRoot, fixturePath), "utf8");
  const chunks = createSemanticSourceChunks({
    sourceRevisionPublicId: `source-revision-${fixturePath}`,
    markdown,
    maximumChunkCharacters: 64_000,
    maximumChunks: 1
  });
  const result = selectSemanticSkeleton({
    sourceRevisionPublicId: `source-revision-${fixturePath}`,
    logicalPath: entry.logicalPath,
    markdown,
    chunks
  });
  const contentIdentity = sha256(Buffer.from(
    chunks.map((chunk) => chunk.text).join("\u001e")
  ));
  return {
    selected: result.selected,
    stableSampleBucket: Number.parseInt(contentIdentity.slice(0, 8), 16) % 10_000
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
