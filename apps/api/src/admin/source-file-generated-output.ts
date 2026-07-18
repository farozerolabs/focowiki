import type {
  GeneratedSourceFileOutputRecord,
  SourceFileRecord
} from "../application/ports/source-file-repository.js";
import type { ActiveGenerationReadRepository } from "../application/ports/active-generation-read-repository.js";
import { readNonCritical } from "../read-safeguards.js";

export async function readGeneratedOutputsForSourceFiles(input: {
  activeGenerationReads: ActiveGenerationReadRepository | null;
  knowledgeBaseId: string;
  sourceFiles: SourceFileRecord[];
}): Promise<Map<string, GeneratedSourceFileOutputRecord>> {
  const visibleSourceFiles = input.sourceFiles.filter(
    (file) => file.generatedOutputStatus === "visible"
  );

  if (visibleSourceFiles.length === 0) {
    return new Map();
  }
  if (!input.activeGenerationReads) return new Map();
  const files = await input.activeGenerationReads.withActiveGeneration(
    input.knowledgeBaseId,
    (scope) => scope.findFilesBySourceIds(visibleSourceFiles.map((file) => file.id))
  );
  return new Map((files ?? []).flatMap((file) => file.sourceFileId
    ? [[file.sourceFileId, {
        sourceFileId: file.sourceFileId,
        fileId: file.fileId,
        logicalPath: file.path
      }] as const]
    : []));
}

export async function readGeneratedOutputsForSourceFilesSafely(input: {
  activeGenerationReads: ActiveGenerationReadRepository | null;
  knowledgeBaseId: string;
  sourceFiles: SourceFileRecord[];
}): Promise<Map<string, GeneratedSourceFileOutputRecord>> {
  return readNonCritical({
    timeoutMs: 250,
    fallback: new Map<string, GeneratedSourceFileOutputRecord>(),
    operation: () => readGeneratedOutputsForSourceFiles(input)
  });
}
