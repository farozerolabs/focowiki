import { describe, expect, it } from "vitest";
import { createDeveloperOpenApiDocument } from "../src/developer-openapi/openapi-document.js";
import {
  renderIndexFile,
  renderPageFile,
  renderSchemaFile
} from "../src/okf/publication-files.js";
import { renderBoundedRootFile } from "../src/publication/bounded-root-writer.js";
import {
  presentOpenApiGeneratedFile,
  presentOpenApiSearchResult
} from "../src/storage-vnext/api/openapi-presenters.js";
import * as searchDocuments from "../src/storage-vnext/search/documents.js";
import * as candidateValidator from
  "../src/storage-vnext/publication/candidate-validator.js";

const normalizedSignals = {
  effectiveStatus: "stable" as const,
  trustTier: "human-reviewed" as const,
  isStale: false,
  staleAfter: "2026-09-23",
  generatedAt: "2026-08-07T10:00:00.000Z",
  generatedAtSource: "generated" as const,
  latestVerifiedAt: "2026-08-07T11:00:00.000Z",
  sourceCount: 1
};

const compactSignals: {
  status: "stable";
  trustTier: "machine-confirmed" | "human-reviewed";
  staleAfterEpochDay: number;
  generatedAtEpochMs: number;
  latestVerifiedAtEpochMs: number;
  sourceCount: number;
} = {
  status: "stable" as const,
  trustTier: "human-reviewed" as const,
  staleAfterEpochDay: 20719,
  generatedAtEpochMs: 1786096800000,
  latestVerifiedAtEpochMs: 1786100400000,
  sourceCount: 1
};

describe("OKF 0.2 publication writers", () => {
  it("emits native 0.2 and canonical generated metadata from both root writers", () => {
    const standard = renderIndexFile([], "2026-08-07T10:00:00Z", "Knowledge base").content;
    const boundedInput = {
      path: "index.md",
      knowledgeBase: {
        id: "kb-a",
        name: "Knowledge base",
        description: null,
        sourceFileCount: 0,
        graphEdgeCount: 0
      },
      rootEntryCount: 0,
      generationId: "generation-a",
      changedAt: "2026-08-07T10:00:00Z"
    };
    const bounded = renderBoundedRootFile(boundedInput).body;

    for (const body of [standard, bounded]) {
      expect(body).toContain('okf_version: "0.2"');
      expect(body).not.toContain("Generated at:");
      expect(body.split("---")[1]?.trim()).toBe('okf_version: "0.2"');
    }
    for (const body of [
      renderSchemaFile("Knowledge base", "2026-08-07T10:00:00Z").content,
      renderBoundedRootFile({ ...boundedInput, path: "schema.md" }).body
    ]) {
      expect(body).toContain("generated:");
      expect(body).toContain("process:focowiki-publication");
    }
  });

  it("documents the 0.2 schema without recommending legacy timestamp", () => {
    const schema = renderSchemaFile("Knowledge base", "2026-08-07T10:00:00Z").content;
    expect(schema).toContain("Normative OKF 0.2");
    expect(schema).toContain("Safe raw frontmatter remains readable");
    expect(schema).toContain("normalized signal is null");
    expect(schema).toContain("Attested Computation");
    expect(schema).toContain("generated");
    expect(schema).not.toContain("`timestamp`");
  });

  it("does not generate numbered citations and preserves a legacy appendix byte-for-byte", () => {
    const page = {
      pagePath: "pages/guide.md",
      fileId: "file-a",
      metadata: {
        type: "Guide",
        title: "Guide",
        resource: "https://example.com/legacy"
      },
      suggestions: null
    };
    const generated = renderPageFile(page, "# Guide\n\nBody.");
    expect(generated).not.toContain("# Citations");

    const legacy = "# Citations\n\n[1] [Legacy](https://example.com/legacy)";
    const preserved = renderPageFile(page, `# Guide\n\nBody.\n\n${legacy}`);
    expect(preserved.endsWith(legacy)).toBe(true);
  });

  it("keeps a no-op publication byte stable", () => {
    const input = {
      pagePath: "pages/guide.md",
      fileId: "file-a",
      metadata: {
        type: "Guide",
        title: "Guide",
        generated: {
          by: "human:author",
          at: "2026-08-07T10:00:00Z"
        }
      },
      suggestions: null
    };
    expect(renderPageFile(input, "# Guide\n\nBody.")).toBe(
      renderPageFile(input, "# Guide\n\nBody.")
    );
  });

  it("keeps incomplete source computation advisory while blocking owned defects", () => {
    const validate = (candidateValidator as unknown as {
      validateStorageVnextOkfMarkdownMetadata?: (input: {
        logicalPath: string;
        kind: "source" | "schema" | "directory";
        body: string;
      }) => unknown;
    }).validateStorageVnextOkfMarkdownMetadata;
    expect(validate).toBeTypeOf("function");
    expect(() => validate!({
      logicalPath: "pages/incomplete.md",
      kind: "source",
      body: "---\ntype: Attested Computation\nruntime: [python]\nparameters: invalid\n---\n# Incomplete"
    })).not.toThrow();
    expect(() => validate!({
      logicalPath: "schema.md",
      kind: "schema",
      body: "---\ntype: Schema Reference\n---\n# Schema"
    })).toThrow(/OKF 0\.2 metadata/iu);
  });
});

