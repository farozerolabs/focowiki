import { describe, expect, it } from "vitest";
import {
  completeCursorPageRequest,
  createInitialCursorPageState,
  moveToNextCursor,
  moveToPreviousCursor
} from "../src/lib/cursor-page-state";

describe("cursor page state", () => {
  it("tracks next and previous cursor navigation without offsets", () => {
    const firstPage = completeCursorPageRequest(createInitialCursorPageState(), "cursor-page-2");
    const secondPage = completeCursorPageRequest(moveToNextCursor(firstPage), "cursor-page-3");
    const previousPage = moveToPreviousCursor(secondPage);

    expect(firstPage).toMatchObject({
      currentCursor: null,
      nextCursor: "cursor-page-2",
      pageNumber: 1,
      previousCursors: []
    });
    expect(secondPage).toMatchObject({
      currentCursor: "cursor-page-2",
      nextCursor: "cursor-page-3",
      pageNumber: 2,
      previousCursors: [null]
    });
    expect(previousPage).toMatchObject({
      currentCursor: null,
      nextCursor: null,
      pageNumber: 1,
      previousCursors: []
    });
  });

  it("keeps state unchanged when previous or next navigation is unavailable", () => {
    const state = createInitialCursorPageState();

    expect(moveToNextCursor(state)).toBe(state);
    expect(moveToPreviousCursor(state)).toBe(state);
  });
});
