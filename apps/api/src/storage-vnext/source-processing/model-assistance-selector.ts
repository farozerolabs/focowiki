export function createStorageVnextSourceModelAssistanceSelector() {
  return async function selectModelAssistance(request: {
    knowledgeBaseId: string;
    sourceRevisionPublicId: string;
    sourceLogicalPath: string;
    markdown: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    throwIfAborted(request.signal);
    return false;
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Source model selection aborted", "AbortError");
  }
}