describe("OKF 0.2 search contracts", () => {
  it("adds compact nullable signals to the versioned checksum identity", () => {
    type CreateContentDocument = (input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      logicalPath: string;
      fileKind: string;
      title: string | null;
      contentKind: "file";
      segmentOrdinal: null;
      headingAncestors: readonly string[];
      searchText: string;
      okfSignals: typeof compactSignals;
    }) => Record<string, unknown>;
    const create = searchDocuments.createStorageVnextContentDocument as unknown as CreateContentDocument;
    const base = {
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/guide.md",
      fileKind: "page",
      title: "Guide",
      contentKind: "file" as const,
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "guide",
      okfSignals: compactSignals
    };
    const document = create(base);
    const changed = create({
      ...base,
      okfSignals: { ...compactSignals, trustTier: "machine-confirmed" }
    });

    expect(document.schemaVersion).toBe("storage-vnext-content-v2");
    expect(document.okfSignals).toEqual(compactSignals);
    expect(create(structuredClone(base))).toEqual(document);
    expect(changed.id).not.toBe(document.id);
    expect(JSON.stringify(document.okfSignals)).not.toMatch(/sources|verified|parameters/u);
  });

  it("normalizes provider-neutral filters and explicitly excludes null signals", () => {
    type Filters = {
      okfStatus?: string;
      okfTrustTier?: string;
      okfFreshness?: string;
      requestDate?: string;
    };
    const module = searchDocuments as unknown as {
      normalizeOkfSearchFilters?: (input: Filters) => Record<string, unknown>;
      matchesOkfSearchFilters?: (
        signals: Record<string, unknown>,
        filters: Record<string, unknown>
      ) => boolean;
    };
    expect(module.normalizeOkfSearchFilters).toBeTypeOf("function");
    expect(module.matchesOkfSearchFilters).toBeTypeOf("function");
    const filters = module.normalizeOkfSearchFilters!({
      okfStatus: "stable",
      okfTrustTier: "human-reviewed",
      okfFreshness: "fresh",
      requestDate: "2026-08-07"
    });
    expect(module.matchesOkfSearchFilters!({
      status: null,
      trustTier: null,
      staleAfterEpochDay: null
    }, filters)).toBe(false);
    expect(module.matchesOkfSearchFilters!(compactSignals, filters)).toBe(true);
  });
});

describe("OKF 0.2 Developer OpenAPI", () => {
  it("documents nullable signals and the three additive search filters", () => {
    const document = createDeveloperOpenApiDocument();
    const schemas = document.components.schemas as Record<string, {
      properties?: Record<string, unknown>;
    }>;
    expect(schemas.OkfSignals).toBeDefined();
    expect(schemas.GeneratedFile?.properties).toHaveProperty("okfSignals");
    expect(schemas.FileSearchResult?.properties).toHaveProperty("okfSignals");

    const search = document.paths[
      "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search"
    ]?.get as { parameters?: Array<{ name: string }> } | undefined;
    const names = search?.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(expect.arrayContaining([
      "okfStatus",
      "okfTrustTier",
      "okfFreshness"
    ]));
  });

  it("returns real hydrated metadata and derived signals for search results", () => {
    const result = presentOpenApiSearchResult({
      knowledgeBaseId: "kb-a",
      generationId: "generation-a",
      mode: "file",
      depth: 0,
      nodePublicId: null,
      item: {
        publicId: "file-a",
        sourceFilePublicId: "file-a",
        logicalPath: "pages/guide.md",
        title: "Guide",
        snippet: "Guide body",
        score: 1,
        kind: "file",
        metadata: {
          type: "Guide",
          tags: ["policy"],
          status: "stable",
          stale_after: "2026-09-23",
          generated: { by: "generator", at: "2026-08-07T10:00:00Z" },
          sources: [{ id: "source-a", resource: "source.md" }],
          verified: [{ by: "human:reviewer", at: "2026-08-07T11:00:00Z" }]
        }
      } as never,
      relationships: []
    });
    expect(result).toMatchObject({
      tags: ["policy"],
      frontmatter: { type: "Guide", status: "stable" },
      okfSignals: normalizedSignals
    });
  });

  it("returns complete, incomplete, and malformed metadata safely on direct reads", () => {
    for (const frontmatter of [
      {
        type: "Attested Computation",
        runtime: "python",
        parameters: [],
        computation: { inline: "return 42" },
        executor: { resource: "runner.md" },
        attester: { resource: "attester.md" }
      },
      {
        type: "Attested Computation",
        runtime: ["python"],
        parameters: "invalid",
        executor: 42,
        attester: false
      }
    ]) {
      const result = presentOpenApiGeneratedFile("kb-a", "generation-a", {
        id: "file-a",
        logicalPath: "pages/computation.md",
        tags: ["runtime"],
        frontmatter
      });
      expect(result.frontmatter).toEqual(frontmatter);
      expect((result as typeof result & { okfSignals?: unknown }).okfSignals).toBeDefined();
    }
  });
});
