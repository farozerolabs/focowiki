import { parseUploadedMarkdownSource } from "@focowiki/okf";
import type { AdminRepositories, SourceFileDraft } from "../db/admin-repositories.js";
import { mapWithConcurrency } from "../runtime/bounded.js";
import type { StorageAdapter } from "../storage/s3.js";
import {
  createSourceFileId,
  sha256Bytes,
  type LoadedUploadFile
} from "./upload-processor-utils.js";

export async function acceptUploadSourceFiles(input: {
  files: LoadedUploadFile[];
  storageConcurrency: number;
  knowledgeBaseId: string;
  storage: StorageAdapter;
  createSourceFiles: NonNullable<NonNullable<AdminRepositories["files"]>["createSourceFiles"]>;
}): Promise<string[]> {
  const drafts = await mapWithConcurrency(
    input.files,
    input.storageConcurrency,
    async (file): Promise<SourceFileDraft> => {
      const sourceFileId = createSourceFileId();
      const parsed = parseUploadedMarkdownSource({
        fileName: file.fileName,
        content: file.content
      });
      const objectKey = input.storage.keyspace.sourceFileKey(
        input.knowledgeBaseId,
        sourceFileId,
        file.fileName
      );

      await input.storage.putObject({
        key: objectKey,
        body: file.bytes,
        contentType: "text/markdown; charset=utf-8"
      });

      return {
        id: sourceFileId,
        knowledgeBaseId: input.knowledgeBaseId,
        originalName: file.fileName,
        objectKey,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: file.bytes.byteLength,
        checksumSha256: sha256Bytes(file.bytes),
        metadata: parsed.metadata,
        modelSuggestions: null,
        processingStatus: "queued",
        processingStage: "upload_storage",
        processingStartedAt: null,
        processingEndedAt: null,
        processingErrorCode: null,
        processingErrorMessage: null,
        retryCount: 0,
        modelInvocationStatus: null,
        modelInvocationModelName: null,
        modelInvocationStartedAt: null,
        modelInvocationEndedAt: null,
        modelInvocationWarningCount: null,
        modelInvocationErrorCode: null
      };
    }
  );

  await input.createSourceFiles(drafts);
  return drafts.map((draft) => draft.id);
}
