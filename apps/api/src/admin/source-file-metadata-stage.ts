import {
  parseUploadedMarkdownSource,
  resolveSourceMetadata
} from "@focowiki/okf";
import type { AdminRepositories, SourceFileRecord } from "../db/admin-repositories.js";

type UpdateSourceFileMetadata = NonNullable<
  NonNullable<AdminRepositories["files"]>["updateSourceFileMetadata"]
>;

export async function processSourceFileMetadataStage(input: {
  knowledgeBaseId: string;
  source: SourceFileRecord;
  content: string;
  updateSourceFileMetadata: UpdateSourceFileMetadata;
}) {
  const parsed = parseUploadedMarkdownSource({
    fileName: input.source.name,
    content: input.content
  });

  await input.updateSourceFileMetadata({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    metadata: parsed.metadata
  });

  const resolved = resolveSourceMetadata({
    fileName: input.source.name,
    content: input.content,
    metadata: parsed.metadata
  });

  return {
    content: input.content,
    parsed,
    resolved
  };
}
