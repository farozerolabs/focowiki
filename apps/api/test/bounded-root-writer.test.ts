import { describe, expect, it } from "vitest";
import { renderBoundedRootFile } from "../src/publication/bounded-root-writer.js";

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

  it("keeps reserved history and schema files within the OKF Markdown contract", () => {
    const log = renderBoundedRootFile({ ...base, path: "log.md" });
    const schema = renderBoundedRootFile({ ...base, path: "schema.md" });
    expect(log.body).toMatch(/^# Directory Update Log\n/u);
    expect(log.body).not.toMatch(/^---\n/u);
    expect(schema.body).toMatch(
      /^---\ntype: "Schema Reference"\ntitle: "Metadata and navigation schema"\n/u
    );
  });
});
