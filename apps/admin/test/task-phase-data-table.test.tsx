import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatFileError,
  formatFileStage,
  formatGeneratedFileStatus,
  formatModelInvocation
} from "../src/components/task-phase-data-table";
import { displaySourceFileActions } from "../src/lib/source-file-actions";
import type { SourceFileRecord } from "../src/lib/admin-api";

describe("task phase data table", () => {
  it("renders a not-required model fact without claiming that it was not recorded", () => {
    const translate = ((key: string) => ({
      "tasks.notRecorded": "Not recorded",
      "tasks.modelStatus.not_required": "Not required"
    })[key] ?? key) as never;

    expect(formatModelInvocation({
      modelInvocationStatus: "not_required",
      modelInvocationModelName: null,
      modelInvocationStartedAt: null,
      modelInvocationEndedAt: "2026-08-13T00:00:00.000Z",
      modelInvocationWarningCount: 0,
      modelInvocationErrorCode: null
    } as unknown as SourceFileRecord, translate)).toBe("Not required");
  });

  it("hides stale failure actions as soon as retry starts", () => {
    expect(displaySourceFileActions({
      actions: [{
        kind: "retry_document_processing",
        method: "POST",
        href: "/retry",
        scope: "source_file"
      }]
    } as unknown as SourceFileRecord, true)).toEqual([]);
  });

  it("presents unavailable output as pending until processing fails", () => {
    const translate = ((key: string) => ({
      "tasks.generatedFile.pending": "Pending",
      "tasks.generatedFile.unavailable": "Unavailable"
    })[key] ?? key) as never;

    const processing = renderToStaticMarkup(formatGeneratedFileStatus({
      state: "processing",
      generatedFileAvailable: false,
      generatedOutputStatus: "unavailable"
    } as SourceFileRecord, translate));
    const failed = renderToStaticMarkup(formatGeneratedFileStatus({
      state: "error",
      generatedFileAvailable: false,
      generatedOutputStatus: "unavailable"
    } as SourceFileRecord, translate));

    expect(processing).toContain("Pending");
    expect(processing).not.toContain("text-destructive");
    expect(failed).toContain("Unavailable");
    expect(failed).toContain("text-destructive");
  });

  it("presents scheduled retries without claiming that the row has no error", () => {
    const translate = ((key: string, options?: { stage?: string }) => ({
      "tasks.retryingStage": `Waiting to retry: ${options?.stage ?? ""}`,
      "tasks.workKind.firstLayer": "First-layer generation",
      "tasks.noError": "No error"
    })[key] ?? key) as never;
    const file = {
      state: "waiting",
      blockingWorkKind: "first_layer",
      retryingWorkKind: "first_layer",
      failure: null,
      modelInvocationErrorCode: "MODEL_GRAPH_ANALYSIS_INVALID"
    } as SourceFileRecord;

    expect(formatFileStage(file, translate)).toBe(
      "Waiting to retry: First-layer generation"
    );
    expect(formatFileError(file, translate)).toBe("MODEL_GRAPH_ANALYSIS_INVALID");
  });
});
