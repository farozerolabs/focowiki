export type CursorPageState = {
  currentCursor: string | null;
  nextCursor: string | null;
  pageNumber: number;
  previousCursors: Array<string | null>;
};

export function createInitialCursorPageState(): CursorPageState {
  return {
    currentCursor: null,
    nextCursor: null,
    pageNumber: 1,
    previousCursors: []
  };
}

export function completeCursorPageRequest(
  state: CursorPageState,
  nextCursor: string | null
): CursorPageState {
  return {
    ...state,
    nextCursor
  };
}

export function moveToNextCursor(state: CursorPageState): CursorPageState {
  if (!state.nextCursor) {
    return state;
  }

  return {
    currentCursor: state.nextCursor,
    nextCursor: null,
    pageNumber: state.pageNumber + 1,
    previousCursors: [...state.previousCursors, state.currentCursor]
  };
}

export function moveToPreviousCursor(state: CursorPageState): CursorPageState {
  const previousCursor = state.previousCursors.at(-1);

  if (previousCursor === undefined) {
    return state;
  }

  return {
    currentCursor: previousCursor,
    nextCursor: null,
    pageNumber: Math.max(1, state.pageNumber - 1),
    previousCursors: state.previousCursors.slice(0, -1)
  };
}
