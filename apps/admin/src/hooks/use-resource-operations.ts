import { useCallback, useEffect, useRef, useState } from "react";
import {
  listActiveResourceOperations,
  type ResourceOperation
} from "@/lib/resource-editing-api";

const POLL_DELAYS_MS = [1_000, 2_000, 5_000] as const;

export function useResourceOperations(input: {
  knowledgeBaseId: string;
  onSettled: (operations: ResourceOperation[]) => void;
}) {
  const [operations, setOperations] = useState<ResourceOperation[]>([]);
  const [wakeVersion, setWakeVersion] = useState(0);
  const settledHandlerRef = useRef(input.onSettled);
  settledHandlerRef.current = input.onSettled;

  const track = useCallback((operation: ResourceOperation) => {
    setOperations((current) => [operation, ...current.filter((item) => item.operationId !== operation.operationId)]);
    setWakeVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let attempt = 0;

    const poll = async () => {
      timer = null;
      if (disposed || document.visibilityState === "hidden") return;
      const result = await listActiveResourceOperations({ knowledgeBaseId: input.knowledgeBaseId })
        .catch(() => ({ messageKey: "errors.loadOperationsFailed" } as const));
      if (disposed || "messageKey" in result) return;
      setOperations((previous) => {
        const activeIds = new Set(result.items.map((item) => item.operationId));
        const settled = previous.filter((item) => !activeIds.has(item.operationId));
        if (settled.length > 0) settledHandlerRef.current(settled);
        return result.items;
      });
      if (result.items.length > 0) {
        const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
        attempt += 1;
        timer = window.setTimeout(poll, delay);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && timer === null) void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [input.knowledgeBaseId, wakeVersion]);

  return {
    operations,
    track,
    isTargetBusy(targetId: string | null) {
      return Boolean(targetId && operations.some((operation) => operation.targetId === targetId));
    }
  };
}
