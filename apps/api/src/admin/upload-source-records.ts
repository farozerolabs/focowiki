import { parseUploadedMarkdownSource } from "@focowiki/okf";
import type { AdminRepositories } from "../db/admin-repositories.js";
import { mapWithConcurrency } from "../runtime/bounded.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { UploadProgressTracker } from "./upload-progress.js";
import {
  createSourceFileId,
  sha256Bytes,
  type LoadedUploadFile
} from "./upload-processor-utils.js";

export type PreparedUploadSourceRecord = {
  id: string;
  knowledgeBaseId: string;
  originalName: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata: ReturnType<typeof parseUploadedMarkdownSource>["metadata"];
  processingStatus: "running";
  processingStage: "upload_storage";
  processingStartedAt: string;
  processingEndedAt: null;
  processingErrorCode: null;
  bytes: Uint8Array;
  content: string;
};

export async function prepareUploadSourceRecords(input: {
  files: LoadedUploadFile[];
  fileProcessingConcurrency: number;
  knowledgeBaseId: string;
  storage: StorageAdapter;
  createSourceFiles: NonNullable<NonNullable<AdminRepositories["files"]>["createSourceFiles"]>;
  progress: UploadProgressTracker;
  progressClock: () => string;
  onSourcePrepared: (sourceFileId: string) => void;
}): Promise<PreparedUploadSourceRecord[]> {
  return mapWithConcurrency(input.files, input.fileProcessingConcurrency, async (file) => {
    const sourceFileId = file.sourceFileId ?? createSourceFileId();
    const parsed = parseUploadedMarkdownSource({
      fileName: file.fileName,
      content: file.content
    });
    const objectKey =
      file.existingSource?.objectKey ??
      input.storage.keyspace.sourceFileKey(input.knowledgeBaseId, sourceFileId, file.fileName);
    const source: PreparedUploadSourceRecord = {
      id: sourceFileId,
      knowledgeBaseId: input.knowledgeBaseId,
      originalName: file.fileName,
      objectKey,
      contentType: file.existingSource?.contentType ?? "text/markdown; charset=utf-8",
      sizeBytes: file.bytes.byteLength,
      checksumSha256: sha256Bytes(file.bytes),
      metadata: parsed.metadata,
      processingStatus: "running",
      processingStage: "upload_storage",
      processingStartedAt: input.progressClock(),
      processingEndedAt: null,
      processingErrorCode: null,
      bytes: file.bytes,
      content: file.content
    };

    const { bytes: _bytes, content: _content, ...sourceDraft } = source;

    if (file.existingSource) {
      await input.progress.markFile({
        sourceFileId: source.id,
        status: "running",
        stage: "upload_storage",
        endedAt: null,
        errorCode: null
      });
    } else {
      await input.createSourceFiles([sourceDraft]);
    }
    input.onSourcePrepared(source.id);
    await input.progress.invalidate();

    if (!file.existingSource) {
      await input.storage.putObject({
        key: source.objectKey,
        body: source.bytes,
        contentType: source.contentType
      });
    }

    await input.progress.markFile({
      sourceFileId: source.id,
      status: "running",
      stage: "metadata_resolution",
      endedAt: null,
      errorCode: null
    });

    return source;
  });
}
