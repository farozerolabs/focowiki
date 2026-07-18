import type { SourceFileProcessingStage, SourceFileRecord } from "../db/admin-repositories.js";
import type { SourceFileTerminalFailure } from "../domain/source-file-lifecycle.js";

export type SourceFileStageEvent = {
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
};

export type SourceFileStageMarker = (update: {
  status: SourceFileRecord["processingStatus"];
  stage: SourceFileProcessingStage;
  startedAt?: string | null;
  endedAt?: string | null;
  terminalFailure?: SourceFileTerminalFailure | null;
}) => Promise<void>;

export type SourceFileStageRecorder = (
  stage: SourceFileProcessingStage,
  event: SourceFileStageEvent
) => Promise<void>;
