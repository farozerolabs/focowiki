import type { SourceFileProcessingStage } from "../db/admin-repositories.js";
import type { SourceFileStageMarker, SourceFileStageRecorder } from "./source-file-stage-types.js";

export async function processSourceFileBundleStage(input: {
  progressClock: () => string;
  mark: SourceFileStageMarker;
  recordStage: SourceFileStageRecorder;
}): Promise<{ sourceReadyAt: string }> {
  const stage: SourceFileProcessingStage = "bundle_generation";

  await input.mark({ status: "running", stage, endedAt: null, errorCode: null });
  const sourceReadyAt = input.progressClock();
  await input.recordStage(stage, {
    startedAt: sourceReadyAt,
    endedAt: sourceReadyAt,
    severity: "info"
  });
  await input.mark({
    status: "completed",
    stage,
    endedAt: sourceReadyAt,
    errorCode: null
  });

  return { sourceReadyAt };
}
