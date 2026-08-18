import { useEffect, type RefObject } from "react";
import {
  shouldScheduleMaintenanceRefresh,
  shouldScheduleSourceFileRefresh
} from "@/lib/source-file-refresh";
import type { SourceFileRecord } from "@/lib/admin-api";

type DetailView = "file" | "processing" | "settings";

export function useDetailPageRefresh(input: {
  knowledgeBaseId: string;
  activeViewRef: RefObject<DetailView>;
  sourceFilesRef: RefObject<SourceFileRecord[]>;
  hasBackgroundActivity: boolean;
  sourceFilePageLoadingRef: RefObject<boolean>;
  sourceFileFilterTimeoutRef: RefObject<number | null>;
  refreshIntervalMsRef: RefObject<number>;
  refreshSourceFiles: () => void;
  refreshMaintenance: () => void;
}): void {
  useEffect(() => {
    let timeoutId: number | null = null;
    let disposed = false;
    const isVisible = () => document.visibilityState === "visible";
    const refresh = () => {
      if (
        shouldScheduleSourceFileRefresh({
          activeView: input.activeViewRef.current,
          isVisible: isVisible(),
          sourceFiles: input.sourceFilesRef.current,
          hasBackgroundActivity: input.hasBackgroundActivity
        })
        && !input.sourceFilePageLoadingRef.current
      ) {
        input.refreshSourceFiles();
      }
      if (shouldScheduleMaintenanceRefresh({
        activeView: input.activeViewRef.current,
        isVisible: isVisible()
      })) {
        input.refreshMaintenance();
      }
    };
    const schedule = () => {
      if (disposed) return;
      timeoutId = window.setTimeout(() => {
        refresh();
        schedule();
      }, input.refreshIntervalMsRef.current);
    };
    const handleVisibilityChange = () => refresh();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    schedule();
    return () => {
      disposed = true;
      if (input.sourceFileFilterTimeoutRef.current !== null) {
        window.clearTimeout(input.sourceFileFilterTimeoutRef.current);
        input.sourceFileFilterTimeoutRef.current = null;
      }
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [input.knowledgeBaseId, input.hasBackgroundActivity]);
}
