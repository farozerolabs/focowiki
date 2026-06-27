import { describe, expect, it } from "vitest";
import {
  appendSourceFileFilterParams,
  createEmptySourceFileListFilters,
  fromDatetimeLocalValue,
  hasActiveSourceFileFilters,
  sourceFileFilterCount
} from "../src/lib/source-file-list-filters";

describe("source file list filter state", () => {
  it("serializes only active filters", () => {
    const filters = {
      ...createEmptySourceFileListFilters(),
      fileNameQuery: " intro ",
      processingStatus: "completed" as const,
      actionState: "openable" as const
    };
    const params = new URLSearchParams();

    appendSourceFileFilterParams(params, filters);

    expect(params.toString()).toBe(
      "fileNameQuery=intro&processingStatus=completed&actionState=openable"
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
});
