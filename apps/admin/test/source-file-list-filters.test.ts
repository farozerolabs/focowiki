import { describe, expect, it } from "vitest";
import {
  appendSourceFileFilterParams,
  createEmptySourceFileListFilters,
  fromDatetimeLocalValue,
  hasActiveSourceFileFilters,
  SOURCE_FILE_CURRENT_STAGES,
  SOURCE_FILE_WORK_KINDS,
  SOURCE_FILE_ACTION_STATES,
  sourceFileFilterCount
} from "../src/lib/source-file-list-filters";

describe("source file list filter state", () => {
  it("serializes only active filters", () => {
    const filters = {
      ...createEmptySourceFileListFilters(),
      fileNameQuery: " intro ",
      state: "available" as const,
      actionState: "openable" as const
    };
    const params = new URLSearchParams();

    appendSourceFileFilterParams(params, filters);

    expect(params.toString()).toBe(
      "fileNameQuery=intro&state=available&actionState=openable"
    );
    expect(hasActiveSourceFileFilters(filters)).toBe(true);
    expect(sourceFileFilterCount(filters)).toBe(3);
  });

  it("keeps empty filters out of query params", () => {
    const params = new URLSearchParams();

    appendSourceFileFilterParams(params, createEmptySourceFileListFilters());

    expect(params.toString()).toBe("");
    expect(hasActiveSourceFileFilters(createEmptySourceFileListFilters())).toBe(false);
  });

  it("converts datetime-local values to ISO timestamps", () => {
    const value = fromDatetimeLocalValue("2026-06-14T08:30");

    expect(value).toEqual(expect.stringMatching(/^2026-06-14T/));
  });

  it("offers only fixed work kinds that the current lifecycle can produce", () => {
    expect(SOURCE_FILE_WORK_KINDS).not.toEqual(expect.arrayContaining([
      "upload_storage",
    ]));
    expect(SOURCE_FILE_WORK_KINDS).toEqual(expect.arrayContaining([
      "prepare",
      "first_layer",
      "content_projection",
      "graphrag",
      "relation_reconcile",
      "knowledge_projection",
      "activate",
      "cleanup"
    ]));
  });

  it("serializes terminal values shown in the current-stage column", () => {
    const filters = {
      ...createEmptySourceFileListFilters(),
      currentStage: "available" as const
    };
    const params = new URLSearchParams();

    appendSourceFileFilterParams(params, filters);

    expect(params.toString()).toBe("currentStage=available");
    expect(SOURCE_FILE_CURRENT_STAGES).toEqual(expect.arrayContaining([
      "activate",
      "available",
      "error"
    ]));
  });

  it("offers filters for every user-visible failure action", () => {
    expect(SOURCE_FILE_ACTION_STATES).toEqual([
      "openable",
      "retryable",
      "correctable",
      "details_only",
      "none"
    ]);
  });
});
