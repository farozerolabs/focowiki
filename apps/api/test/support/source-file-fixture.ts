import { randomUUID } from "node:crypto";
import type { SourceFileRecord } from "../../src/db/admin-repositories.js";
import { mapWithConcurrency } from "../../src/runtime/bounded.js";
import type { StorageAdapter } from "../../src/storage/s3.js";

export type SourceFileFixtureDraft = Omit<SourceFileRecord, "createdAt" | "deletedAt">;

export async function seedSourceFileFixtures(input: {
  files: Array<{ fileName: string; bytes: Uint8Array; content: string }>;
  storageConcurrency: number;
  knowledgeBaseId: string;
  storage: StorageAdapter;
  persist: (files: SourceFileFixtureDraft[]) => Promise<void>;
}): Promise<string[]> {
  const drafts = await mapWithConcurrency(
    input.files,
    input.storageConcurrency,
    async (file): Promise<SourceFileFixtureDraft> => {
      const sourceFileId = `source-file-${randomUUID()}`;
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
        name: file.fileName,
        relativePath: file.fileName,
        objectKey,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: file.bytes.byteLength,
        checksumSha256: "fixture-checksum",
        metadata: {},
        modelSuggestions: null,
        processingStatus: "queued",
        processingStage: "upload_storage",
        processingStartedAt: null,
        processingEndedAt: null,
        processingErrorCode: null,
        processingErrorMessage: null,
        generatedOutputStatus: "pending",
        publicationDirtyAt: null,
        publicationVisibleAt: null,
        publicationErrorCode: null,
        publicationErrorMessage: null,
        retryCount: 0,
        modelInvocationStatus: null,
        modelInvocationModelName: null,
        modelInvocationStartedAt: null,
        modelInvocationEndedAt: null,
        modelInvocationWarningCount: null,
        modelInvocationErrorCode: null,
        taskDeletedAt: null
      };
    }
  );

  await input.persist(drafts);
  return drafts.map((draft) => draft.id);
}
