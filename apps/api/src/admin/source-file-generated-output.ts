import type {
  AdminRepositories,
  GeneratedSourceFileOutputRecord,
  KnowledgeBaseRecord,
  SourceFileRecord
} from "../db/admin-repositories.js";
import { readNonCritical } from "../read-safeguards.js";

export async function readGeneratedOutputsForSourceFiles(input: {
  repositories: AdminRepositories;
  knowledgeBase: KnowledgeBaseRecord;
  sourceFiles: SourceFileRecord[];
}): Promise<Map<string, GeneratedSourceFileOutputRecord>> {
  const outputs = input.sourceFiles.flatMap((file) => {
    if (!file.generatedBundleFileId || !file.generatedBundleFilePath) {
      return [];
    }

    return [{
      sourceFileId: file.id,
      bundleFileId: file.generatedBundleFileId,
      logicalPath: file.generatedBundleFilePath
    }];
  });

  return new Map(outputs.map((output) => [output.sourceFileId, output]));
}

export async function readGeneratedOutputsForSourceFilesSafely(input: {
  repositories: AdminRepositories;
  knowledgeBase: KnowledgeBaseRecord;
  sourceFiles: SourceFileRecord[];
}): Promise<Map<string, GeneratedSourceFileOutputRecord>> {
  return readNonCritical({
    timeoutMs: 250,
    fallback: new Map<string, GeneratedSourceFileOutputRecord>(),
    operation: () => readGeneratedOutputsForSourceFiles(input)
  });
}
