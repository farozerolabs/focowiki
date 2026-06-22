import type { SourceFileRecord } from "@/lib/admin-api";

export type SourceFileRefreshSnapshot = {
  processingStatus: SourceFileRecord["processingStatus"] | null;
  processingStage: SourceFileRecord["processingStage"] | null;
  generatedOutputStatus: SourceFileRecord["generatedOutputStatus"] | null;
  generatedFileAvailable: boolean;
  generatedFileId: string | null;
  generatedFilePath: string | null;
};

export function createSourceFileRefreshSnapshot(file: SourceFileRecord): SourceFileRefreshSnapshot {
  return {
    processingStatus: file.processingStatus ?? null,
    processingStage: file.processingStage ?? null,
    generatedOutputStatus: file.generatedOutputStatus ?? null,
    generatedFileAvailable: Boolean(file.generatedFileAvailable),
    generatedFileId: file.generatedFileId ?? null,
    generatedFilePath: file.generatedFilePath ?? null
  };
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
      before.processingStatus !== current.processingStatus ||
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
