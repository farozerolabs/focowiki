import { describe, expect, it } from "vitest";
import {
  rememberSourceFileRefreshSnapshots,
  shouldRefreshGeneratedFiles
} from "../src/lib/source-file-refresh";
import type { SourceFileRecord } from "../src/lib/admin-api";

function sourceFile(input: Partial<SourceFileRecord> & Pick<SourceFileRecord, "id">): SourceFileRecord {
  return {
    originalName: `${input.id}.md`,
    createdAt: "2026-06-14T00:00:00.000Z",
    ...input
  };
}

describe("source file refresh decisions", () => {
  it("refreshes generated files when one file becomes available while another file is still running", () => {
    const previous = rememberSourceFileRefreshSnapshots([
      sourceFile({
        id: "source-001",
        processingStatus: "running",
        processingStage: "metadata_resolution",
        generatedFileAvailable: false,
        generatedFileId: null,
        generatedFilePath: null
      }),
      sourceFile({
        id: "source-002",
        processingStatus: "running",
        processingStage: "llm_suggestion",
        generatedFileAvailable: false,
        generatedFileId: null,
        generatedFilePath: null
      })
    ]);

    expect(
      shouldRefreshGeneratedFiles(previous, [
        sourceFile({
          id: "source-001",
          processingStatus: "completed",
          processingStage: "release_activation",
          generatedFileAvailable: true,
          generatedFileId: "bundle-001",
          generatedFilePath: "pages/intro.md"
        }),
        sourceFile({
          id: "source-002",
          processingStatus: "running",
          processingStage: "llm_suggestion",
          generatedFileAvailable: false,
          generatedFileId: null,
          generatedFilePath: null
        })
      ])
    ).toBe(true);
  });

  it("refreshes generated files when a previously visible source file disappears", () => {
    const previous = rememberSourceFileRefreshSnapshots([
      sourceFile({
        id: "source-001",
        processingStatus: "completed",
        processingStage: "release_activation",
        generatedFileAvailable: true,
        generatedFileId: "bundle-001",
        generatedFilePath: "pages/intro.md"
      })
    ]);

    expect(shouldRefreshGeneratedFiles(previous, [])).toBe(true);
  });
});
