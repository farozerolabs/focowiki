import { describe, expect, it } from "vitest";
import {
  normalizeSourceFileRefreshAfterMs,
  rememberSourceFileRefreshSnapshots,
  shouldScheduleMaintenanceRefresh,
  shouldScheduleSourceFileRefresh,
  shouldRefreshGeneratedFiles
} from "../src/lib/source-file-refresh";
import type { SourceFileRecord } from "../src/lib/admin-api";

function sourceFile(input: Partial<SourceFileRecord> & Pick<SourceFileRecord, "id">): SourceFileRecord {
  return {
    name: `${input.id}.md`,
    relativePath: `${input.id}.md`,
    state: "waiting",
    blockingWorkKind: "prepare",
    requiredWorkCount: 8,
    completedWorkCount: 0,
    activeWorkKinds: [],
    retryingWorkKind: null,
    failure: null,
    actions: [],
    createdAt: "2026-06-14T00:00:00.000Z",
    ...input
  };
}

describe("source file refresh decisions", () => {
  it("schedules maintenance status refresh only for a visible settings view", () => {
    expect(shouldScheduleMaintenanceRefresh({
      activeView: "settings",
      isVisible: true
    })).toBe(true);
    expect(shouldScheduleMaintenanceRefresh({
      activeView: "settings",
      isVisible: false
    })).toBe(false);
    expect(shouldScheduleMaintenanceRefresh({
      activeView: "processing",
      isVisible: true
    })).toBe(false);
  });

  it("refreshes generated files when one file becomes available while another file is still running", () => {
    const previous = rememberSourceFileRefreshSnapshots([
      sourceFile({
        id: "source-001",
        state: "processing",
        blockingWorkKind: "prepare",
        failure: null,
        actions: [],
        generatedFileAvailable: false,
        generatedFileId: null,
        generatedFilePath: null
      }),
      sourceFile({
        id: "source-002",
        state: "processing",
        blockingWorkKind: "first_layer",
        failure: null,
        actions: [],
        generatedFileAvailable: false,
        generatedFileId: null,
        generatedFilePath: null
      })
    ]);

    expect(
      shouldRefreshGeneratedFiles(previous, [
        sourceFile({
          id: "source-001",
          state: "available",
          blockingWorkKind: null,
          failure: null,
          actions: [],
          generatedFileAvailable: true,
          generatedFileId: "bundle-001",
          generatedFilePath: "pages/intro.md"
        }),
        sourceFile({
          id: "source-002",
          state: "processing",
          blockingWorkKind: "first_layer",
          failure: null,
          actions: [],
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
        state: "available",
        blockingWorkKind: null,
        failure: null,
        actions: [],
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
            state: "processing",
            blockingWorkKind: "prepare",
            failure: null,
            actions: [],
            generatedOutputStatus: "unavailable"
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
            state: "available",
            blockingWorkKind: null,
            failure: null,
            actions: [],
            generatedOutputStatus: "current_available"
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
            state: "processing",
            blockingWorkKind: "prepare",
            failure: null,
            actions: [],
            generatedOutputStatus: "unavailable"
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
            state: "processing",
            blockingWorkKind: "prepare",
            failure: null,
            actions: [],
            generatedOutputStatus: "unavailable"
          })
        ]
      })
    ).toBe(false);
  });

  it("keeps refreshing filtered terminal rows while background work remains active", () => {
    expect(
      shouldScheduleSourceFileRefresh({
        activeView: "processing",
        isVisible: true,
        sourceFiles: [
          sourceFile({
            id: "source-visible",
            state: "available",
            blockingWorkKind: null,
            failure: null,
            actions: [],
            generatedOutputStatus: "current_available"
          })
        ],
        hasBackgroundActivity: true
      })
    ).toBe(true);
  });

  it("normalizes server refresh hints into a bounded interval", () => {
    expect(normalizeSourceFileRefreshAfterMs(undefined, 2_000)).toBe(2_000);
    expect(normalizeSourceFileRefreshAfterMs(500, 2_000)).toBe(2_000);
    expect(normalizeSourceFileRefreshAfterMs(90_000, 2_000)).toBe(60_000);
    expect(normalizeSourceFileRefreshAfterMs(15_000, 2_000)).toBe(15_000);
  });
});
