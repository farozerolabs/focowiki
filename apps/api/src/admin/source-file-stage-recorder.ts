import type { SourceFileEventDraft } from "../application/ports/source-file-repository.js";
import type { SourceFileProcessingStage } from "../db/admin-repositories.js";
import { sourceFileStageMessageKey } from "./source-file-processor-support.js";
import type { SourceFileStageRecorder } from "./source-file-stage-types.js";

export function createSourceFileStageRecorder(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
  ttlSeconds: number;
  createEvent: (event: SourceFileEventDraft) => Promise<unknown>;
  recordRedisEvent: (
    value: {
      knowledgeBaseId: string;
      stage: SourceFileProcessingStage;
      severity: "info" | "warning" | "error";
    },
    ttlSeconds: number
  ) => Promise<void>;
}): SourceFileStageRecorder {
  const startedAtByStage = new Map<SourceFileProcessingStage, string>();

  return async (stage, event) => {
    if (event.startedAt && !event.endedAt) {
      startedAtByStage.set(stage, event.startedAt);
      return;
    }

    const startedAt = event.startedAt ?? startedAtByStage.get(stage) ?? null;
    await input.createEvent({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      stageKey: stage,
      messageKey: sourceFileStageMessageKey(stage),
      startedAt,
      endedAt: event.endedAt,
      severity: event.severity
    });
    await input.recordRedisEvent(
      {
        knowledgeBaseId: input.knowledgeBaseId,
        stage,
        severity: event.severity
      },
      input.ttlSeconds
    );
    startedAtByStage.delete(stage);
  };
}
