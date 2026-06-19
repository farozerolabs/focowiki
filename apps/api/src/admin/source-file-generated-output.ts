import type {
  AdminRepositories,
  GeneratedSourceFileOutputRecord,
  KnowledgeBaseRecord,
  SourceFileRecord
} from "../db/admin-repositories.js";

export async function readGeneratedOutputsForSourceFiles(input: {
  repositories: AdminRepositories;
  knowledgeBase: KnowledgeBaseRecord;
  sourceFiles: SourceFileRecord[];
}): Promise<Map<string, GeneratedSourceFileOutputRecord>> {
  if (
    !input.knowledgeBase.activeReleaseId ||
    !input.repositories.files?.listGeneratedOutputsForSourceFiles ||
    input.sourceFiles.length === 0
  ) {
    return new Map();
  }

  const outputs = await input.repositories.files.listGeneratedOutputsForSourceFiles({
    knowledgeBaseId: input.knowledgeBase.id,
    releaseId: input.knowledgeBase.activeReleaseId,
    sourceFileIds: input.sourceFiles.map((file) => file.id)
  });

  return new Map(outputs.map((output) => [output.sourceFileId, output]));
}
