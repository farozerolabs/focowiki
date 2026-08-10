import { describe, expect, it } from "vitest";
import { createStorageVnextSourceModelAssistanceSelector } from
  "../src/storage-vnext/source-processing/model-assistance-selector.js";

describe("storage vNext source model assistance selector", () => {
  it("removes redundant source generation work from the current semantic contract", async () => {
    const selector = createStorageVnextSourceModelAssistanceSelector();
    const signal = new AbortController().signal;

    await expect(selector({
      knowledgeBaseId: "kb-current",
      sourceRevisionPublicId: "revision-ordinary",
      sourceLogicalPath: "notes/ordinary.md",
      markdown: "# Ordinary\n\nA self-contained paragraph without structural references.",
      signal
    })).resolves.toBe(false);
    await expect(selector({
      knowledgeBaseId: "kb-current",
      sourceRevisionPublicId: "revision-bridge",
      sourceLogicalPath: "notes/bridge.md",
      markdown: "# Bridge\n\nSee [Architecture](./architecture.md) for the complete design.",
      signal
    })).resolves.toBe(false);
  });

  it("avoids hidden source generation before a semantic generation is active", async () => {
    await expect(createStorageVnextSourceModelAssistanceSelector()({
      knowledgeBaseId: "kb-uncontracted",
      sourceRevisionPublicId: "revision-uncontracted",
      sourceLogicalPath: "uncontracted.md",
      markdown: "# Uncontracted",
      signal: new AbortController().signal
    })).resolves.toBe(false);
  });
});
