import type { SourceFileRecord } from "@/lib/admin-api";

export type SourceFileRefreshSnapshot = {
  state: SourceFileRecord["state"];
  currentStage: SourceFileRecord["currentStage"];
  generatedOutputStatus: SourceFileRecord["generatedOutputStatus"] | null;
  generatedFileAvailable: boolean;
  generatedFileId: string | null;
  generatedFilePath: string | null;
};

export type SourceFileRefreshScheduleInput = {
  activeView: "file" | "processing";
  isVisible: boolean;
  sourceFiles: SourceFileRecord[];
};

export function createSourceFileRefreshSnapshot(file: SourceFileRecord): SourceFileRefreshSnapshot {
  return {
    state: file.state,
    currentStage: file.currentStage,
    generatedOutputStatus: file.generatedOutputStatus ?? null,
    generatedFileAvailable: Boolean(file.generatedFileAvailable),
    generatedFileId: file.generatedFileId ?? null,
    generatedFilePath: file.generatedFilePath ?? null
  };
}

export function shouldScheduleSourceFileRefresh({
  activeView,
  isVisible,
  sourceFiles
}: SourceFileRefreshScheduleInput): boolean {
  return activeView === "processing" && isVisible && sourceFiles.some(isActiveSourceFile);
}

export function normalizeSourceFileRefreshAfterMs(
  value: number | undefined,
  fallbackMs: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.min(Math.max(value, 2_000), 60_000);
}

export function shouldRefreshGeneratedFiles(
  previous: Map<string, SourceFileRefreshSnapshot>,
  files: SourceFileRecord[]
): boolean {
  const currentIds = new Set(files.map((file) => file.id));

  if (Array.from(previous.keys()).some((fileId) => !currentIds.has(fileId))) {
    return true;
  }

  return files.some((file) => {
    const current = createSourceFileRefreshSnapshot(file);
    const before = previous.get(file.id);

    if (!before) {
      return current.generatedFileAvailable;
    }

    return (
      before.state !== current.state ||
      before.generatedOutputStatus !== current.generatedOutputStatus ||
      before.generatedFileAvailable !== current.generatedFileAvailable ||
      before.generatedFileId !== current.generatedFileId ||
      before.generatedFilePath !== current.generatedFilePath
    );
  });
}

export function rememberSourceFileRefreshSnapshots(
  files: SourceFileRecord[]
): Map<string, SourceFileRefreshSnapshot> {
  const next = new Map<string, SourceFileRefreshSnapshot>();

  files.forEach((file) => {
    next.set(file.id, createSourceFileRefreshSnapshot(file));
  });

  return next;
}

function isActiveSourceFile(file: SourceFileRecord): boolean {
  return (
    file.state === "queued" ||
    file.state === "running" ||
    file.state === "pending_publication"
  );
}
