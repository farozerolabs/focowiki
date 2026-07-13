import {
  parseUploadedMarkdownSource,
  resolveSourceMetadata
} from "@focowiki/okf";
import type { AdminRepositories, SourceFileRecord } from "../db/admin-repositories.js";
import type { StorageAdapter } from "../storage/s3.js";

type UpdateSourceFileMetadata = NonNullable<
  NonNullable<AdminRepositories["files"]>["updateSourceFileMetadata"]
>;

export async function processSourceFileMetadataStage(input: {
  storage: StorageAdapter;
  knowledgeBaseId: string;
  source: SourceFileRecord;
  updateSourceFileMetadata: UpdateSourceFileMetadata;
}) {
  const content = await input.storage.getObjectText(input.source.objectKey);

  if (content === null) {
    throw new Error("Source object was not found");
  }

  const parsed = parseUploadedMarkdownSource({
    fileName: input.source.name,
    content
  });

  await input.updateSourceFileMetadata({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    metadata: parsed.metadata
  });

  const resolved = resolveSourceMetadata({
    fileName: input.source.name,
    content,
    metadata: parsed.metadata
  });

  return {
    content,
    parsed,
    resolved
  };
}
