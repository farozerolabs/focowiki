import { useCallback } from "react";
import {
  deleteKnowledgeBaseSourceFileTasks,
  type ApiFailure,
  type SourceFileTaskDeletionResponse
} from "@/lib/admin-api";
import type { CursorPageState } from "@/lib/cursor-page-state";
import type { Dispatch, SetStateAction } from "react";

type UseSourceFileTaskDeletionHandlerInput = {
  knowledgeBaseId: string;
  sourceFilePageStateRef: { current: CursorPageState };
  setRetryingSourceFileId: Dispatch<SetStateAction<string | null>>;
  loadSourceFiles: (input: { pageState: CursorPageState }) => Promise<void>;
  loadProcessingSummary: () => Promise<void>;
};

export function useSourceFileTaskDeletionHandler({
  knowledgeBaseId,
  sourceFilePageStateRef,
  setRetryingSourceFileId,
  loadSourceFiles,
  loadProcessingSummary
}: UseSourceFileTaskDeletionHandlerInput) {
  return useCallback(
    async (sourceFileIds: string[]): Promise<SourceFileTaskDeletionResponse | ApiFailure> => {
      const result = await deleteKnowledgeBaseSourceFileTasks({
        knowledgeBaseId,
        sourceFileIds
      });

      if ("messageKey" in result) {
        return result;
      }

      setRetryingSourceFileId((current) =>
        current && sourceFileIds.includes(current) ? null : current
      );
      await loadSourceFiles({ pageState: sourceFilePageStateRef.current });
      await loadProcessingSummary();
      return result;
    },
    [
      knowledgeBaseId,
      loadProcessingSummary,
      loadSourceFiles,
      setRetryingSourceFileId,
      sourceFilePageStateRef
    ]
  );
}
