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
  const activeReleaseId = input.knowledgeBase.activeReleaseId;
  const fileRepository = input.repositories.files;
  const visibleSourceFiles = input.sourceFiles.filter(
    (file) => file.generatedOutputStatus === "visible"
  );

  if (!activeReleaseId || visibleSourceFiles.length === 0) {
    return new Map();
  }

  if (fileRepository?.listGeneratedOutputsForSourceFiles) {
    const outputs = await fileRepository.listGeneratedOutputsForSourceFiles({
      knowledgeBaseId: input.knowledgeBase.id,
      releaseId: activeReleaseId,
      sourceFileIds: visibleSourceFiles.map((file) => file.id)
    });

    return new Map(outputs.map((output) => [output.sourceFileId, output]));
  }

  if (!fileRepository?.getBundleFile) {
    return new Map();
  }

  const outputs = await Promise.all(
    visibleSourceFiles.map(async (file) => {
      if (!file.generatedBundleFilePath) {
        return null;
      }

      const bundleFile = await fileRepository.getBundleFile({
        knowledgeBaseId: input.knowledgeBase.id,
        releaseId: activeReleaseId,
        logicalPath: file.generatedBundleFilePath
      });

      if (!bundleFile || bundleFile.sourceFileId !== file.id || bundleFile.fileKind !== "page") {
        return null;
      }

      return {
        sourceFileId: file.id,
        bundleFileId: bundleFile.id,
        logicalPath: bundleFile.logicalPath
      };
    })
  );

  return new Map(
    outputs.flatMap((output) => (output ? [[output.sourceFileId, output] as const] : []))
  );
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
