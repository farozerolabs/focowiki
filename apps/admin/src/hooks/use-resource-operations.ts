import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchResourceOperation,
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
  const operationsRef = useRef<ResourceOperation[]>([]);
  const settledHandlerRef = useRef(input.onSettled);
  settledHandlerRef.current = input.onSettled;

  const track = useCallback((operation: ResourceOperation) => {
    const next = [operation, ...operationsRef.current.filter(
      (item) => item.operationId !== operation.operationId
    )];
    operationsRef.current = next;
    setOperations(next);
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
      if (disposed) return;
      if ("messageKey" in result) {
        if (operationsRef.current.length > 0) {
          const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
          attempt += 1;
          timer = window.setTimeout(poll, delay);
        }
        return;
      }
      const resolved = await resolveSettledResourceOperations({
        knowledgeBaseId: input.knowledgeBaseId,
        previous: operationsRef.current,
        active: result.items,
        fetchOperation: fetchResourceOperation
      });
      if (disposed) return;
      const next = [...result.items, ...resolved.unresolved];
      operationsRef.current = next;
      setOperations(next);
      if (resolved.settled.length > 0) {
        settledHandlerRef.current(resolved.settled);
      }
      if (next.length > 0) {
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
      return Boolean(targetId && operations.some((operation) =>
        operation.targetId === targetId || operation.targetKind === "source_directory"
      ));
    }
  };
}

const TERMINAL_OPERATION_STATES = new Set<ResourceOperation["state"]>([
  "completed", "failed", "cancelled", "superseded"
]);

export async function resolveSettledResourceOperations(input: {
  knowledgeBaseId: string;
  previous: ResourceOperation[];
  active: ResourceOperation[];
  fetchOperation: typeof fetchResourceOperation;
}): Promise<{ settled: ResourceOperation[]; unresolved: ResourceOperation[] }> {
  const activeIds = new Set(input.active.map((item) => item.operationId));
  const disappeared = input.previous.filter((item) => !activeIds.has(item.operationId));
  const results = await Promise.all(disappeared.map(async (item) => {
    const result = await input.fetchOperation({
      knowledgeBaseId: input.knowledgeBaseId,
      operationId: item.operationId
    }).catch(() => null);
    return result && !("messageKey" in result) && result.operation ? result.operation : item;
  }));
  return {
    settled: results.filter((item) => TERMINAL_OPERATION_STATES.has(item.state)),
    unresolved: results.filter((item) => !TERMINAL_OPERATION_STATES.has(item.state))
  };
}
