import { useRef, useState } from "react";
import type { SourceResourceEditRequest } from "@/components/source-resource-editor";
import { fetchSourceFile } from "@/lib/admin-api";
import type { ResourceOperation } from "@/lib/resource-editing-api";
import { useResourceOperations } from "@/hooks/use-resource-operations";

export function useDetailResourceEditing(input: {
  knowledgeBaseId: string;
  selectedSourceFileId: string | null;
  refresh: () => Promise<void>;
  reopen: (path: string, title: string) => Promise<void>;
}) {
  const [request, setRequest] = useState<SourceResourceEditRequest | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const operations = useResourceOperations({
    knowledgeBaseId: input.knowledgeBaseId,
    onSettled: () => void handleSettled()
  });

  async function handleSettled() {
    await inputRef.current.refresh();
    const sourceFileId = inputRef.current.selectedSourceFileId;
    if (!sourceFileId) return;
    const file = await fetchSourceFile({
      knowledgeBaseId: inputRef.current.knowledgeBaseId,
      sourceFileId
    });
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
