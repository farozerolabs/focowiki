import type { OkfLogLimits } from "@focowiki/okf";
import type { KnowledgeBasePublicationService, PublicationRuntimeOptions } from "./publication-scheduler.js";
import type { SourceFileStageMarker, SourceFileStageRecorder } from "./source-file-stage-types.js";

export async function processSourceFilePublicationStage(input: {
  publicationService: KnowledgeBasePublicationService;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sourceFileId: string;
  relatedSourceFileIds?: string[] | undefined;
  generatedAt: string;
  pageSize: number;
  cursorTtlSeconds: number;
  fileProcessingConcurrency: number;
  okfLog?: Partial<OkfLogLimits> | undefined;
  options: PublicationRuntimeOptions;
  progressClock: () => string;
  mark: SourceFileStageMarker;
  recordStage: SourceFileStageRecorder;
}): Promise<{ published: boolean; releaseId: string | null }> {
  await input.mark({
    status: "completed",
    stage: "index_publication",
    endedAt: input.progressClock(),
    errorCode: null
  });
  const publication = await input.publicationService.markSourceFileReady({
    knowledgeBaseId: input.knowledgeBaseId,
    knowledgeBaseName: input.knowledgeBaseName,
    sourceFileId: input.sourceFileId,
    relatedSourceFileIds: input.relatedSourceFileIds ?? [],
    generatedAt: input.generatedAt,
    pageSize: input.pageSize,
    cursorTtlSeconds: input.cursorTtlSeconds,
    fileProcessingConcurrency: input.fileProcessingConcurrency,
    okfLog: input.okfLog,
    options: input.options
  });
  const publicationEndedAt = input.progressClock();

  if (publication.published) {
    await input.recordStage("okf_validation", {
      startedAt: null,
      endedAt: publicationEndedAt,
      severity: "info"
    });
    await input.recordStage("index_publication", {
      startedAt: null,
      endedAt: publicationEndedAt,
      severity: "info"
    });

    const releaseActivationEndedAt = input.progressClock();
    await input.recordStage("release_activation", {
      startedAt: publicationEndedAt,
      endedAt: releaseActivationEndedAt,
      severity: "info"
    });
    await input.mark({
      status: "completed",
      stage: "release_activation",
      endedAt: releaseActivationEndedAt,
      errorCode: null
    });
  } else {
    await input.recordStage("index_publication", {
      startedAt: publicationEndedAt,
      endedAt: publicationEndedAt,
      severity: "info"
    });
    await input.mark({
      status: "completed",
      stage: "index_publication",
      endedAt: publicationEndedAt,
      errorCode: null
    });
  }

  return publication;
}
