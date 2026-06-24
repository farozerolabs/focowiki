import { describe, expect, it } from "vitest";
import {
  normalizeSourceFileRefreshAfterMs,
  rememberSourceFileRefreshSnapshots,
  shouldScheduleSourceFileRefresh,
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

  it("schedules source file refresh only for active rows on a visible processing page", () => {
    expect(
      shouldScheduleSourceFileRefresh({
        activeView: "processing",
        isVisible: true,
        sourceFiles: [
          sourceFile({
            id: "source-001",
            processingStatus: "running",
            generatedOutputStatus: "pending"
          })
        ]
      })
    ).toBe(true);

    expect(
      shouldScheduleSourceFileRefresh({
        activeView: "processing",
        isVisible: true,
        sourceFiles: [
          sourceFile({
            id: "source-001",
            processingStatus: "completed",
            generatedOutputStatus: "visible"
          })
        ]
      })
    ).toBe(false);

    expect(
      shouldScheduleSourceFileRefresh({
        activeView: "file",
        isVisible: true,
        sourceFiles: [
          sourceFile({
            id: "source-001",
            processingStatus: "running",
            generatedOutputStatus: "pending"
          })
        ]
      })
    ).toBe(false);

    expect(
      shouldScheduleSourceFileRefresh({
        activeView: "processing",
        isVisible: false,
        sourceFiles: [
          sourceFile({
            id: "source-001",
            processingStatus: "running",
            generatedOutputStatus: "pending"
          })
        ]
      })
    ).toBe(false);
  });

  it("normalizes server refresh hints into a bounded interval", () => {
    expect(normalizeSourceFileRefreshAfterMs(undefined, 2_000)).toBe(2_000);
    expect(normalizeSourceFileRefreshAfterMs(500, 2_000)).toBe(2_000);
    expect(normalizeSourceFileRefreshAfterMs(90_000, 2_000)).toBe(60_000);
    expect(normalizeSourceFileRefreshAfterMs(15_000, 2_000)).toBe(15_000);
  });
});
