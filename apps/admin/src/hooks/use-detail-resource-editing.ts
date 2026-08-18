import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SourceResourceEditRequest } from "@/components/source-resource-editor";
import { fetchSourceFile } from "@/lib/admin-api";
import type { ResourceOperation } from "@/lib/resource-editing-api";
import { useResourceOperations } from "@/hooks/use-resource-operations";
import { showAdminToast } from "@/hooks/use-admin-toast";

export function useDetailResourceEditing(input: {
  knowledgeBaseId: string;
  selectedSourceFileId: string | null;
  refresh: () => Promise<void>;
  reopen: (path: string, title: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<SourceResourceEditRequest | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const operations = useResourceOperations({
    knowledgeBaseId: input.knowledgeBaseId,
    onSettled: (settled) => void handleSettled(settled)
  });

  async function handleSettled(settled: ResourceOperation[]) {
    for (const operation of settled) {
      const succeeded = operation.state === "completed";
      showAdminToast({
        title: t(succeeded
          ? "resourceEditing.completedTitle"
          : "resourceEditing.failedTitle"),
        description: t(succeeded
          ? "resourceEditing.completedDescription"
          : operationFailureMessageKey(operation.errorCode)),
        ...(succeeded ? {} : { variant: "destructive" as const })
      });
    }
    await inputRef.current.refresh();
    const sourceFileId = inputRef.current.selectedSourceFileId;
    if (!sourceFileId) return;
    let file;
    try {
      file = await fetchSourceFile({
        knowledgeBaseId: inputRef.current.knowledgeBaseId,
        sourceFileId
      });
    } catch (error) {
      showAdminToast({
        title: t("resourceEditing.failedTitle"),
        description: t(readErrorMessageKey(error)),
        variant: "destructive"
      });
      return;
    }
    if (file?.generatedFilePath) {
      await inputRef.current.reopen(file.generatedFilePath, file.name);
    }
  }

  return {
    request,
    setRequest,
    track: operations.track,
    isTargetBusy: operations.isTargetBusy,
    accept(operation: ResourceOperation) {
      operations.track(operation);
      setRequest(null);
    }
  };
}

export function operationFailureMessageKey(errorCode: string | null): string {
  const keys: Record<string, string> = {
    RESOURCE_REVISION_CONFLICT: "errors.resourceRevisionConflict",
    RESOURCE_PATH_CONFLICT: "errors.resourcePathConflict",
    RESOURCE_CONTENT_UNCHANGED: "errors.sourceContentUnchanged",
    RESOURCE_BUSY: "errors.resourceBusy",
    RESOURCE_DELETING: "errors.resourceDeleting"
  };
  return errorCode ? keys[errorCode] ?? "errors.resourceEditFailed" : "errors.resourceEditFailed";
}

function readErrorMessageKey(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "errors.serviceUnavailable";
}
