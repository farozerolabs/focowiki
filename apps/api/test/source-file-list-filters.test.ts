import { describe, expect, it } from "vitest";
import { createSourceFileFilterSignature } from "../src/admin/source-file-list-filter-signature.js";
import { readSourceFileListFilters } from "../src/admin/source-file-list-filters.js";

describe("source file list filters", () => {
  it("parses bounded filter values and normalizes timestamps", () => {
    const result = readSourceFileListFilters({
      fileNameQuery: " intro ",
      fileIdQuery: "source-file-001",
      processingStatus: "completed",
      processingStage: "release_activation",
      modelInvocationStatus: "not_recorded",
      generatedOutputStatus: "visible",
      startedFrom: "2026-06-14T00:00:00.000Z",
      startedTo: "2026-06-15T00:00:00.000Z",
      endedFrom: undefined,
      endedTo: undefined,
      errorState: "without_error",
      errorCodeQuery: " TIMEOUT ",
      actionState: "openable"
    });

    expect(result).toEqual({
      ok: true,
      filters: {
        fileNameQuery: "intro",
        fileIdQuery: "source-file-001",
        processingStatus: "completed",
        processingStage: "release_activation",
        modelInvocationStatus: "not_recorded",
        generatedOutputStatus: "visible",
        startedFrom: "2026-06-14T00:00:00.000Z",
        startedTo: "2026-06-15T00:00:00.000Z",
        endedFrom: null,
        endedTo: null,
        errorState: "without_error",
        errorCodeQuery: "TIMEOUT",
        actionState: "openable"
      }
    });
  });

  it("accepts single-character filename filters", () => {
    expect(
      readSourceFileListFilters({
        fileNameQuery: "峡",
        fileIdQuery: undefined,
        processingStatus: undefined,
        processingStage: undefined,
        modelInvocationStatus: undefined,
        generatedOutputStatus: undefined,
        startedFrom: undefined,
        startedTo: undefined,
        endedFrom: undefined,
        endedTo: undefined,
        errorState: undefined,
        errorCodeQuery: undefined,
        actionState: undefined
      })
    ).toEqual({
      ok: true,
      filters: {
        fileNameQuery: "峡",
        fileIdQuery: null,
        processingStatus: null,
        processingStage: null,
        modelInvocationStatus: null,
        generatedOutputStatus: null,
        startedFrom: null,
        startedTo: null,
        endedFrom: null,
        endedTo: null,
        errorState: null,
        errorCodeQuery: null,
        actionState: null
      }
    });
  });

  it("rejects unsafe text and time filters", () => {
    expect(
      readSourceFileListFilters({
        fileNameQuery: undefined,
        fileIdQuery: undefined,
        processingStatus: undefined,
        processingStage: undefined,
        modelInvocationStatus: undefined,
        generatedOutputStatus: undefined,
        startedFrom: undefined,
        startedTo: undefined,
        endedFrom: undefined,
        endedTo: undefined,
        errorState: undefined,
        errorCodeQuery: "a",
        actionState: undefined
      })
    ).toEqual({ ok: false, code: "SOURCE_FILE_FILTER_TEXT_TOO_SHORT" });

    expect(
      readSourceFileListFilters({
        fileNameQuery: undefined,
        fileIdQuery: undefined,
        processingStatus: undefined,
        processingStage: undefined,
        modelInvocationStatus: undefined,
        generatedOutputStatus: undefined,
        startedFrom: "2026-06-15T00:00:00.000Z",
        startedTo: "2026-06-14T00:00:00.000Z",
        endedFrom: undefined,
        endedTo: undefined,
        errorState: undefined,
        errorCodeQuery: undefined,
        actionState: undefined
      })
    ).toEqual({ ok: false, code: "SOURCE_FILE_FILTER_TIME_RANGE_INVALID" });
  });

  it("creates stable bounded signatures for cursor and cache scope", () => {
    const first = createSourceFileFilterSignature({
      fileNameQuery: "intro",
      processingStatus: "completed"
    });
    const second = createSourceFileFilterSignature({
      fileNameQuery: "intro",
      processingStatus: "completed"
    });
    const third = createSourceFileFilterSignature({
      fileNameQuery: "setup",
      processingStatus: "completed"
    });

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
  });
});
