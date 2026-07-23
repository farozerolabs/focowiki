import { describe, expect, it, vi } from "vitest";
import type { ClaimedPublicationImpact } from "../src/application/ports/publication-impact-repository.js";
import {
  createBoundedRootWriter,
  renderBoundedRootFile
} from "../src/publication/bounded-root-writer.js";

describe("bounded root writer", () => {
  const base = {
    knowledgeBase: {
      id: "kb-1",
      name: "Engineering",
      description: "Operational documentation",
      sourceFileCount: 100_000,
      graphEdgeCount: 240_000
    },
    rootEntryCount: 25_000,
    generationId: "generation-1"
  };

  it("keeps the root Markdown bounded at corpus scale", () => {
    const result = renderBoundedRootFile({ ...base, path: "index.md" });
    expect(Buffer.byteLength(result.body, "utf8")).toBeLessThan(2_048);
    expect(result.body).toContain("[Browse documents](/pages/index.md)");
    expect(result.body).toContain("[Relationship graph](/_graph/index.md)");
    expect(result.body).not.toContain("100000 source files");
    expect(result.body).toMatch(/^---\nokf_version: "0\.1"\n---\n#/u);
    expect(result.body).not.toContain("knowledge_base_id:");
    expect(result.body).not.toContain("generation_id:");
  });

  it("keeps machine-readable navigation directed at the finalized catalog", () => {
    const result = renderBoundedRootFile({ ...base, path: "_index/index.md" });
    expect(result.body).toContain("[Projection catalog](/_index/catalog.json)");
  });

  it("keeps graph guidance bounded, truthful, and grounded in source files", () => {
    const result = renderBoundedRootFile({ ...base, path: "_graph/index.md" });
    expect(result.body).toContain("[Machine-readable graph catalog](/_index/catalog.json)");
    expect(result.body).toContain("[Browse source-backed files](/pages/index.md)");
    expect(result.body).toContain("Use the graph catalog to discover related files");
    expect(result.body).toContain("Relationships are navigation hints");
    expect(result.body).toContain("verify context and evidence");
    expect(result.body).not.toContain("Developer OpenAPI");
    expect(result.body).not.toContain("graph expansion");
    expect(result.body).not.toContain("related-file reads");
    expect(result.body).not.toContain("manifest.json");
    expect(result.body).not.toContain("insights.json");
    expect(Buffer.byteLength(result.body, "utf8")).toBeLessThan(2_048);
  });

  it("keeps reserved history and schema files within the OKF Markdown contract", () => {
    const log = renderBoundedRootFile({ ...base, path: "log.md" });
    const schema = renderBoundedRootFile({ ...base, path: "schema.md" });
    expect(log.body).toMatch(/^# Directory Update Log\n/u);
    expect(log.body).not.toMatch(/^---\n/u);
    expect(schema.body).toMatch(
      /^---\ntype: "Schema Reference"\ntitle: "Metadata and navigation schema"\n/u
    );
  });

  it("writes a repeated root path once from the latest resource revision", async () => {
    const stageUpsert = vi.fn(async () => undefined);
    const write = vi.fn(async (_input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => ({
      checksumSha256: "ab".repeat(32),
      formatVersion: 1,
      objectKey: "test/generated/v1/objects/ab/checksum",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 100,
      createdAt: "2026-07-19T00:00:00.000Z",
      verifiedAt: "2026-07-19T00:00:00.000Z",
      reused: false
    }));
    const writer = createBoundedRootWriter({
      references: { stageUpsert } as never,
      immutableObjects: { write }
    });

    const result = await writer.writeBatch([
      rootImpact({ id: "impact-old", resourceRevision: 1, name: "Old name" }),
      rootImpact({ id: "impact-new", resourceRevision: 2, name: "Current name" })
    ]);

    expect(result).toEqual({ handled: true, touchedShardCount: 1 });
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0].body)).toContain("# Current name");
    expect(String(write.mock.calls[0]?.[0].body)).not.toContain("# Old name");
    expect(stageUpsert).toHaveBeenCalledOnce();
  });
});

function rootImpact(input: {
  id: string;
  resourceRevision: number;
  name: string;
}): ClaimedPublicationImpact {
  return {
    id: input.id,
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    changeFactId: `fact-${input.id}`,
    changeKind: "knowledge_base_metadata_changed",
    sourceFileId: null,
    sourceRevisionId: null,
    previousPath: null,
    path: null,
    resourceRevision: input.resourceRevision,
    projectionKind: "root",
    projectionKey: "index.md",
    recordIdentity: "index.md",
    action: "upsert",
    retryCursor: {},
    attemptCount: 1,
    maxAttempts: 3,
    projectionInput: {
      kind: "knowledge_base",
      descriptor: {
        id: "kb-1",
        name: input.name,
        description: null,
        sourceFileCount: 10,
        graphEdgeCount: 5
      },
      rootEntryCount: 2
    }
  };
}
